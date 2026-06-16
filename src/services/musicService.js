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
const youtubedl = require('youtube-dl-exec');
const logger = require('../utils/logger');

const youtubeUrlPattern = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)[^\s<>()]+/i;
const ytdlpAudioFormat = 'bestaudio[ext=webm][acodec=opus]/251/250/249';
const ytdlpBinaryPath = youtubedl.constants.YOUTUBE_DL_PATH;
const youtubeBotCheckPattern =
  /sign in to confirm (?:you(?:'|’)?re|you are) not a bot|use --cookies-from-browser or --cookies|cookies? are required|po token|potoken|visitor data/i;
const musicIdleLeaveMs = 3 * 60 * 1000;
const testToneDurationSeconds = 5;
const testToneFrequencyHz = 880;
const guildMusicStates = new Map();

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

function getYtdlpTarget(input) {
  const value = String(input || '').trim();

  if (!value) {
    throw new Error('請提供 YouTube 連結或搜尋關鍵字。');
  }

  return isYouTubeUrl(value) ? value : `ytsearch1:${value}`;
}

function getBriefMusicError(error) {
  return String(error?.message || error || '未知錯誤').replace(/\s+/g, ' ').slice(0, 180);
}

function getRawYtdlpError(error) {
  return String(error?.stderr || error?.stdout || error?.message || error || '');
}

function isYoutubeBotCheckError(error) {
  return youtubeBotCheckPattern.test(getRawYtdlpError(error));
}

function getYoutubeBotCheckMessage() {
  return [
    'YouTube 要求登入或驗證，這通常是 YouTube 擋下 yt-dlp / 雲端主機請求。',
    '這不是 Discord 語音房權限問題。',
    '請更新 yt-dlp、設定 cookies.txt（用 YTDLP_COOKIES_PATH 指到安全路徑）、處理 PO Token/visitor data，或改用其他音源。',
  ].join('\n');
}

function getMusicErrorLayer(error) {
  const code = error?.code || '';

  if (isYoutubeBotCheckError(error) || code.startsWith('youtube_') || code === 'cookies_missing') {
    return 'youtube';
  }

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

  if (code.startsWith('player_')) {
    return 'player';
  }

  if (code.startsWith('queue_')) {
    return 'queue';
  }

  return 'unknown';
}

function getMusicUserFacingError(error) {
  if (isYoutubeBotCheckError(error)) {
    return getYoutubeBotCheckMessage();
  }

  const layer = getMusicErrorLayer(error);
  const message = getBriefMusicError(error);

  if (layer === 'youtube') {
    return `YouTube 解析或串流失敗：${message}\n這不是 Discord 語音房問題，/music join 和 /music test 仍可獨立測試。`;
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

function getYtdlpCookiesPath() {
  const cookiesPath = (process.env.YTDLP_COOKIES_PATH || process.env.YOUTUBE_COOKIES_PATH || '').trim();

  if (!cookiesPath) {
    return null;
  }

  if (!fs.existsSync(cookiesPath)) {
    throw new MusicUserError(`已設定 cookies 路徑，但找不到檔案：${cookiesPath}`, 'cookies_missing');
  }

  return cookiesPath;
}

function createYtdlpInfoOptions() {
  const options = {
    dumpSingleJson: true,
    noWarnings: true,
    noPlaylist: true,
    skipDownload: true,
  };
  const cookiesPath = getYtdlpCookiesPath();

  if (cookiesPath) {
    options.cookies = cookiesPath;
  }

  return options;
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

function validateVoiceChannelForPlayback(voiceChannel, { existingConnection = null, commandName = '/music play' } = {}) {
  if (!voiceChannel) {
    throw new MusicUserError(`請先加入語音頻道，再使用 ${commandName}。`, 'user_not_in_voice');
  }

  if (!voiceChannel.guild?.members?.me) {
    throw new MusicUserError('小吉目前無法確認自己的語音權限，請稍後再試。', 'bot_member_missing');
  }

  const activeConnection = existingConnection || getVoiceConnection(voiceChannel.guild.id);

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

function cancelIdleDisconnect(state) {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function cleanupCurrentProcess(state) {
  if (state.currentProcess && !state.currentProcess.killed) {
    state.currentProcess.kill('SIGKILL');
  }

  state.currentProcess = null;
}

function disconnectMusicState(state) {
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
    logger.warn(`Failed to destroy voice connection in guild ${state.guildId}: ${error?.message || error}`);
  }
}

function scheduleIdleDisconnect(state) {
  if (state.idleTimer || !state.connection || state.current || state.playing || state.queue.length > 0) {
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

function getMusicState(guildId) {
  if (!guildMusicStates.has(guildId)) {
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
      void playNext(state);
    });

    player.on('error', (error) => {
      logger.warn(`Music player error in guild ${guildId}: ${error?.message || error}`);
      cleanupCurrentProcess(state);
      state.current = null;
      state.playing = false;
      void playNext(state);
    });

    guildMusicStates.set(guildId, state);
  }

  return guildMusicStates.get(guildId);
}

async function getTrackInfo(url, requestedBy) {
  const target = getYtdlpTarget(url);

  try {
    const info = await youtubedl(target, createYtdlpInfoOptions());
    const video = Array.isArray(info.entries) ? info.entries[0] : info;

    if (!video) {
      throw new Error('找不到可播放的 YouTube 搜尋結果。');
    }

    return {
      url: video.webpage_url || video.original_url || video.url || url,
      title: video.title || url,
      duration: video.duration || null,
      requestedBy,
    };
  } catch (error) {
    logger.warn(`Failed to fetch YouTube video info for "${url}": ${error?.stderr || error?.message || error}`);

    if (error instanceof MusicUserError) {
      throw error;
    }

    if (isYoutubeBotCheckError(error)) {
      throw new MusicUserError(getYoutubeBotCheckMessage(), 'youtube_bot_check');
    }

    throw new MusicUserError(`搜尋或解析 YouTube 影片失敗：${getBriefMusicError(error)}`, 'youtube_parse_failed');
  }
}

async function connectToVoice(voiceChannel) {
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

  validateVoiceChannelForPlayback(voiceChannel, { existingConnection });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  connection.on('error', (error) => {
    logger.warn(`Voice connection error in guild ${voiceChannel.guild.id}: ${error?.message || error}`);
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    logger.warn(`Voice connection disconnected in guild ${voiceChannel.guild.id}.`);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    try {
      connection.destroy();
    } catch (destroyError) {
      logger.warn(`Failed to destroy failed voice connection: ${destroyError?.message || destroyError}`);
    }

    throw new MusicUserError(`小吉加入語音頻道逾時或失敗：${getBriefMusicError(error)}`, 'voice_connect_failed');
  }

  return connection;
}

async function joinMusicVoiceChannel({ guild, voiceChannel, textChannel = null }) {
  const state = getMusicState(guild.id);
  cancelIdleDisconnect(state);
  validateVoiceChannelForPlayback(voiceChannel, {
    existingConnection: state.connection,
    commandName: '/music join',
  });

  state.textChannel = textChannel || state.textChannel;
  state.connection = await connectToVoice(voiceChannel);
  state.connection.subscribe(state.player);

  return {
    channelId: voiceChannel.id,
    channelName: voiceChannel.name || '語音頻道',
    reused: state.connection.joinConfig.channelId === voiceChannel.id,
  };
}

function buildYtdlpStreamArgs(url) {
  const args = [
    url,
    '--format',
    ytdlpAudioFormat,
    '--output',
    '-',
    '--quiet',
    '--no-warnings',
    '--no-playlist',
  ];
  const cookiesPath = getYtdlpCookiesPath();

  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }

  return args;
}

function createYtdlpStream(track) {
  const subprocess = spawn(ytdlpBinaryPath, buildYtdlpStreamArgs(track.url), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  subprocess.xiaojiStderr = '';

  subprocess.stderr?.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      subprocess.xiaojiStderr = `${subprocess.xiaojiStderr}\n${message}`.trim().slice(-1000);
      logger.warn(`yt-dlp stderr: ${message}`);
    }
  });

  subprocess.on('error', (error) => {
    logger.warn(`yt-dlp process error: ${error?.message || error}`);
  });

  subprocess.on('close', (code, signal) => {
    if (code && !subprocess.killed) {
      logger.warn(`yt-dlp exited with code ${code}${signal ? ` and signal ${signal}` : ''}`);
    }
  });

  return subprocess;
}

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
        settle(
          reject,
          isYoutubeBotCheckError(message) ? new MusicUserError(getYoutubeBotCheckMessage(), 'youtube_bot_check') : new MusicUserError(message, failureCode)
        );
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

async function createTrackResource(track) {
  const subprocess = createYtdlpStream(track);

  if (!subprocess.stdout) {
    throw new MusicUserError('無法建立 yt-dlp 音訊串流。', 'youtube_stream_failed');
  }

  const resource = createAudioResource(subprocess.stdout, {
    inputType: StreamType.WebmOpus,
    metadata: track,
  });

  return { resource, subprocess };
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

async function playNext(state, { throwOnFailure = false } = {}) {
  cancelIdleDisconnect(state);

  if (state.queue.length === 0) {
    state.playing = false;
    scheduleIdleDisconnect(state);
    return;
  }

  const track = state.queue.shift();
  state.current = track;
  state.playing = true;

  try {
    const { resource, subprocess } = await createTrackResource(track);
    state.currentProcess = subprocess;
    state.player.play(resource);
    await waitForPlaybackStart(state, subprocess, {
      sourceName: 'yt-dlp',
      failureCode: 'youtube_stream_failed',
    });

    if (state.textChannel?.send) {
      await state.textChannel.send({
        content: `正在播放：**${track.title}**`,
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) {
    const briefError = getBriefMusicError(error);
    logger.warn(`Failed to play track ${track.url}: ${briefError}`);

    if (!throwOnFailure && state.textChannel?.send) {
      await state.textChannel.send({
        content: `播放失敗：${briefError}。已嘗試播放下一首。`,
        allowedMentions: { parse: [] },
      });
    }

    cleanupCurrentProcess(state);
    state.current = null;
    state.playing = false;

    if (throwOnFailure) {
      throw error instanceof MusicUserError ? error : new MusicUserError(briefError, 'player_play_failed');
    }

    await playNext(state);
  }
}

async function enqueueTrack({ guild, voiceChannel, textChannel, url, requestedBy }) {
  const state = getMusicState(guild.id);
  cancelIdleDisconnect(state);
  validateVoiceChannelForPlayback(voiceChannel, { existingConnection: state.connection });

  let track;
  try {
    track = await getTrackInfo(url, requestedBy);
  } catch (error) {
    scheduleIdleDisconnect(state);
    throw error;
  }

  state.textChannel = textChannel;

  if (!state.connection || state.connection.joinConfig.channelId !== voiceChannel.id) {
    state.connection = await connectToVoice(voiceChannel);
    state.connection.subscribe(state.player);
  }

  state.queue.push(track);

  if (!state.current && !state.playing) {
    try {
      await playNext(state, { throwOnFailure: true });
    } catch (error) {
      scheduleIdleDisconnect(state);
      throw error;
    }
  }

  return {
    track,
    position: state.queue.length,
    started: state.current?.url === track.url,
  };
}

async function playTestTone({ guild, voiceChannel, textChannel }) {
  const state = getMusicState(guild.id);
  cancelIdleDisconnect(state);
  validateVoiceChannelForPlayback(voiceChannel, {
    existingConnection: state.connection,
    commandName: '/music test',
  });

  if (state.current || state.playing || state.queue.length > 0) {
    throw new MusicUserError('目前正在播放或佇列中仍有歌曲，請先使用 /music stop 再執行 /music test。', 'queue_busy');
  }

  state.textChannel = textChannel;

  if (!state.connection || state.connection.joinConfig.channelId !== voiceChannel.id) {
    state.connection = await connectToVoice(voiceChannel);
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
  const state = getMusicState(guildId);
  return {
    current: state.current,
    queue: [...state.queue],
  };
}

function skipTrack(guildId) {
  const state = getMusicState(guildId);
  const skippedTrack = state.current;
  cleanupCurrentProcess(state);
  state.player.stop(true);

  if (!skippedTrack && state.queue.length === 0) {
    scheduleIdleDisconnect(state);
  }

  return skippedTrack;
}

function leaveVoiceChannel(guildId) {
  const state = getMusicState(guildId);
  const wasConnected = Boolean(state.connection);
  disconnectMusicState(state);
  return wasConnected;
}

function stopMusic(guildId) {
  return leaveVoiceChannel(guildId);
}

function pauseMusic(guildId) {
  return getMusicState(guildId).player.pause();
}

function resumeMusic(guildId) {
  return getMusicState(guildId).player.unpause();
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

  // Only trigger if specifically requested via mention or keyword
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
  buildYtdlpStreamArgs,
  createFfmpegTestToneStream,
  createTestToneResource,
  createYtdlpStream,
  enqueueTrack,
  extractYouTubeUrl,
  getMusicErrorLayer,
  getMusicUserFacingError,
  getQueue,
  getTrackInfo,
  getYtdlpCookiesPath,
  getYoutubeBotCheckMessage,
  handleMusicLinkMessage,
  hasMusicIntent,
  isYoutubeBotCheckError,
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
  ytdlpAudioFormat,
  ytdlpBinaryPath,
};
