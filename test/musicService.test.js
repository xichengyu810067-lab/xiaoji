const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');
const {
  buildFfmpegTestToneArgs,
  extractYouTubeUrl,
  getMusicErrorLayer,
  hasMusicIntent,
  isYouTubeUrl,
  musicIdleLeaveMs,
  validateVoiceChannelForPlayback,
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

test('validateVoiceChannelForPlayback rejects full channels', () => {
  assert.throws(() => validateVoiceChannelForPlayback(createVoiceChannel({ userLimit: 2, memberCount: 2 })), /已滿/);
});
