const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildYtdlpStreamArgs,
  extractYouTubeUrl,
  hasMusicIntent,
  isYouTubeUrl,
  musicIdleLeaveMs,
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
