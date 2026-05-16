const test = require('node:test');
const assert = require('node:assert/strict');
const { getMentionFallbackReply } = require('../src/services/mentionService');
const { developerInstructions } = require('../src/services/aiService');
const { parseWeatherQuery } = require('../src/utils/weatherNLP');

test('AI instructions know Xiaoji has weather command', () => {
  assert.match(developerInstructions, /\/weather/);
  assert.match(developerInstructions, /Never say Xiaoji has no weather feature/);
});

test('mention fallback gives weather prompt when weather is queried', () => {
  const reply = getMentionFallbackReply('你有查詢天氣功能嗎');
  assert.match(reply, /你想查哪個城市的明天天氣呢/);
});

test('mention fallback gives help prompt when asked for help', () => {
  const reply = getMentionFallbackReply('幫助');
  assert.match(reply, /\/weather/);
});

test('parseWeatherQuery recognizes time and location', () => {
  assert.deepEqual(parseWeatherQuery('幫我查明天新竹的天氣'), {
    time: 'tomorrow',
    location: '新竹市',
    ambiguous: null,
    suggest: '新竹縣'
  });
  
  assert.deepEqual(parseWeatherQuery('這週台北天氣如何'), {
    time: 'week',
    location: '臺北市',
    ambiguous: null,
    suggest: null
  });

  assert.deepEqual(parseWeatherQuery('東區天氣'), {
    time: 'today',
    location: '東區',
    ambiguous: '東區',
    suggest: null
  });
});
