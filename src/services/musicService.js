const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const { PermissionFlagsBits } = require('discord.js');
const { KazagumoTrack } = require('kazagumo');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const fs = require('node:fs');
const ffmpegPath = require('ffmpeg-static');
const {
  cancelLavalinkPlaybackConfirmation,
  getKazagumo,
  waitForLavalinkPlaybackConfirmation,
} = require('./lavalinkService');
const { getGuildConfig } = require('../utils/guildConfig');
const logger = require('../utils/logger');
const {
  YouTubeLocalSourceError,
  extractStrictYouTubeVideoId,
  loadAnonymousYouTubeAudio,
} = require('./youtubeLocalSource');

const youtubeUrlPattern = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?[^\s<>()]*v=|youtube\.com\/shorts\/|youtu\.be\/)[^\s<>()]+/i;
const musicIdleLeaveMs = 3 * 60 * 1000;
const testToneDurationSeconds = 5;
const testToneFrequencyHz = 880;
const youtubeFallbackStartupTimeoutMs = 15_000;
const youtubeFallbackMinimumPlaybackMs = 1_000;
const youtubeFallbackMinimumOutputBytes = 4_096;

// Local fallback state (used only for /music test now)
const guildLocalMusicStates = new Map();
const lavalinkIdleTimers = new Map();
const guildPlaybackOperationTails = new Map();

class MusicUserError extends Error {
  constructor(message, code = 'music_user_error') {
    super(message);
    this.name = 'MusicUserError';
    this.code = code;
  }
}

function extractYouTubeUrl(content) {
  const match = String(content || '').match(youtubeUrlPattern);
  if (!match) return null;
  const candidate = match[0].replace(/[.,!?，。！？]+$/u, '');
  return isYouTubeUrl(candidate) ? candidate : null;
}

function isYouTubeUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    let videoId = null;

    if (host === 'youtu.be') {
      videoId = parsed.pathname.split('/').filter(Boolean)[0];
    } else if (host === 'youtube.com' && parsed.pathname === '/watch') {
      videoId = parsed.searchParams.get('v');
    } else if (host === 'youtube.com' && parsed.pathname.startsWith('/shorts/')) {
      videoId = parsed.pathname.split('/').filter(Boolean)[1];
    }

    return /^[-_A-Za-z0-9]{6,20}$/.test(videoId || '');
  } catch {
    return false;
  }
}

function buildLavalinkTrackUserData(requestedBy, playbackRequestId = randomUUID()) {
  const requesterId = String(requestedBy || '').trim();
  const normalizedPlaybackRequestId = String(playbackRequestId || '').trim();
  if (!requesterId) {
    throw new MusicUserError('無法辨識點歌者，已停止送出 Lavalink 播放請求。', 'lavalink_requester_invalid');
  }
  if (!normalizedPlaybackRequestId) {
    throw new MusicUserError('無法建立播放請求識別，已停止送出 Lavalink 播放請求。', 'lavalink_request_invalid');
  }

  return { requesterId, playbackRequestId: normalizedPlaybackRequestId };
}

function getLavalinkLoadErrorSummary(data) {
  const parts = [data?.message, data?.cause, data?.severity ? `severity=${data.severity}` : null]
    .filter(Boolean)
    .map((part) => String(part).replace(/\s+/g, ' ').trim());

  return parts.join(' | ').slice(0, 300) || 'Lavalink 未提供錯誤摘要';
}

function normalizeLavalinkLoadResult(result, requester) {
  const loadType = String(result?.loadType || '').toLowerCase();
  let playlistName;
  let rawTracks;
  let type;

  if (loadType === 'error') {
    throw new MusicUserError(
      `YouTube 來源載入失敗：${getLavalinkLoadErrorSummary(result.data)}`,
      'youtube_source_failed'
    );
  }

  if (loadType === 'empty') {
    return { playlistName: undefined, tracks: [], type: 'SEARCH' };
  }

  if (loadType === 'track') {
    rawTracks = result?.data ? [result.data] : [];
    type = 'TRACK';
  } else if (loadType === 'playlist') {
    playlistName = result?.data?.info?.name;
    rawTracks = Array.isArray(result?.data?.tracks) ? result.data.tracks : [];
    type = 'PLAYLIST';
  } else if (loadType === 'search') {
    rawTracks = Array.isArray(result?.data) ? result.data : [];
    type = 'SEARCH';
  } else {
    throw new MusicUserError(`Lavalink 回傳未知的載入類型：${loadType || 'missing'}`, 'lavalink_load_protocol_error');
  }

  return {
    playlistName,
    tracks: rawTracks.map((rawTrack) => new KazagumoTrack(rawTrack, requester)),
    type,
  };
}

async function resolveLavalinkSearch(kazagumo, input, requester) {
  let node;

  try {
    node = await kazagumo.getLeastUsedNode();
  } catch {
    throw new MusicUserError('目前沒有可用的 Lavalink 節點，請稍後再試。', 'lavalink_unavailable');
  }

  if (!node) {
    throw new MusicUserError('目前沒有可用的 Lavalink 節點，請稍後再試。', 'lavalink_unavailable');
  }

  const identifier = /^https?:\/\//i.test(input) ? input : `ytsearch:${input}`;
  let result;

  try {
    result = await node.rest.resolve(identifier);
  } catch (error) {
    throw new MusicUserError(`Lavalink 載入請求失敗：${getBriefMusicError(error)}`, 'lavalink_load_request_failed');
  }

  return normalizeLavalinkLoadResult(result, requester);
}

function getBriefMusicError(error) {
  return String(error?.message || error || '未知錯誤').replace(/\s+/g, ' ').slice(0, 180);
}

function getRestErrorDiagnostics(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name || 'unknown',
    statusCode: error.status ?? error.statusCode ?? null,
    error: error.error || null,
    message: getBriefMusicError(error),
    path: error.path || null,
  };
}

function getTrackDiagnostics(track) {
  if (!track) {
    return {
      title: null,
      identifier: null,
      uri: null,
      encodedTrackPresent: false,
      sourceName: null,
      isSeekable: null,
      length: null,
    };
  }

  return {
    title: track.title || null,
    identifier: track.identifier || null,
    uri: track.uri || null,
    encodedTrackPresent: Boolean(track.track || track.raw?.encoded),
    sourceName: track.sourceName || track.raw?.info?.sourceName || null,
    isSeekable: track.isSeekable ?? track.raw?.info?.isSeekable ?? null,
    length: track.length ?? track.raw?.info?.length ?? null,
  };
}

