const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConversationInput, getMemoryKey } = require('../src/services/aiService');

test('AI short-term memory key is isolated by Discord user ID before username', () => {
  assert.equal(getMemoryKey({ guildId: 'guild-1', userId: 'user-1', username: 'same-name' }), 'guild-1:user-1');
  assert.equal(getMemoryKey({ guildId: 'guild-1', userId: 'user-2', username: 'same-name' }), 'guild-1:user-2');
});

test('AI conversation input includes Discord user ID for provider context', () => {
  const input = buildConversationInput({
    userText: '你好',
    username: 'same-name',
    userId: 'user-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    recentTurns: [],
  });

  assert.match(input, /Discord username: same-name/);
  assert.match(input, /Discord userId: user-1/);
});
