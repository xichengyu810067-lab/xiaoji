const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');
const {
  buildFfmpegTestToneArgs,
  buildLavalinkTrackUserData,
  extractYouTubeUrl,
  getMusicErrorLayer,
  getMusicUserFacingError,
  getVoiceStayPolicy,
  handleBotVoiceStateUpdate,
  handleVoiceChannelDeleted,
  hasMusicIntent,
  isYouTubeUrl,
  musicIdleLeaveMs,
  normalizeLavalinkLoadResult,
  resolveLavalinkSearch,
  shouldScheduleIdleDisconnect,
  validateVoiceChannelForPlayback,
} = require('../src/services/musicService');
const { getLavalinkStatus, getNodeConfiguration, initializeLavalink } = require('../src/services/lavalinkService');
const musicCommand = require('../src/commands/music');
const { assertSafeYoutubeCredentialPolicy } = require('../scripts/check-project');
const { formatLavalinkStatus, formatQueue } = musicCommand;

test('extractYouTubeUrl finds youtube links in message text', () => {
  assert.equal(
    extractYouTubeUrl('play this https://www.youtube.com/watch?v=dQw4w9WgXcQ please'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );
  assert.equal(extractYouTubeUrl('no link here'), null);
  assert.equal(extractYouTubeUrl('看這個 https://youtu.be/dQw4w9WgXcQ。'), 'https://youtu.be/dQw4w9WgXcQ');
});

test('isYouTubeUrl validates common YouTube video URLs', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://youtube.com/shorts/dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=2'), true);
  assert.equal(isYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), false);
  assert.equal(isYouTubeUrl('https://youtube.com/playlist?list=abc'), false);
});

test('Lavalink 4.2.2 player update uses object track userData', () => {
  const requester = buildLavalinkTrackUserData('844163435037720597');
  const playerUpdatePayload = {
    track: {
      encoded: 'test-encoded-track',
      userData: requester,
    },
    replaceCurrent: true,
  };

  assert.deepEqual(playerUpdatePayload.track.userData, { requesterId: '844163435037720597' });
  assert.equal(typeof playerUpdatePayload.track.userData, 'object');
  assert.equal(Array.isArray(playerUpdatePayload.track.userData), false);
  assert.match(JSON.stringify(playerUpdatePayload), /"userData":\{"requesterId":"844163435037720597"\}/);
  assert.throws(
    () => buildLavalinkTrackUserData(null),
    (error) => error.code === 'lavalink_requester_invalid'
  );
});

test('Lavalink YouTube client policy uses only TVHTML5_SIMPLY without account-based bypasses', () => {
  const application = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'lavalink', 'application.yml'), 'utf8');
  const clientsBlock = application.match(/clients:\s*((?:\r?\n\s+-\s+\S+)+)/);

  assert.ok(clientsBlock, 'youtube clients block must exist');
  assert.deepEqual(
    [...clientsBlock[1].matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((match) => match[1]),
    ['TVHTML5_SIMPLY']
  );
  assert.doesNotMatch(application, /ANDROID_VR|WEBEMBEDDED|^\s+-\s+WEB\s*$|^\s+-\s+MUSIC\s*$/m);
  assert.doesNotThrow(() => assertSafeYoutubeCredentialPolicy(application));
});

test('Lavalink YouTube credential policy rejects every supported account credential key', () => {
  const forbiddenKeys = [
    'oauth',
    `po${'Token'}`,
    'cookie',
    `refresh${'Token'}`,
    'pot',
    'token',
    `visitor${'Data'}`,
    `access${'Token'}`,
    'cookieFile',
    'youtubeOauthEnabled',
  ];

  for (const key of forbiddenKeys) {
    const syntheticApplication = `plugins:\n  youtube:\n    enabled: true\n    ${key}: synthetic-disabled-value\n`;
    assert.throws(
      () => assertSafeYoutubeCredentialPolicy(syntheticApplication),
      /must not introduce account credentials/
    );
  }

  assert.doesNotThrow(() =>
    assertSafeYoutubeCredentialPolicy('plugins:\n  youtube:\n    notes: "synthetic token: marker only"\n')
  );
});

test('Lavalink load errors remain failures instead of becoming empty search results', () => {
  assert.throws(
    () =>
      normalizeLavalinkLoadResult(
        {
          loadType: 'error',
          data: {
            message: 'All clients failed',
            cause: 'Synthetic playback failure',
            severity: 'fault',
          },
        },
        { requesterId: 'user-1' }
      ),
    (error) => error.code === 'youtube_source_failed' && /All clients failed/.test(error.message)
  );
});