function getLavalinkPlaybackSnapshot({ player, connection, track, queueLengthOverride = null }) {
  return {
    track: getTrackDiagnostics(track || player?.queue?.current),
    player: {
      state: player?.state ?? null,
      voiceId: player?.voiceId || null,
      textId: player?.textId || null,
      playing: Boolean(player?.playing),
      paused: Boolean(player?.paused),
      position: player?.position ?? player?.shoukaku?.position ?? null,
      queueLength: queueLengthOverride ?? player?.queue?.length ?? null,
      currentTrackTitle: player?.queue?.current?.title || null,
      volume: player?.volume ?? null,
    },
    connection: {
      state: connection?.state ?? null,
      channelId: connection?.channelId || null,
      sessionIdPresent: Boolean(connection?.sessionId),
      serverUpdatePresent: Boolean(connection?.serverUpdate),
      endpointPresent: Boolean(connection?.serverUpdate?.endpoint),
      tokenPresent: Boolean(connection?.serverUpdate?.token),
    },
    node: {
      name: player?.node?.name || player?.shoukaku?.node?.name || null,
      state: player?.node?.state ?? player?.shoukaku?.node?.state ?? null,
      sessionIdPresent: Boolean(player?.node?.sessionId || player?.shoukaku?.node?.sessionId),
    },
  };
}

function logPlaybackSnapshot(level, message, snapshot, extra = {}) {
  const line = `[Music] ${message}: ${JSON.stringify({ ...snapshot, ...extra })}`;

  if (level === 'error') {
    logger.error(line);
    return;
  }

  if (level === 'warn') {
    logger.warn(line);
    return;
  }

  logger.info(line);
}

function getMusicErrorLayer(error) {
  const code = String(error?.code ?? '');

  if (
    [
      'user_not_in_voice',
      'bot_member_missing',
      'bot_in_other_voice',
      'missing_view_channel',
      'missing_connect',
      'missing_speak',
      'voice_channel_full',
      'voice_connect_failed',
    ].includes(code)
  ) {
    return 'voice';
  }

  if (code.startsWith('ffmpeg_')) {
    return 'ffmpeg';
  }
  
  if (code.startsWith('lavalink_')) {
      return 'lavalink';
  }

  if (code.startsWith('player_')) {
    return 'player';
  }

  if (code.startsWith('queue_')) {
    return 'queue';
  }

  if (code.startsWith('youtube_')) {
    return 'source';
  }

  return 'unknown';
}

function getMusicUserFacingError(error) {
  const layer = getMusicErrorLayer(error);
  const message = getBriefMusicError(error);

  if (layer === 'lavalink') {
      return `目前缺少可用的 Lavalink 音樂節點。\n請在 .env 檔案中設定 \`LAVALINK_HOST\`, \`LAVALINK_PORT\`, \`LAVALINK_PASSWORD\` 等環境變數，或確認節點是否上線。\n（注意：小吉本體及 Discord 語音權限皆正常，此為節點伺服器問題）`;
  }

  if (layer === 'voice') {
    return `語音房連線失敗：${message}`;
  }

  if (layer === 'ffmpeg') {
    return `ffmpeg 測試音失敗：${message}`;
  }

  if (layer === 'player') {
    return `Discord audio player 失敗：${message}`;
  }

  if (layer === 'source') {
    return 'YouTube 來源目前拒絕或無法載入這部影片，請稍後再試或改用其他公開影片。';
  }

  return message;
}

function getMissingVoicePermissions(voiceChannel) {
  const botMember = voiceChannel.guild.members.me;
  const permissions = botMember ? voiceChannel.permissionsFor(botMember) : null;
  const missing = [];

  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
    missing.push('ViewChannel');
  }

  if (!permissions?.has(PermissionFlagsBits.Connect)) {
    missing.push('Connect');
  }

  if (!permissions?.has(PermissionFlagsBits.Speak)) {
    missing.push('Speak');
  }

  return missing;
}

function isVoiceChannelFullForBot(voiceChannel) {
  const userLimit = voiceChannel.userLimit || 0;

  if (!userLimit) {
    return false;
  }

  if (voiceChannel.members?.has?.(voiceChannel.guild.members.me?.id)) {
    return false;
  }

  return (voiceChannel.members?.size || 0) >= userLimit;
}

function validateVoiceChannelForPlayback(voiceChannel, { commandName = '/music play' } = {}) {
  if (!voiceChannel) {
    throw new MusicUserError(`請先加入語音頻道，再使用 ${commandName}。`, 'user_not_in_voice');
  }

  if (!voiceChannel.guild?.members?.me) {
    throw new MusicUserError('小吉目前無法確認自己的語音權限，請稍後再試。', 'bot_member_missing');
  }
  
  // Check local connection
  const activeConnection = getVoiceConnection(voiceChannel.guild.id);
  if (activeConnection && activeConnection.joinConfig.channelId !== voiceChannel.id) {
    throw new MusicUserError('小吉已經在其他語音頻道，請先使用 /music leave 讓我離開後再播放。', 'bot_in_other_voice');
  }
  
  // Check Lavalink connection if initialized
  try {
      const kazagumo = getKazagumo();
      const activePlayer = kazagumo.players.get(voiceChannel.guild.id);
      if (activePlayer && activePlayer.voiceId !== voiceChannel.id) {
          throw new MusicUserError('小吉已經在其他語音頻道，請先使用 /music leave 讓我離開後再播放。', 'bot_in_other_voice');
      }
  } catch (e) {
      // It's okay if kazagumo isn't fully ready here, we fallback to local checks
  }

  const missingPermissions = getMissingVoicePermissions(voiceChannel);

  if (missingPermissions.includes('ViewChannel')) {
    throw new MusicUserError('小吉看不到這個語音頻道，請確認我有 View Channel 權限。', 'missing_view_channel');
  }

  if (missingPermissions.includes('Connect')) {
    throw new MusicUserError('小吉缺少 Connect 權限，無法加入你的語音頻道。', 'missing_connect');
  }

  if (missingPermissions.includes('Speak')) {
    throw new MusicUserError('小吉缺少 Speak 權限，就算加入語音頻道也無法播放音樂。', 'missing_speak');
  }

  if (isVoiceChannelFullForBot(voiceChannel)) {
    throw new MusicUserError('這個語音頻道已滿，小吉無法加入。', 'voice_channel_full');
  }

  return true;
}

