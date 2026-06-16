const test = require('node:test');
const assert = require('node:assert/strict');
const { formatConfig } = require('../src/commands/config');
const { normalizeGuildConfig } = require('../src/utils/guildConfig');

test('normalizeGuildConfig includes new saved config defaults', () => {
  const config = normalizeGuildConfig({});

  assert.equal(config.logChannelId, null);
  assert.equal(config.welcomeChannelId, null);
  assert.equal(config.weatherDefaultCity, null);
  assert.equal(config.announce.allowMentions, false);
  assert.equal(config.memory.sharePublicAcrossChannels, false);
  assert.equal(config.automod.enabled, false);
});

test('formatConfig renders requested config keys', () => {
  const output = formatConfig(
    normalizeGuildConfig({
      logChannelId: '123',
      welcomeChannelId: '456',
      weatherDefaultCity: 'Taipei',
      announce: { allowMentions: true },
      automod: { enabled: true, spam: { enabled: true } },
    })
  );

  assert.match(output, /log_channel/);
  assert.match(output, /welcome_channel: <#456>/);
  assert.match(output, /anti_spam_enabled: true/);
  assert.match(output, /weather_default_city: Taipei/);
  assert.match(output, /announce_allow_mentions: true/);
});