test('Lavalink empty results remain distinct from source load errors', () => {
  assert.deepEqual(normalizeLavalinkLoadResult({ loadType: 'empty', data: {} }, { requesterId: 'user-1' }), {
    playlistName: undefined,
    tracks: [],
    type: 'SEARCH',
  });
});

test('Lavalink track results are normalized into playable Kazagumo tracks', () => {
  const requester = { requesterId: 'user-1' };
  const result = normalizeLavalinkLoadResult(
    {
      loadType: 'track',
      data: {
        encoded: 'synthetic-encoded-track',
        info: {
          identifier: 'video-id',
          isSeekable: true,
          author: 'Synthetic Artist',
          length: 120000,
          isStream: false,
          position: 0,
          title: 'Synthetic Track',
          uri: 'https://www.youtube.com/watch?v=video-id',
          artworkUrl: null,
          isrc: null,
          sourceName: 'youtube',
        },
        pluginInfo: {},
        userData: {},
      },
    },
    requester
  );

  assert.equal(result.type, 'TRACK');
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].track, 'synthetic-encoded-track');
  assert.equal(result.tracks[0].requester, requester);
});

test('YouTube source failures use a stable user message without exposing backend details', () => {
  const error = new Error('All clients failed: synthetic backend details');
  error.code = 'youtube_source_failed';

  assert.equal(getMusicErrorLayer(error), 'source');
  assert.equal(
    getMusicUserFacingError(error),
    'YouTube 來源目前拒絕或無法載入這部影片，請稍後再試或改用其他公開影片。'
  );
  assert.doesNotMatch(getMusicUserFacingError(error), /All clients failed/);
});

test('Lavalink search reports no online node as a friendly service error', async () => {
  await assert.rejects(
    () => resolveLavalinkSearch({ getLeastUsedNode: async () => null }, 'synthetic query', { requesterId: 'user-1' }),
    (error) =>
      error.code === 'lavalink_unavailable' &&
      getMusicErrorLayer(error) === 'lavalink' &&
      !/undefined|null/i.test(getMusicUserFacingError(error))
  );
});

test('Lavalink numeric node-selection errors are normalized without leaking internals', async () => {
  const internalError = new Error('synthetic internal node-selection detail');
  internalError.code = 2;

  assert.equal(getMusicErrorLayer(internalError), 'unknown');
  await assert.rejects(
    () =>
      resolveLavalinkSearch(
        { getLeastUsedNode: async () => Promise.reject(internalError) },
        'synthetic query',
        { requesterId: 'user-1' }
      ),
    (error) =>
      error.code === 'lavalink_unavailable' &&
      getMusicErrorLayer(error) === 'lavalink' &&
      !getMusicUserFacingError(error).includes('synthetic internal node-selection detail')
  );
});