// Local Player State Management (Mainly for /music test)
function cancelIdleDisconnect(state) {
  if (state && state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function cancelLavalinkIdleDisconnect(guildId) {
  const timer = lavalinkIdleTimers.get(guildId);
  if (timer) clearTimeout(timer);
  lavalinkIdleTimers.delete(guildId);
}

function parseBooleanEnv(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function getVoiceStayPolicy(guildId, { config = null, env = process.env } = {}) {
  const guildConfig = config || (guildId ? getGuildConfig(guildId) : null);
  if (typeof guildConfig?.music?.stayInVoice === 'boolean') {
    return { enabled: guildConfig.music.stayInVoice, source: 'guild-config' };
  }
  return { enabled: parseBooleanEnv(env.MUSIC_STAY_IN_VOICE), source: 'env' };
}

function shouldScheduleIdleDisconnect(state, options = {}) {
  if (!state || state.idleTimer || !state.connection || state.current || state.playing || state.queue.length > 0) {
    return false;
  }
  return !getVoiceStayPolicy(state.guildId, options).enabled;
}

function cleanupCurrentProcess(state) {
  if (state?.currentRuntime) {
    state.currentRuntime.cleanup();
    state.currentRuntime = null;
  }

  if (state && state.currentProcess && !state.currentProcess.killed) {
    state.currentProcess.kill('SIGKILL');
  }

  if (state) state.currentProcess = null;
}

function disconnectMusicState(state) {
  if (!state) return;
  const connection = state.connection;

  cancelIdleDisconnect(state);
  state.queue = [];
  state.current = null;
  state.playing = false;
  state.connection = null;
  cleanupCurrentProcess(state);
  state.player.stop(true);

  try {
    connection?.destroy();
  } catch (error) {
    logger.warn(`Failed to destroy local voice connection in guild ${state.guildId}: ${error?.message || error}`);
  }
}

function destroyLocalVoiceConnection(guildId, reason = 'switching to Lavalink') {
  let destroyed = false;
  const state = guildLocalMusicStates.get(guildId);

  if (state && state.connection) {
    disconnectMusicState(state);
    destroyed = true;
  }

  const activeConnection = getVoiceConnection(guildId);
  if (activeConnection) {
    try {
      activeConnection.destroy();
      destroyed = true;
    } catch (error) {
      logger.warn(`Failed to destroy stray local voice connection in guild ${guildId}: ${error?.message || error}`);
    }
  }

  if (destroyed) {
    logger.info(`[Music] Destroyed local @discordjs/voice connection in guild ${guildId}: ${reason}`);
  }

  return destroyed;
}

function scheduleIdleDisconnect(state) {
  if (!shouldScheduleIdleDisconnect(state)) {
    cancelIdleDisconnect(state);
    return;
  }

  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;

    if (!shouldScheduleIdleDisconnect({ ...state, idleTimer: null })) {
      return;
    }

    const textChannel = state.textChannel;
    disconnectMusicState(state);

    if (textChannel?.send) {
      void textChannel
        .send({
          content: '語音頻道閒置 3 分鐘，小吉已自動離開。',
          allowedMentions: { parse: [] },
        })
        .catch((error) => logger.warn(`Failed to send music idle message: ${error?.message || error}`));
    }
  }, musicIdleLeaveMs);

  state.idleTimer.unref?.();
}

function scheduleLavalinkIdleDisconnect(player, client = null) {
  if (!player?.guildId || lavalinkIdleTimers.has(player.guildId)) return;
  if (getVoiceStayPolicy(player.guildId).enabled) {
    cancelLavalinkIdleDisconnect(player.guildId);
    return;
  }

  const timer = setTimeout(async () => {
    lavalinkIdleTimers.delete(player.guildId);
    let currentPlayer = null;
    try {
      currentPlayer = getKazagumo().players.get(player.guildId) || null;
    } catch {
      return;
    }

    if (
      !currentPlayer ||
      getVoiceStayPolicy(player.guildId).enabled ||
      currentPlayer.playing ||
      currentPlayer.paused ||
      currentPlayer.queue?.length > 0
    ) {
      return;
    }

    const textId = currentPlayer.textId;
    await currentPlayer.destroy().catch((error) =>
      logger.warn(`Failed to destroy idle Lavalink player in guild ${player.guildId}: ${error?.message || error}`)
    );
    const textChannel = client?.channels?.cache?.get?.(textId);
    if (textChannel?.send) {
      await textChannel.send({
        content: '語音頻道閒置 3 分鐘，小吉已自動離開。',
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
    }
  }, musicIdleLeaveMs);
  timer.unref?.();
  lavalinkIdleTimers.set(player.guildId, timer);
}

function applyVoiceStayPolicy(guildId) {
  const policy = getVoiceStayPolicy(guildId);
  const localState = guildLocalMusicStates.get(guildId);
  let lavalinkPlayer = null;
  try {
    lavalinkPlayer = getKazagumo().players.get(guildId) || null;
  } catch {
    // No Lavalink runtime.
  }

  if (policy.enabled) {
    cancelIdleDisconnect(localState);
    cancelLavalinkIdleDisconnect(guildId);
  } else {
    scheduleIdleDisconnect(localState);
    if (lavalinkPlayer && !lavalinkPlayer.playing && !lavalinkPlayer.paused && lavalinkPlayer.queue?.length === 0) {
      scheduleLavalinkIdleDisconnect(lavalinkPlayer);
    }
  }
  return getVoiceStayStatus(guildId);
}

function getLocalMusicState(guildId) {
  if (!guildLocalMusicStates.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });
    const state = {
      guildId,
      player,
      connection: null,
      queue: [],
      current: null,
      currentProcess: null,
      currentRuntime: null,
      idleTimer: null,
      textChannel: null,
      playing: false,
    };

    player.on(AudioPlayerStatus.Idle, () => {
      cleanupCurrentProcess(state);
      state.current = null;
      state.playing = false;
      // Local fallback queue no longer auto-plays next as we primarily use Lavalink
      scheduleIdleDisconnect(state);
    });

    player.on('error', (error) => {
      logger.warn(`Local Music player error in guild ${guildId}: ${error?.message || error}`);
      cleanupCurrentProcess(state);
      state.current = null;
      state.playing = false;
      scheduleIdleDisconnect(state);
    });

    guildLocalMusicStates.set(guildId, state);
  }

  return guildLocalMusicStates.get(guildId);
}

// Local voice connection (fallback for test tone or when Lavalink is fully disabled)
async function connectToLocalVoice(voiceChannel) {
  const existingConnection = getVoiceConnection(voiceChannel.guild.id);

  if (existingConnection) {
    if (existingConnection.joinConfig.channelId !== voiceChannel.id) {
      existingConnection.destroy();
    } else {
      try {
        await entersState(existingConnection, VoiceConnectionStatus.Ready, 20_000);
      } catch (error) {
        throw new MusicUserError(`既有語音連線尚未就緒：${getBriefMusicError(error)}`, 'voice_connect_failed');
      }
      return existingConnection;
    }
  }

  // validateVoiceChannelForPlayback was already called by joinMusicVoiceChannel

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  connection.on('error', (error) => {
    logger.warn(`Local Voice connection error in guild ${voiceChannel.guild.id}: ${error?.message || error}`);
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    logger.warn(`Local Voice connection disconnected in guild ${voiceChannel.guild.id}.`);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    try {
      connection.destroy();
    } catch (destroyError) {
      logger.warn(`Failed to destroy failed local voice connection: ${destroyError?.message || destroyError}`);
    }

    throw new MusicUserError(`小吉加入語音頻道逾時或失敗：${getBriefMusicError(error)}`, 'voice_connect_failed');
  }

  return connection;
}

// Lavalink Main Functions
async function joinMusicVoiceChannel({ guild, voiceChannel, textChannel = null }) {
  validateVoiceChannelForPlayback(voiceChannel, { commandName: '/music join' });

  // Disconnect Lavalink if it's there to let local connection take over the join check
  try {
      const kazagumo = getKazagumo();
      const player = kazagumo.players.get(guild.id);
      if (player) {
          await player.destroy();
      }
  } catch(e) {}

  const state = getLocalMusicState(guild.id);
  state.textChannel = textChannel || state.textChannel;
  state.connection = await connectToLocalVoice(voiceChannel);
  state.connection.subscribe(state.player);
  scheduleIdleDisconnect(state);
  
  return {
      channelId: voiceChannel.id,
      channelName: voiceChannel.name || '語音頻道',
      reused: state.connection.joinConfig.channelId === voiceChannel.id,
  };
}

async function runExclusiveGuildPlaybackOperation(guildId, operation) {
  const normalizedGuildId = String(guildId || '').trim();
  if (!normalizedGuildId || typeof operation !== 'function') {
    throw new TypeError('Guild playback operation requires a guildId and callback');
  }

  const previous = guildPlaybackOperationTails.get(normalizedGuildId) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  guildPlaybackOperationTails.set(normalizedGuildId, current);

  await previous.catch(() => {});

  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (guildPlaybackOperationTails.get(normalizedGuildId) === current) {
      guildPlaybackOperationTails.delete(normalizedGuildId);
    }
  }
}

function getGuildPlaybackOperationCount() {
  return guildPlaybackOperationTails.size;
}

async function enqueueTrackUnlocked({ guild, voiceChannel, textChannel, url, requestedBy }) {
  const input = String(url || '').trim();
  if (/^https?:\/\//i.test(input) && !isYouTubeUrl(input)) {
      throw new MusicUserError('目前只支援 YouTube watch、Shorts 或 youtu.be 影片連結。', 'unsupported_music_url');
  }
  validateVoiceChannelForPlayback(voiceChannel);
  
  let kazagumo;
  try {
      kazagumo = getKazagumo();
      if (!kazagumo.shoukaku.nodes.size) {
          throw new Error('No nodes online');
      }
  } catch (error) {
      throw new MusicUserError('音樂服務尚未初始化或節點離線中，請稍後再試。', 'lavalink_unavailable');
  }

  destroyLocalVoiceConnection(guild.id, 'before Lavalink playback');

  let player = kazagumo.players.get(guild.id);
  let connection = kazagumo.shoukaku.connections.get(guild.id);

  if (player && (!connection || connection.channelId !== voiceChannel.id)) {
      logger.warn(
          `[Music] Existing Lavalink player has invalid voice connection in guild ${guild.id}: playerVoiceId=${player.voiceId || 'none'} connectionChannelId=${connection?.channelId || 'none'} requestedVoiceId=${voiceChannel.id}. Recreating player.`
      );
      try {
          await player.destroy();
      } catch (error) {
          logger.warn(`[Music] Failed to destroy stale Lavalink player in guild ${guild.id}: ${error?.message || error}`);
      }
      player = null;
      connection = null;
  }

  if (!player) {
      try {
          const shardId = typeof guild.shardId === 'number' ? guild.shardId : 0;
          player = await kazagumo.createPlayer({
              guildId: guild.id,
              textId: textChannel.id,
              voiceId: voiceChannel.id,
              volume: 100,
              deaf: true,
              shardId,
          });
          logger.info(
              `[Music] Created Kazagumo player guildId=${guild.id} voiceId=${voiceChannel.id} textId=${textChannel.id} shardId=${shardId} state=${player.state}`
          );
      } catch (error) {
           throw new MusicUserError(`無法建立音訊播放器：${getBriefMusicError(error)}`, 'lavalink_player_failed');
      }
  } else {
      if (player.textId !== textChannel.id && typeof player.setTextChannel === 'function') {
          player.setTextChannel(textChannel.id);
      }

      if (player.voiceId !== voiceChannel.id && typeof player.setVoiceChannel === 'function') {
          player.setVoiceChannel(voiceChannel.id);
      }
  }

  // Clear local state idle timer if lavalink is active
  cancelIdleDisconnect(getLocalMusicState(guild.id));
  cancelLavalinkIdleDisconnect(guild.id);

  const requester = buildLavalinkTrackUserData(requestedBy);
  const result = await resolveLavalinkSearch(kazagumo, input, requester);

  if (!result.tracks.length) {
      throw new MusicUserError('找不到可播放的結果。', 'youtube_parse_failed');
  }

  const track = result.tracks[0];
  const started = !player.playing && !player.paused;
  let playbackConfirmed = false;

  if (result.type === "PLAYLIST" && !started) {
      player.queue.add(result.tracks);
  } else if (!started) {
      player.queue.add(track);
  }

  connection = kazagumo.shoukaku.connections.get(guild.id);
  logPlaybackSnapshot(
      'info',
      'Prepared Lavalink playback',
      getLavalinkPlaybackSnapshot({
          player,
          connection,
          track,
          queueLengthOverride: player.queue.length,
      }),
      {
          guildId: guild.id,
          input: isYouTubeUrl(url) ? 'youtube_url' : 'search',
          loadType: result.type,
          willStartNow: started,
      }
  );
  
  if (started) {
      const playbackConfirmationPromise = waitForLavalinkPlaybackConfirmation(guild.id, {
          requestId: requester.playbackRequestId,
          encodedTrack: track.track,
      });

      try {
          await player.play(track, { replaceCurrent: true });
          if (result.type === "PLAYLIST" && result.tracks.length > 1) {
              player.queue.add(result.tracks.slice(1));
          }
      } catch (error) {
          cancelLavalinkPlaybackConfirmation(guild.id, requester.playbackRequestId);
          logPlaybackSnapshot(
              'error',
              'Lavalink playTrack REST request failed',
              getLavalinkPlaybackSnapshot({
                  player,
                  connection: kazagumo.shoukaku.connections.get(guild.id),
                  track,
                  queueLengthOverride: player.queue.length,
              }),
              {
                  guildId: guild.id,
                  restError: getRestErrorDiagnostics(error),
              }
          );
          throw new MusicUserError(`Lavalink 接收播放請求失敗：${getBriefMusicError(error)}`, 'lavalink_play_failed');
      }

      const playbackOutcome = await playbackConfirmationPromise;
      playbackConfirmed = Boolean(playbackOutcome.confirmed);

      if (!playbackConfirmed) {
          logPlaybackSnapshot(
              'warn',
              playbackOutcome.failed
                  ? 'Lavalink playback failed before sustained audio was confirmed'
                  : 'Lavalink did not confirm sustained audio before timeout',
              getLavalinkPlaybackSnapshot({
                  player,
                  connection: kazagumo.shoukaku.connections.get(guild.id),
                  track,
                  queueLengthOverride: player.queue.length,
              }),
              {
                  guildId: guild.id,
                  voiceId: voiceChannel.id,
                  textId: textChannel.id,
                  input: isYouTubeUrl(url) ? 'youtube_url' : 'search',
                  outcomeEventType: playbackOutcome.eventType || 'timeout',
                  suggestion: isYouTubeUrl(url)
                      ? 'Try a credential-free client fallback or move Lavalink to a clean egress IP.'
                      : 'Try a normal YouTube URL to distinguish search result issues from node source issues.',
              }
          );

          throw new MusicUserError(
              playbackOutcome.failed
                  ? 'YouTube 來源在音訊穩定前中止播放。'
                  : '無法確認 Lavalink 正在持續輸出音訊。',
              playbackOutcome.failed ? 'youtube_stream_failed' : 'youtube_stream_unconfirmed'
          );
      } else {
          logger.info(
              `[Music] Sustained playback confirmed by ${playbackOutcome.eventType}: guildId=${guild.id} voiceId=${voiceChannel.id} textId=${textChannel.id} track=${track.title} position=${playbackOutcome.position}`
          );
      }
  }

  return {
    track: {
        title: result.type === "PLAYLIST" ? `播放清單：${result.playlistName}` : track.title,
        url: track.uri,
    },
    position: player.queue.length,
    started: started && playbackConfirmed,
  };
}

async function enqueueTrack(options) {
  return runExclusiveGuildPlaybackOperation(options?.guild?.id, async () => {
    const existingLocalState = guildLocalMusicStates.get(options?.guild?.id);
    if (existingLocalState?.current?.source === 'youtube-local' && existingLocalState.playing) {
      throw new MusicUserError('本機 YouTube 音訊仍在播放，請先停止後再點播。', 'queue_busy');
    }

    try {
      return await enqueueTrackUnlocked(options);
    } catch (error) {
      if (!shouldUseLocalYouTubeFallback(error, options?.url)) throw error;
      return playLocalYouTubeFallback(options);
    }
  });
}

function shouldUseLocalYouTubeFallback(error, input) {
  return (
    ['youtube_source_failed', 'youtube_stream_failed'].includes(String(error?.code || '')) &&
    Boolean(extractStrictYouTubeVideoId(input))
  );
}

function buildFfmpegYoutubeFallbackArgs() {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    'pipe:0',
    '-vn',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-c:a',
    'libopus',
    '-f',
    'ogg',
    'pipe:1',
  ];
}

