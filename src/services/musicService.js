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
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const ffmpegPath = require('ffmpeg-static');
const { getKazagumo } = require('./lavalinkService');
const logger = require('../utils/logger');

const youtubeUrlPattern = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)[^\s<>()]+/i;
const musicIdleLeaveMs = 3 * 60 * 1000;
const testToneDurationSeconds = 5;
const testToneFrequencyHz = 880;

// Local fallback state (used only for /music test now)
const guildLocalMusicStates = new Map();

class MusicUserError extends Error {
  constructor(message, code = 'music_user_error') {
    super(message);
    this.name = 'MusicUserError';
    this.code = code;
  }
}

function extractYouTubeUrl(content) {
  const match = String(content || '').match(youtubeUrlPattern);
  return match ? match[0] : null;
}

function isYouTubeUrl(url) {
  youtubeUrlPattern.lastIndex = 0;
  return Boolean(url && youtubeUrlPattern.test(String(url)));
}

function getBriefMusicError(error) {
  return String(error?.message || error || '未知錯誤').replace(/\s+/g, ' ').slice(0, 180);
}

function getMusicErrorLayer(error) {
  const code = error?.code || '';

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

  return 'unknown';
}

function getMusicUserFacingError(error) {
  const layer = getMusicErrorLayer(error);
  const message = getBriefMusicError(error);

  if (layer === 'lavalink') {
      return `Lavalink 串流節點錯誤：${message}\n請確認是否有可用的音樂節點。`;
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
  
  // Basic Lavalink check
  let kazagumo;
  try {
      kazagumo = getKazagumo();
  } catch (e) {
      // Allow fallback testing if lavalink is down, handled in specific commands
  }
  
  if (kazagumo) {
      const activePlayer = kazagumo.players.get(voiceChannel.guild.id);
      if (activePlayer && activePlayer.voiceId !== voiceChannel.id) {
          throw new MusicUserError('小吉已經在其他語音頻道，請先使用 /music leave 讓我離開後再播放。', 'bot_in_other_voice');
      }
  }

  // Also check local connection
  const activeConnection = getVoiceConnection(voiceChannel.guild.id);
  if (activeConnection && activeConnection.joinConfig.channelId !== voiceChannel.id) {
    throw new MusicUserError('小吉已經在其他語音頻道，請先使用 /music leave 讓我離開後再播放。', 'bot_in_other_voice');
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

function cleanupCurrentProcess(state) {
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

function scheduleIdleDisconnect(state) {
  if (!state || state.idleTimer || !state.connection || state.current || state.playing || state.queue.length > 0) {
    return;
  }

  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;

    if (!state.connection || state.current || state.playing || state.queue.length > 0) {
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

  validateVoiceChannelForPlayback(voiceChannel, { commandName: '/music test' });

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

  let kazagumo;
  try {
      kazagumo = getKazagumo();
  } catch (error) {
      // Fallback to local test connection logic if Lavalink is down
      const state = getLocalMusicState(guild.id);
      state.textChannel = textChannel || state.textChannel;
      state.connection = await connectToLocalVoice(voiceChannel);
      state.connection.subscribe(state.player);
      
      return {
          channelId: voiceChannel.id,
          channelName: voiceChannel.name || '語音頻道',
          reused: state.connection.joinConfig.channelId === voiceChannel.id,
      };
  }

  let player = kazagumo.players.get(guild.id);
  const reused = Boolean(player && player.voiceId === voiceChannel.id);

  if (!player) {
      try {
          player = await kazagumo.createPlayer({
              guildId: guild.id,
              textId: textChannel?.id || voiceChannel.id,
              voiceId: voiceChannel.id,
              volume: 100,
          });
      } catch (e) {
          throw new MusicUserError(`Lavalink 節點連線失敗：${getBriefMusicError(e)}`, 'lavalink_connect_failed');
      }
  } else if (player.voiceId !== voiceChannel.id) {
      player.setVoiceChannel(voiceChannel.id);
  }
  
  if (textChannel) {
      player.setTextChannel(textChannel.id);
  }

  return {
    channelId: voiceChannel.id,
    channelName: voiceChannel.name || '語音頻道',
    reused,
  };
}

async function enqueueTrack({ guild, voiceChannel, textChannel, url, requestedBy }) {
  validateVoiceChannelForPlayback(voiceChannel);
  
  let kazagumo;
  try {
      kazagumo = getKazagumo();
  } catch (error) {
      throw new MusicUserError('音樂服務尚未初始化或節點離線中，請稍後再試。', 'lavalink_unavailable');
  }

  let player = kazagumo.players.get(guild.id);
  if (!player || player.voiceId !== voiceChannel.id) {
      // Ensure we leave any existing local connection before lavalink takes over
      leaveVoiceChannel(guild.id);
      
      try {
          player = await kazagumo.createPlayer({
              guildId: guild.id,
              textId: textChannel.id,
              voiceId: voiceChannel.id,
              volume: 100,
          });
      } catch (error) {
           throw new MusicUserError(`無法建立音訊播放器：${getBriefMusicError(error)}`, 'lavalink_player_failed');
      }
  }

  // Clear local state idle timer if lavalink is active
  cancelIdleDisconnect(getLocalMusicState(guild.id));

  const result = await kazagumo.search(url, { requester: requestedBy });

  if (!result.tracks.length) {
      throw new MusicUserError('找不到可播放的結果。', 'youtube_parse_failed');
  }

  if (result.type === "PLAYLIST") {
      for (const track of result.tracks) {
          player.queue.add(track);
      }
  } else {
      player.queue.add(result.tracks[0]);
  }

  const track = result.tracks[0];
  const started = !player.playing && !player.paused;
  
  if (started) {
      player.play();
  }

  return {
    track: {
        title: result.type === "PLAYLIST" ? `播放清單：${result.playlistName}` : track.title,
        url: track.uri,
    },
    position: player.queue.length,
    started,
  };
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
          player.destroy();
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
    
    try {
        const kazagumo = getKazagumo();
        const player = kazagumo.players.get(guildId);
        if (player) {
            wasConnected = true;
            player.destroy();
        }
    } catch (e) {
        // Ignore
    }

    const state = guildLocalMusicStates.get(guildId);
    if (state && state.connection) {
        wasConnected = true;
        disconnectMusicState(state);
    }

    return wasConnected;
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
      content: result.started ? `已開始播放：${result.track.title}` : `已加入播放佇列：${result.track.title}`,
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
  createFfmpegTestToneStream,
  createTestToneResource,
  enqueueTrack,
  extractYouTubeUrl,
  getMusicErrorLayer,
  getMusicUserFacingError,
  getQueue,
  handleMusicLinkMessage,
  hasMusicIntent,
  isYouTubeUrl,
  joinMusicVoiceChannel,
  leaveVoiceChannel,
  MusicUserError,
  musicIdleLeaveMs,
  pauseMusic,
  playTestTone,
  resumeMusic,
  skipTrack,
  stopMusic,
  testToneDurationSeconds,
  validateVoiceChannelForPlayback,
};