test('Lavalink public fallback is off unless explicitly enabled', () => {
  const previous = {
    host: process.env.LAVALINK_HOST,
    password: process.env.LAVALINK_PASSWORD,
    fallback: process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK,
    fallbackHost: process.env.LAVALINK_PUBLIC_FALLBACK_HOST,
    fallbackPassword: process.env.LAVALINK_PUBLIC_FALLBACK_PASSWORD,
  };
  delete process.env.LAVALINK_HOST;
  delete process.env.LAVALINK_PASSWORD;
  delete process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK;

  try {
    const disabled = getNodeConfiguration();
    assert.equal(disabled.mode, 'disabled');
    assert.equal(disabled.nodes.length, 0);

    process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK = 'true';
    process.env.LAVALINK_PUBLIC_FALLBACK_HOST = 'public.example.test';
    process.env.LAVALINK_PUBLIC_FALLBACK_PASSWORD = 'provider-value';
    const optedIn = getNodeConfiguration();
    assert.equal(optedIn.mode, 'public-fallback-opt-in');
    assert.ok(optedIn.nodes.length > 0);
  } finally {
    for (const [key, value] of Object.entries({
      LAVALINK_HOST: previous.host,
      LAVALINK_PASSWORD: previous.password,
      LAVALINK_ALLOW_PUBLIC_FALLBACK: previous.fallback,
      LAVALINK_PUBLIC_FALLBACK_HOST: previous.fallbackHost,
      LAVALINK_PUBLIC_FALLBACK_PASSWORD: previous.fallbackPassword,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('self-hosted Lavalink requires an explicit password and reports safe diagnostics', () => {
  const previousHost = process.env.LAVALINK_HOST;
  const previousPassword = process.env.LAVALINK_PASSWORD;
  process.env.LAVALINK_HOST = 'lavalink.internal';
  delete process.env.LAVALINK_PASSWORD;

  try {
    const invalid = getNodeConfiguration();
    assert.equal(invalid.nodes.length, 0);
    assert.match(invalid.errors.join(' '), /LAVALINK_PASSWORD/);

    process.env.LAVALINK_PASSWORD = 'test-only-secret';
    const configured = getNodeConfiguration();
    assert.equal(configured.mode, 'self-hosted');
    assert.equal(configured.nodes[0].url, 'lavalink.internal:2333');
    assert.doesNotMatch(JSON.stringify(getLavalinkStatus()), /test-only-secret/);
  } finally {
    if (previousHost === undefined) delete process.env.LAVALINK_HOST;
    else process.env.LAVALINK_HOST = previousHost;
    if (previousPassword === undefined) delete process.env.LAVALINK_PASSWORD;
    else process.env.LAVALINK_PASSWORD = previousPassword;
  }
});

test('Lavalink initialization stays disabled instead of silently connecting to public nodes', () => {
  const previousHost = process.env.LAVALINK_HOST;
  const previousFallback = process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK;
  delete process.env.LAVALINK_HOST;
  delete process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK;

  try {
    assert.equal(initializeLavalink({}), null);
    const status = getLavalinkStatus();
    assert.equal(status.configurationMode, 'disabled');
    assert.match(formatLavalinkStatus(status), /public fallback 預設關閉/);
  } finally {
    if (previousHost === undefined) delete process.env.LAVALINK_HOST;
    else process.env.LAVALINK_HOST = previousHost;
    if (previousFallback === undefined) delete process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK;
    else process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK = previousFallback;
  }
});

test('formatQueue renders current track and queued tracks', () => {
  const output = formatQueue({
    current: { title: 'Current' },
    queue: [{ title: 'Next' }],
  });

  assert.match(output, /Current/);
  assert.match(output, /Next/);
});

test('buildFfmpegTestToneArgs builds a local non-youtube test source', () => {
  const args = buildFfmpegTestToneArgs({ durationSeconds: 5, frequencyHz: 880 });

  assert.ok(args.includes('lavfi'));
  assert.ok(args.includes('sine=frequency=880:duration=5'));
  assert.ok(args.includes('libopus'));
  assert.ok(args.includes('pipe:1'));
  assert.equal(args.some((arg) => String(arg).includes('youtube')), false);
});

test('music errors are categorized by layer', () => {
  const voiceError = new Error('小吉缺少 Connect 權限');
  voiceError.code = 'missing_connect';

  assert.equal(getMusicErrorLayer(voiceError), 'voice');
  
  const lavalinkError = new Error('Lavalink failed');
  lavalinkError.code = 'lavalink_connect_failed';
  assert.equal(getMusicErrorLayer(lavalinkError), 'lavalink');
});

test('music command exposes diagnostic subcommands', () => {
  const subcommands = musicCommand.data.toJSON().options.map((option) => option.name);

  assert.ok(subcommands.includes('join'));
  assert.ok(subcommands.includes('test'));
  assert.ok(subcommands.includes('status'));
  assert.ok(subcommands.includes('stay'));
  assert.ok(subcommands.includes('leave'));
});

test('music status exposes effective voice stay diagnostics', () => {
  const output = formatLavalinkStatus(getLavalinkStatus(), {
    enabled: true,
    source: 'env',
    backend: 'local',
    channelId: 'voice-1',
    idleTimerScheduled: false,
    playing: false,
  });

  assert.match(output, /語音長駐策略/);
  assert.match(output, /enabled: true/);
  assert.match(output, /channelId: voice-1/);
});

test('lavalink status is available before runtime initialization', () => {
  const status = getLavalinkStatus();
  const output = formatLavalinkStatus(status);

  assert.equal(status.initialized, false);
  assert.ok(status.configuredNodeCount >= 0);
  assert.match(output, /Lavalink 音樂節點狀態/);
  assert.match(output, /尚未初始化/);
});

test('music idle leave timeout is 3 minutes', () => {
  assert.equal(musicIdleLeaveMs, 180000);
});

test('voice stay policy uses guild override before environment', () => {
  assert.deepEqual(
    getVoiceStayPolicy('guild-1', { config: { music: { stayInVoice: true } }, env: { MUSIC_STAY_IN_VOICE: 'false' } }),
    { enabled: true, source: 'guild-config' }
  );
  assert.deepEqual(
    getVoiceStayPolicy('guild-1', { config: { music: { stayInVoice: null } }, env: { MUSIC_STAY_IN_VOICE: 'true' } }),
    { enabled: true, source: 'env' }
  );
});

test('idle disconnect is suppressed only when stay policy is enabled', () => {
  const state = { guildId: 'guild-1', idleTimer: null, connection: {}, current: null, playing: false, queue: [] };
  assert.equal(
    shouldScheduleIdleDisconnect(state, { config: { music: { stayInVoice: true } } }),
    false
  );
  assert.equal(
    shouldScheduleIdleDisconnect(state, { config: { music: { stayInVoice: false } } }),
    true
  );
  assert.equal(
    shouldScheduleIdleDisconnect({ ...state, playing: true }, { config: { music: { stayInVoice: false } } }),
    false
  );
});

test('voice lifecycle handlers ignore unrelated users and accept bot movement', async () => {
  const client = { user: { id: 'bot-1' } };
  assert.equal(
    await handleBotVoiceStateUpdate(
      { id: 'user-1', channelId: 'voice-1', client, guild: { id: 'guild-1' } },
      { id: 'user-1', channelId: null, client, guild: { id: 'guild-1' } }
    ),
    false
  );
  assert.equal(
    await handleBotVoiceStateUpdate(
      { id: 'bot-1', channelId: 'voice-1', client, guild: { id: 'guild-1' } },
      { id: 'bot-1', channelId: 'voice-2', channel: null, client, guild: { id: 'guild-1' } }
    ),
    true
  );
  assert.equal(await handleVoiceChannelDeleted({ id: 'text-1', guild: { id: 'guild-1' }, isVoiceBased: () => false }), false);
});

test('hasMusicIntent detects keywords and mentions', () => {
  const botId = '123';
  const mockMentions = new Map();
  mockMentions.has = (id) => id === botId;

  // Keyword match
  assert.equal(hasMusicIntent({ content: '播放 https://youtube.com/xxx' }), true);
  assert.equal(hasMusicIntent({ content: '幫我播 https://youtube.com/xxx' }), true);
  assert.equal(hasMusicIntent({ content: '點歌 https://youtube.com/xxx' }), true);
  assert.equal(hasMusicIntent({ content: 'play https://youtube.com/xxx' }), true);

  // Mention match
  assert.equal(
    hasMusicIntent({
      content: 'hey <@123> check this',
      client: { user: { id: botId } },
      mentions: mockMentions,
    }),
    true
  );

  // No match
  assert.equal(hasMusicIntent({ content: 'https://youtube.com/xxx' }), false);
  assert.equal(hasMusicIntent({ content: '這首歌很好聽' }), false);
  assert.equal(
    hasMusicIntent({
      content: 'hello world',
      client: { user: { id: botId } },
      mentions: new Map(),
    }),
    false
  );
});

function createVoiceChannel({
  permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
  userLimit = 0,
  memberCount = 0,
  channelId = 'voice-1',
} = {}) {
  const allowed = new Set(permissions);

  return {
    id: channelId,
    userLimit,
    members: {
      size: memberCount,
      has: () => false,
    },
    guild: {
      id: 'guild-1',
      members: {
        me: {
          id: 'bot-1',
        },
      },
    },
    permissionsFor: () => ({
      has: (permission) => allowed.has(permission),
    }),
  };
}

test('validateVoiceChannelForPlayback rejects missing voice permissions clearly', () => {
  assert.throws(
    () => validateVoiceChannelForPlayback(createVoiceChannel({ permissions: [PermissionFlagsBits.ViewChannel] })),
    /Connect/
  );

  assert.throws(
    () =>
      validateVoiceChannelForPlayback(
        createVoiceChannel({ permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] })
      ),
    /Speak/
  );
});

test('validateVoiceChannelForPlayback rejects full channels', () => {
  assert.throws(() => validateVoiceChannelForPlayback(createVoiceChannel({ userLimit: 2, memberCount: 2 })), /已滿/);
});