function createYoutubeFallbackRuntime(webStream, { spawnImpl = spawn, readableFromWeb = Readable.fromWeb } = {}) {
  if (!ffmpegPath) throw new YouTubeLocalSourceError('youtube_local_ffmpeg_missing');
  if (!webStream || typeof readableFromWeb !== 'function') {
    throw new YouTubeLocalSourceError('youtube_local_stream_invalid');
  }

  const sourceStream = readableFromWeb(webStream);
  const activity = { inputBytes: 0, outputBytes: 0 };
  const inputMonitor = new Transform({
    transform(chunk, encoding, callback) {
      activity.inputBytes += Buffer.byteLength(chunk);
      callback(null, chunk);
    },
  });
  const outputMonitor = new Transform({
    transform(chunk, encoding, callback) {
      activity.outputBytes += Buffer.byteLength(chunk);
      callback(null, chunk);
    },
  });
  const subprocess = spawnImpl(ffmpegPath, buildFfmpegYoutubeFallbackArgs(), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (!subprocess.stdin || !subprocess.stdout) {
    sourceStream.destroy();
    subprocess.kill?.('SIGKILL');
    throw new YouTubeLocalSourceError('youtube_local_ffmpeg_stream_failed');
  }

  let cleaned = false;
  let stderr = '';
  const onStderrData = (chunk) => {
    stderr = `${stderr}\n${String(chunk)}`.trim().slice(-500);
  };
  subprocess.stderr?.on('data', onStderrData);
  subprocess.stdin.on('error', () => {});
  sourceStream.pipe(inputMonitor).pipe(subprocess.stdin);
  subprocess.stdout.pipe(outputMonitor);

  const runtime = {
    activity,
    get cleaned() {
      return cleaned;
    },
    get stderrPresent() {
      return Boolean(stderr);
    },
    inputMonitor,
    outputStream: outputMonitor,
    sourceStream,
    subprocess,
    guardCleanup: null,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      runtime.guardCleanup?.();
      runtime.guardCleanup = null;
      subprocess.stderr?.off('data', onStderrData);
      sourceStream.unpipe(inputMonitor);
      inputMonitor.unpipe(subprocess.stdin);
      subprocess.stdout?.unpipe(outputMonitor);
      sourceStream.destroy();
      inputMonitor.destroy();
      outputMonitor.destroy();
      subprocess.stdin?.destroy();
      subprocess.stdout?.destroy();
      subprocess.stderr?.destroy();
      if (!subprocess.killed) subprocess.kill('SIGKILL');
    },
  };

  return runtime;
}

