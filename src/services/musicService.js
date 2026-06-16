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
const youtubedl = require('youtube-dl-exec');
const logger = require('../utils/logger');

const youtubeUrlPattern = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)[^\s<>()]+/i;
const ytdlpAudioFormat = 'bestaudio[ext=webm][acodec=opus]/251/250/249';
const ytdlpBinaryPath = youtubedl.constants.YOUTUBE_DL_PATH;
const musicIdleLeaveMs = 3 * 60 * 1000;
const guildMusicStates = new Map();

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

function getMissingVoicePermissions(voiceChannel) {
  const botMember = voiceChannel.guild.members.me;
  const permissions = botMember ? voiceChannel.permissionsFor(botMember) : null;
  const missing = [];

  if (!permissions?.has(PermissionFlagsBits.Connect)) {
    missing.push('Connect');
  }

  if (!permissions?.has(PermissionFlagsBits.Speak)) {
    missing.push('Speak');
  }

  return missing;
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
    const info = await youtubedl(target, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      skipDownload: true,
    });
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
    throw new Error(`搜尋或解析 YouTube 影片失敗：${getBriefMusicError(error)}`);
  }
}

async function connectToVoice(voiceChannel) {
  const existingConnection = getVoiceConnection(voiceChannel.guild.id);

  if (existingConnection) {
    if (existingConnection.joinConfig.channelId !== voiceChannel.id) {
      existingConnection.destroy();
    } else {
      await entersState(existingConnection, VoiceConnectionStatus.Ready, 20_000);
      return existingConnection;
    }
  }

  const missingPermissions = getMissingVoicePermissions(voiceChannel);

  if (missingPermissions.length > 0) {
    throw new Error(`小吉缺少語音頻道權限：${missingPermissions.join(', ')}。`);
  }

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

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  return connection;
}

function buildYtdlpStreamArgs(url) {
  return [
    url,
    '--format',
    ytdlpAudioFormat,
    '--output',
    '-',
    '--quiet',
    '--no-warnings',
    '--no-playlist',
  ];
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

function waitForPlaybackStart(state, subprocess) {
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
      settle(reject, new Error(`yt-dlp 啟動失敗：${getBriefMusicError(error)}`));
    };

    const onProcessClose = (code, signal) => {
      if (code && !subprocess.killed) {
        const stderr = subprocess.xiaojiStderr ? `；${subprocess.xiaojiStderr}` : '';
        settle(reject, new Error(`yt-dlp 結束，代碼 ${code}${signal ? `，訊號 ${signal}` : ''}${stderr}`));
      }
    };

    subprocess.once('error', onProcessError);
    subprocess.once('close', onProcessClose);

    entersState(state.player, AudioPlayerStatus.Playing, 15_000)
      .then((value) => settle(resolve, value))
      .catch((error) => settle(reject, new Error(`播放器未進入播放狀態：${getBriefMusicError(error)}`)));
  });
}

async function createTrackResource(track) {
  const subprocess = createYtdlpStream(track);

  if (!subprocess.stdout) {
    throw new Error('無法建立 yt-dlp 音訊串流。');
  }

  const resource = createAudioResource(subprocess.stdout, {
    inputType: StreamType.WebmOpus,
    metadata: track,
  });

  return { resource, subprocess };
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
    await waitForPlaybackStart(state, subprocess);

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
      throw new Error(briefError);
    }

    await playNext(state);
  }
}

async function enqueueTrack({ guild, voiceChannel, textChannel, url, requestedBy }) {
  const state = getMusicState(guild.id);
  cancelIdleDisconnect(state);

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
      content: `無法播放：${error.message}`,
      allowedMentions: { repliedUser: false },
    });
  }

  return true;
}

module.exports = {
  buildYtdlpStreamArgs,
  createYtdlpStream,
  enqueueTrack,
  extractYouTubeUrl,
  getQueue,
  getTrackInfo,
  handleMusicLinkMessage,
  hasMusicIntent,
  isYouTubeUrl,
  leaveVoiceChannel,
  musicIdleLeaveMs,
  pauseMusic,
  resumeMusic,
  skipTrack,
  stopMusic,
  ytdlpAudioFormat,
  ytdlpBinaryPath,
};
