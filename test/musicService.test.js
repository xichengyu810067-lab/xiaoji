const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');
const {
  buildYtdlpStreamArgs,
  extractYouTubeUrl,
  getYoutubeBotCheckMessage,
  hasMusicIntent,
  isYoutubeBotCheckError,
  isYouTubeUrl,
  musicIdleLeaveMs,
  validateVoiceChannelForPlayback,
  ytdlpAudioFormat,
  ytdlpBinaryPath,
} = require('../src/services/musicService');
const musicCommand = require('../src/commands/music');
const { formatQueue } = musicCommand;

test('extractYouTubeUrl finds youtube links in message text', () => {
  assert.equal(
    extractYouTubeUrl('play this https://www.youtube.com/watch?v=dQw4w9WgXcQ please'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );
  assert.equal(extractYouTubeUrl('no link here'), null);
});

test('isYouTubeUrl validates common YouTube video URLs', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), false);
});

test('formatQueue renders current track and queued tracks', () => {
  const output = formatQueue({
    current: { title: 'Current' },
    queue: [{ title: 'Next' }],
  });

  assert.match(output, /Current/);
  assert.match(output, /Next/);
});

test('buildYtdlpStreamArgs streams WebM Opus audio to stdout', () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  assert.deepEqual(buildYtdlpStreamArgs(url), [
    url,
    '--format',
    ytdlpAudioFormat,
    '--output',
    '-',
    '--quiet',
    '--no-warnings',
    '--no-playlist',
  ]);
  assert.match(ytdlpBinaryPath, /yt-dlp(?:\.exe)?$/);
});

test('buildYtdlpStreamArgs adds cookies path from environment', () => {
  const previous = process.env.YTDLP_COOKIES_PATH;
  const cookiesPath = path.join(os.tmpdir(), `xiaoji-cookies-${Date.now()}.txt`);

  try {
    fs.writeFileSync(cookiesPath, '# Netscape HTTP Cookie File\n');
    process.env.YTDLP_COOKIES_PATH = cookiesPath;

    assert.deepEqual(buildYtdlpStreamArgs('https://www.youtube.com/watch?v=dQw4w9WgXcQ').slice(-2), [
      '--cookies',
      cookiesPath,
    ]);
  } finally {
    if (previous === undefined) {
      delete process.env.YTDLP_COOKIES_PATH;
    } else {
      process.env.YTDLP_COOKIES_PATH = previous;
    }

    fs.rmSync(cookiesPath, { force: true });
  }
});

test('youtube bot check errors get a clear user-facing explanation', () => {
  assert.equal(
    isYoutubeBotCheckError("[youtube] Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies"),
    true
  );
  assert.match(getYoutubeBotCheckMessage(), /不是 Discord 語音房權限問題/);
  assert.match(getYoutubeBotCheckMessage(), /YTDLP_COOKIES_PATH/);
});

test('music command exposes leave subcommand', () => {
  const subcommands = musicCommand.data.toJSON().options.map((option) => option.name);

  assert.ok(subcommands.includes('leave'));
});

test('music idle leave timeout is 3 minutes', () => {
  assert.equal(musicIdleLeaveMs, 180000);
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

test('validateVoiceChannelForPlayback rejects full channels and other active voice channel', () => {
  assert.throws(() => validateVoiceChannelForPlayback(createVoiceChannel({ userLimit: 2, memberCount: 2 })), /已滿/);

  assert.throws(
    () =>
      validateVoiceChannelForPlayback(createVoiceChannel({ channelId: 'voice-1' }), {
        existingConnection: { joinConfig: { channelId: 'voice-2' } },
      }),
    /其他語音頻道/
  );
});