function waitForSustainedLocalPlayback(
  state,
  resource,
  runtime,
  {
    timeoutMs = youtubeFallbackStartupTimeoutMs,
    minimumPlaybackMs = youtubeFallbackMinimumPlaybackMs,
    minimumOutputBytes = youtubeFallbackMinimumOutputBytes,
    enterPlaying = () => entersState(state.player, AudioPlayerStatus.Playing, timeoutMs),
  } = {}
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let playing = false;
    const timer = setTimeout(
      () => settle(reject, new YouTubeLocalSourceError('youtube_local_no_audio')),
      timeoutMs
    );
    const interval = setInterval(() => {
      if (
        playing &&
        runtime.activity.inputBytes > 0 &&
        runtime.activity.outputBytes >= minimumOutputBytes &&
        resource.playbackDuration >= minimumPlaybackMs
      ) {
        settle(resolve, {
          inputBytes: runtime.activity.inputBytes,
          outputBytes: runtime.activity.outputBytes,
          playbackDuration: resource.playbackDuration,
        });
      }
    }, 50);

    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(interval);
      state.player.off('error', onPlayerError);
      runtime.sourceStream.off('error', onStreamError);
      runtime.outputStream.off('error', onStreamError);
      runtime.subprocess.off('error', onProcessError);
      runtime.subprocess.off('close', onProcessClose);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = () => settle(reject, new YouTubeLocalSourceError('youtube_local_stream_failed'));
    const onPlayerError = () => fail();
    const onStreamError = () => fail();
    const onProcessError = () => fail();
    const onProcessClose = (code) => {
      if (code !== 0 && !runtime.cleaned) fail();
    };

    state.player.once('error', onPlayerError);
    runtime.sourceStream.once('error', onStreamError);
    runtime.outputStream.once('error', onStreamError);
    runtime.subprocess.once('error', onProcessError);
    runtime.subprocess.once('close', onProcessClose);

    Promise.resolve()
      .then(() => enterPlaying())
      .then(() => {
        playing = true;
      })
      .catch(() => fail());
  });
}

