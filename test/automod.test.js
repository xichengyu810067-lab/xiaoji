const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultGuildConfig } = require('../src/utils/guildConfig');
const {
  detectAds,
  detectMassMentions,
  getMentionStatsFromContent,
  normalizeMessageContent,
} = require('../src/services/automodService');

function getAutomodConfig() {
  return structuredClone(defaultGuildConfig.automod);
}

test('normalizeMessageContent trims whitespace and normalizes mentions', () => {
  assert.equal(normalizeMessageContent('  Hello   <@123>  '), 'hello @user');
});

test('detectAds blocks Discord invite links', () => {
  const config = getAutomodConfig();
  assert.equal(detectAds('join https://discord.gg/example', config), 'Discord 邀請連結');
});

test('detectAds respects allowed domains', () => {
  const config = getAutomodConfig();
  config.allowDomains = ['example.com'];
  assert.equal(detectAds('免費領 https://example.com/gift', config), null);
});

test('detectMassMentions detects too many user mentions', () => {
  const config = getAutomodConfig();
  const message = {
    content: '<@1> <@2> <@3> <@4> <@5> <@6> <@7>',
  };

  assert.equal(detectMassMentions(message, config), '大量標記 7 個對象');
});

test('getMentionStatsFromContent detects everyone and role mentions', () => {
  assert.deepEqual(getMentionStatsFromContent('@everyone <@&123> <@456>'), {
    userCount: 1,
    roleCount: 1,
    everyoneHere: true,
  });
});
