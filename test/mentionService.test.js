const test = require('node:test');
const assert = require('node:assert/strict');
const { getExplicitCallText, getMentionFallbackReply } = require('../src/services/mentionService');
const { developerInstructions } = require('../src/services/aiService');
const { parseWeatherQuery, normalizeWeatherCommandLocation } = require('../src/utils/weatherNLP');

test('AI instructions know Xiaoji has weather command', () => {
  assert.match(developerInstructions, /\/weather/);
  assert.match(developerInstructions, /Never say Xiaoji has no weather feature/);
});

test('mention fallback gives weather prompt when weather is queried', () => {
  const reply = getMentionFallbackReply('你有查詢天氣功能嗎');
  assert.match(reply, /你想查哪裡的天氣呢/);
});

test('mention fallback gives help prompt when asked for help', () => {
  const reply = getMentionFallbackReply('幫助');
  assert.match(reply, /\/weather/);
});

test('explicit Xiaoji call is parsed without a Discord mention', () => {
  assert.equal(getExplicitCallText('小吉 晚安'), '晚安');
  assert.equal(getExplicitCallText('小吉：你在嗎'), '你在嗎');
  assert.equal(getExplicitCallText('今天小吉好忙'), null);
});

test('parseWeatherQuery resolves city before district for natural language weather', () => {
  const cases = [
    ['臺北市大同區天氣', '臺北市', '大同區', '臺北市大同區'],
    ['台北市大同區天氣', '臺北市', '大同區', '臺北市大同區'],
    ['台北 大同區 天氣', '臺北市', '大同區', '臺北市大同區'],
    ['臺北大同天氣', '臺北市', '大同區', '臺北市大同區'],
    ['台北大同天氣', '臺北市', '大同區', '臺北市大同區'],
    ['新北市新莊區天氣', '新北市', '新莊區', '新北市新莊區'],
    ['新北新莊天氣', '新北市', '新莊區', '新北市新莊區'],
    ['台南市東區天氣', '臺南市', '東區', '臺南市東區'],
    ['臺南市東區天氣', '臺南市', '東區', '臺南市東區'],
    ['台南東區天氣', '臺南市', '東區', '臺南市東區'],
    ['台中市西屯區天氣', '臺中市', '西屯區', '臺中市西屯區'],
    ['臺中西屯天氣', '臺中市', '西屯區', '臺中市西屯區'],
  ];

  for (const [input, city, district, location] of cases) {
    const query = parseWeatherQuery(input);
    assert.equal(query.city, city, input);
    assert.equal(query.district, district, input);
    assert.equal(query.location, location, input);
    assert.equal(query.ambiguous, null, input);
    assert.equal(query.debug.cleaned.includes('天氣'), false, input);
  }
});

test('parseWeatherQuery keeps district-only repeated names ambiguous', () => {
  for (const input of ['東區天氣', '北區天氣', '中正區天氣', '大同區天氣']) {
    const query = parseWeatherQuery(input);
    assert.ok(query.ambiguous, input);
    assert.ok(query.candidates.length > 1, input);
  }
});

test('slash weather uses the same location normalization as mention weather', () => {
  const natural = parseWeatherQuery('台北 大同區 天氣');
  const slash = normalizeWeatherCommandLocation('台北 大同區');

  assert.equal(natural.location, slash.location);
  assert.equal(natural.city, slash.city);
  assert.equal(natural.district, slash.district);
  assert.equal(natural.apiLocation, slash.apiLocation);
});