function attachYoutubeFallbackRuntimeGuards(state, runtime) {
  const fail = () => {
    if (runtime.cleaned || state.currentRuntime !== runtime) return;
    logger.warn(`[Music] Local YouTube runtime stopped before completion: guildId=${state.guildId}`);
    cleanupCurrentProcess(state);
    state.current = null;
    state.playing = false;
    state.player.stop(true);
    scheduleIdleDisconnect(state);
  };
  const onProcessClose = (code) => {
    if (code !== 0) fail();
  };

  runtime.sourceStream.once('error', fail);
  runtime.outputStream.once('error', fail);
  runtime.subprocess.once('error', fail);
  runtime.subprocess.once('close', onProcessClose);

  runtime.guardCleanup = () => {
    runtime.sourceStream.off('error', fail);
    runtime.outputStream.off('error', fail);
    runtime.subprocess.off('error', fail);
    runtime.subprocess.off('close', onProcessClose);
  };
}

async function cancelWebStream(webStream) {
  try {
    await webStream?.cancel?.();
  } catch {
    // The stream may already be locked by Readable.fromWeb; runtime cleanup handles it.
  }
}

async function playLocalYouTubeFallback({ guild, voiceChannel, textChannel, url, requestedBy }) {
  validateVoiceChannelForPlayback(voiceChannel);
  let sourceResult;
  let runtime;
  const state = getLocalMusicState(guild.id);

  try {
    sourceResult = await loadAnonymousYouTubeAudio(url);

    const kazagumo = getKazagumo();
    const lavalinkPlayer = kazagumo.players.get(guild.id);
    if (lavalinkPlayer) await lavalinkPlayer.destroy();
    if (kazagumo.players.get(guild.id)) {
      throw new YouTubeLocalSourceError('youtube_local_lavalink_cleanup_failed');
    }

    cancelLavalinkIdleDisconnect(guild.id);
    cancelIdleDisconnect(state);
    state.textChannel = textChannel;
    state.queue = [];

    if (!state.connection || state.connection.joinConfig.channelId !== voiceChannel.id) {
      state.connection = await connectToLocalVoice(voiceChannel);
    }
    state.connection.subscribe(state.player);

    runtime = createYoutubeFallbackRuntime(sourceResult.webStream);
    const track = {
      ...sourceResult.track,
      requestedBy: String(requestedBy || ''),
    };
    const resource = createAudioResource(runtime.outputStream, {
      inputType: StreamType.OggOpus,
      metadata: track,
    });

    state.current = track;
    state.currentProcess = runtime.subprocess;
    state.currentRuntime = runtime;
    state.playing = false;
    attachYoutubeFallbackRuntimeGuards(state, runtime);
    state.player.play(resource);

    const confirmation = await waitForSustainedLocalPlayback(state, resource, runtime);
    state.playing = true;
    logger.info(
      `[Music] Local YouTube fallback confirmed: guildId=${guild.id} playbackMs=${confirmation.playbackDuration} inputBytes=${confirmation.inputBytes} outputBytes=${confirmation.outputBytes}`
    );

    return {
      backend: 'youtube-local',
      position: 0,
      started: true,
      track: { title: track.title },
    };
  } catch (error) {
    if (runtime) runtime.cleanup();
    else await cancelWebStream(sourceResult?.webStream);
    if (state.currentRuntime === runtime) state.currentRuntime = null;
    state.currentProcess = null;
    state.current = null;
    state.playing = false;
    state.player.stop(true);
    if (state.connection) disconnectMusicState(state);
    logger.warn(`[Music] Local YouTube fallback failed closed: guildId=${guild.id}`);
    if (error instanceof YouTubeLocalSourceError) throw error;
    throw new YouTubeLocalSourceError('youtube_local_playback_failed');
  }
}

