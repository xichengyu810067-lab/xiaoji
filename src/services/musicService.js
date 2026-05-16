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
  return Boolean(url && youtubeUrlPattern.test(String(url)));
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
  if (!isYouTubeUrl(url)) {
    throw new Error('請提供有效的 YouTube 影片網址。');
  }

  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      skipDownload: true,
    });

    return {
      url,
      title: info.title || url,
      duration: info.duration || null,
      requestedBy,
    };
  } catch (error) {
    logger.warn(`Failed to fetch YouTube video info: ${error?.stderr || error?.message || error}`);
    return {
      url,
      title: url,
      duration: null,
      requestedBy,
    };
  }
}

async function connectToVoice(voiceChannel) {
  const existingConnection = getVoiceConnection(voiceChannel.guild.id);

  if (existingConnection) {
    return existingConnection;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: true,
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

  subprocess.stderr?.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) {
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

async function playNext(state) {
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

    if (state.textChannel?.send) {
      await state.textChannel.send({
        content: `正在播放：**${track.title}**`,
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) {
    logger.warn(`Failed to play track ${track.url}: ${error?.message || error}`);

    if (state.textChannel?.send) {
      await state.textChannel.send({
        content: '播放失敗，已嘗試播放下一首。',
        allowedMentions: { parse: [] },
      });
    }

    cleanupCurrentProcess(state);
    state.current = null;
    state.playing = false;
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

  if (!state.connection) {
    state.connection = await connectToVoice(voiceChannel);
    state.connection.subscribe(state.player);
  }

  state.queue.push(track);

  if (!state.current && !state.playing) {
    await playNext(state);
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
    await message.reply({
      content: `無法播放這個 YouTube 連結：${error.message}`,
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