// Local Ffmpeg functionality specifically for /music test
function buildFfmpegTestToneArgs({ durationSeconds = testToneDurationSeconds, frequencyHz = testToneFrequencyHz } = {}) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequencyHz}:duration=${durationSeconds}`,
    '-ac',
    '2',
    '-ar',
    '48000',
    '-c:a',
    'libopus',
    '-f',
    'ogg',
    'pipe:1',
  ];
}

function createFfmpegTestToneStream() {
  if (!ffmpegPath) {
    throw new MusicUserError('找不到 ffmpeg-static 提供的 ffmpeg 執行檔。', 'ffmpeg_missing');
  }

  const subprocess = spawn(ffmpegPath, buildFfmpegTestToneArgs(), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  subprocess.xiaojiStderr = '';

  subprocess.stderr?.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      subprocess.xiaojiStderr = `${subprocess.xiaojiStderr}\n${message}`.trim().slice(-1000);
      logger.warn(`ffmpeg stderr: ${message}`);
    }
  });

  subprocess.on('error', (error) => {
    logger.warn(`ffmpeg process error: ${error?.message || error}`);
  });

  subprocess.on('close', (code, signal) => {
    if (code && !subprocess.killed) {
      logger.warn(`ffmpeg exited with code ${code}${signal ? ` and signal ${signal}` : ''}`);
    }
  });

  return subprocess;
}

function waitForPlaybackStart(state, subprocess, { sourceName = '音訊來源', failureCode = 'player_not_playing' } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      subprocess.off('error', onProcessError);
      subprocess.off('close', onProcessClose);
    };

    const settle = (fn, value) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      fn(value);
    };

    const onProcessError = (error) => {
      settle(reject, new MusicUserError(`${sourceName} 啟動失敗：${getBriefMusicError(error)}`, failureCode));
    };

    const onProcessClose = (code, signal) => {
      if (code && !subprocess.killed) {
        const stderr = subprocess.xiaojiStderr ? `；${subprocess.xiaojiStderr}` : '';
        const message = `${sourceName} 結束，代碼 ${code}${signal ? `，訊號 ${signal}` : ''}${stderr}`;
        settle(reject, new MusicUserError(message, failureCode));
      }
    };

    subprocess.once('error', onProcessError);
    subprocess.once('close', onProcessClose);

    entersState(state.player, AudioPlayerStatus.Playing, 15_000)
      .then((value) => settle(resolve, value))
      .catch((error) =>
        settle(reject, new MusicUserError(`播放器未進入播放狀態：${getBriefMusicError(error)}`, 'player_not_playing'))
      );
  });
}

async function createTestToneResource() {
  const subprocess = createFfmpegTestToneStream();

  if (!subprocess.stdout) {
    throw new MusicUserError('無法建立 ffmpeg 測試音串流。', 'ffmpeg_stream_failed');
  }

  const track = {
    url: 'xiaoji:test-tone',
    title: '小吉音樂系統測試音',
    duration: testToneDurationSeconds,
    requestedBy: null,
  };
  const resource = createAudioResource(subprocess.stdout, {
    inputType: StreamType.OggOpus,
    metadata: track,
  });

  return { resource, subprocess, track };
}

async function playTestTone({ guild, voiceChannel, textChannel }) {
  // Ensure Lavalink leaves before local takes over
  let kazagumo;
  try {
      kazagumo = getKazagumo();
      const player = kazagumo.players.get(guild.id);
      if (player) {
          await player.destroy();
      }
  } catch (e) {
      // Ignore
  }

  const state = getLocalMusicState(guild.id);
  cancelIdleDisconnect(state);
  validateVoiceChannelForPlayback(voiceChannel, { commandName: '/music test' });

  if (state.current || state.playing || state.queue.length > 0) {
    throw new MusicUserError('目前正在播放或佇列中仍有歌曲，請先使用 /music stop 再執行 /music test。', 'queue_busy');
  }

  state.textChannel = textChannel;

  if (!state.connection || state.connection.joinConfig.channelId !== voiceChannel.id) {
    state.connection = await connectToLocalVoice(voiceChannel);
  }

  state.connection.subscribe(state.player);

  const { resource, subprocess, track } = await createTestToneResource();
  state.current = track;
  state.playing = true;
  state.currentProcess = subprocess;

  try {
    state.player.play(resource);
    await waitForPlaybackStart(state, subprocess, {
      sourceName: 'ffmpeg',
      failureCode: 'ffmpeg_test_failed',
    });
  } catch (error) {
    cleanupCurrentProcess(state);
    state.current = null;
    state.playing = false;
    scheduleIdleDisconnect(state);
    throw error;
  }

  return {
    track,
    durationSeconds: testToneDurationSeconds,
  };
}

function getQueue(guildId) {
    let kazagumo;
    try {
        kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            return {
                current: player.queue.current ? { title: player.queue.current.title } : null,
                queue: player.queue.map(track => ({ title: track.title }))
            };
        }
    } catch (e) {
        // Ignore
    }

    // Local fallback check
    const state = getLocalMusicState(guildId);
    return {
      current: state.current,
      queue: [...state.queue],
    };
}

function skipTrack(guildId) {
    try {
        const kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            const current = player.queue.current;
            player.skip();
            return current ? { title: current.title } : null;
        }
    } catch (e) {
        // Ignore
    }

    const state = getLocalMusicState(guildId);
    const skippedTrack = state.current;
    cleanupCurrentProcess(state);
    state.player.stop(true);

    if (!skippedTrack && state.queue.length === 0) {
      scheduleIdleDisconnect(state);
    }

    return skippedTrack;
}

function leaveVoiceChannel(guildId) {
    let wasConnected = false;
    cancelLavalinkIdleDisconnect(guildId);
    
    try {
        const kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            wasConnected = true;
            void player.destroy().catch((error) =>
                logger.warn(`Failed to destroy Lavalink player in guild ${guildId}: ${error?.message || error}`)
            );
        }
    } catch (e) {
        // Ignore
    }

    const state = guildLocalMusicStates.get(guildId);
    if (state && state.connection) {
        wasConnected = true;
        disconnectMusicState(state);
    }

    if (destroyLocalVoiceConnection(guildId, '/music leave')) {
        wasConnected = true;
    }

    return wasConnected;
}

function getVoiceStayStatus(guildId) {
  const policy = getVoiceStayPolicy(guildId);
  const localState = guildLocalMusicStates.get(guildId);
  const localConnection = localState?.connection || getVoiceConnection(guildId);
  let lavalinkPlayer = null;
  try {
    lavalinkPlayer = getKazagumo().players.get(guildId) || null;
  } catch {
    // Lavalink is optional for local voice diagnostics.
  }

  return {
    ...policy,
    backend: lavalinkPlayer ? 'lavalink' : localConnection ? 'local' : 'none',
    channelId: lavalinkPlayer?.voiceId || localConnection?.joinConfig?.channelId || null,
    idleTimerScheduled: Boolean(localState?.idleTimer || lavalinkIdleTimers.has(guildId)),
    playing: Boolean(lavalinkPlayer?.playing || localState?.playing),
  };
}

async function handleBotVoiceStateUpdate(oldState, newState) {
  const clientUserId = newState?.client?.user?.id || oldState?.client?.user?.id;
  const userId = newState?.id || oldState?.id || newState?.member?.id || oldState?.member?.id;
  if (!clientUserId || userId !== clientUserId) return false;

  const guildId = newState?.guild?.id || oldState?.guild?.id;
  const oldChannelId = oldState?.channelId || null;
  const newChannelId = newState?.channelId || null;
  if (!guildId || oldChannelId === newChannelId) return false;

  const localState = guildLocalMusicStates.get(guildId);
  let lavalinkPlayer = null;
  try {
    lavalinkPlayer = getKazagumo().players.get(guildId) || null;
  } catch {
    // No Lavalink runtime.
  }

  if (!newChannelId) {
    if (localState) disconnectMusicState(localState);
    if (lavalinkPlayer) await lavalinkPlayer.destroy().catch(() => undefined);
    logger.info(`[Music] Bot left voice in guild ${guildId}; stale player state was cleared.`);
    return true;
  }

  if (lavalinkPlayer && typeof lavalinkPlayer.setVoiceChannel === 'function') {
    await lavalinkPlayer.setVoiceChannel(newChannelId);
  }
  if (localState?.connection && localState.connection.joinConfig.channelId !== newChannelId && newState.channel) {
    localState.connection = await connectToLocalVoice(newState.channel);
    localState.connection.subscribe(localState.player);
    scheduleIdleDisconnect(localState);
  }
  logger.info(`[Music] Bot voice channel moved in guild ${guildId}: ${oldChannelId || 'none'} -> ${newChannelId}`);
  return true;
}

async function handleVoiceChannelDeleted(channel) {
  if (!channel?.guild?.id || !channel.isVoiceBased?.()) return false;
  const guildId = channel.guild.id;
  const localState = guildLocalMusicStates.get(guildId);
  let handled = false;

  if (localState?.connection?.joinConfig?.channelId === channel.id) {
    disconnectMusicState(localState);
    handled = true;
  }

  try {
    const player = getKazagumo().players.get(guildId);
    if (player?.voiceId === channel.id) {
      await player.destroy();
      handled = true;
    }
  } catch {
    // No Lavalink runtime.
  }

  if (handled) logger.info(`[Music] Deleted voice channel ${channel.id}; cleared guild ${guildId} voice state.`);
  return handled;
}

function stopMusic(guildId) {
    let kazagumo;
    try {
        kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            player.queue.clear();
        }
    } catch (e) {
        // Ignore
    }
    
    // Always call leave which handles destruction
    return leaveVoiceChannel(guildId);
}

function pauseMusic(guildId) {
    try {
        const kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            player.pause(true);
            return true;
        }
    } catch (e) {
        // Ignore
    }
    
    const state = guildLocalMusicStates.get(guildId);
    if (state) return state.player.pause();
    return false;
}

function resumeMusic(guildId) {
    try {
        const kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            player.pause(false);
            return true;
        }
    } catch (e) {
        // Ignore
    }
    
    const state = guildLocalMusicStates.get(guildId);
    if (state) return state.player.unpause();
    return false;
}

function hasMusicIntent(message) {
  const botId = message.client?.user?.id;
  const isMentioned = botId && message.mentions?.has?.(botId);
  const playKeywords = ['播放', '幫我播', '點歌', 'play', '點播', '點一首', 'music', '音樂'];
  const hasKeyword = playKeywords.some((keyword) => message.content?.includes(keyword));

  return Boolean(isMentioned || hasKeyword);
}

async function handleMusicLinkMessage(message) {
  const url = extractYouTubeUrl(message.content);

  if (!url) {
    return false;
  }

  if (!message.inGuild?.()) {
    return false;
  }

  if (!hasMusicIntent(message)) {
    return false;
  }

  const voiceChannel = message.member?.voice?.channel;

  if (!voiceChannel) {
    await message.reply({
      content: '請先加入語音頻道，再貼 YouTube 連結給小吉播放。',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  try {
    const result = await enqueueTrack({
      guild: message.guild,
      voiceChannel,
      textChannel: message.channel,
      url,
      requestedBy: message.author.id,
    });

    await message.reply({
      content: result.started
        ? `已開始播放：${result.track.title}`
        : `已加入播放佇列：${result.track.title}`,
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    logger.warn(`music link playback failed in guild ${message.guildId}: ${error?.message || error}`);
    await message.reply({
      content: `無法播放：${getMusicUserFacingError(error)}`,
      allowedMentions: { repliedUser: false },
    });
  }

  return true;
}

module.exports = {
  buildFfmpegTestToneArgs,
  buildFfmpegYoutubeFallbackArgs,
  buildLavalinkTrackUserData,
  applyVoiceStayPolicy,
  cancelLavalinkIdleDisconnect,
  createFfmpegTestToneStream,
  createTestToneResource,
  createYoutubeFallbackRuntime,
  enqueueTrack,
  extractYouTubeUrl,
  getMusicErrorLayer,
  getMusicUserFacingError,
  getGuildPlaybackOperationCount,
  getQueue,
  getVoiceStayPolicy,
  getVoiceStayStatus,
  handleBotVoiceStateUpdate,
  handleVoiceChannelDeleted,
  handleMusicLinkMessage,
  hasMusicIntent,
  isYouTubeUrl,
  joinMusicVoiceChannel,
  leaveVoiceChannel,
  MusicUserError,
  musicIdleLeaveMs,
  normalizeLavalinkLoadResult,
  pauseMusic,
  playLocalYouTubeFallback,
  playTestTone,
  resumeMusic,
  resolveLavalinkSearch,
  runExclusiveGuildPlaybackOperation,
  scheduleLavalinkIdleDisconnect,
  shouldScheduleIdleDisconnect,
  shouldUseLocalYouTubeFallback,
  skipTrack,
  stopMusic,
  testToneDurationSeconds,
  validateVoiceChannelForPlayback,
  waitForSustainedLocalPlayback,
};
