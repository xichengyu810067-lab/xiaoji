const TIME_WORDS = {
  今天: 'today',
  今日: 'today',
  現在: 'today',
  目前: 'today',
  明天: 'tomorrow',
  明日: 'tomorrow',
  後天: 'day_after_tomorrow',
  這週: 'week',
  這周: 'week',
  本週: 'week',
  本周: 'week',
  一週: 'week',
  一周: 'week',
  未來一週: 'week',
  未來一周: 'week',
  七天: 'week',
  '7天': 'week',
  週末: 'weekend',
  周末: 'weekend',
};

const CITY_ALIASES = {
  台北: '臺北市',
  臺北: '臺北市',
  新北: '新北市',
  桃園: '桃園市',
  新竹: '新竹市',
  苗栗: '苗栗縣',
  台中: '臺中市',
  臺中: '臺中市',
  彰化: '彰化縣',
  南投: '南投縣',
  雲林: '雲林縣',
  嘉義: '嘉義市',
  台南: '臺南市',
  臺南: '臺南市',
  高雄: '高雄市',
  屏東: '屏東縣',
  宜蘭: '宜蘭縣',
  花蓮: '花蓮縣',
  台東: '臺東縣',
  臺東: '臺東縣',
  澎湖: '澎湖縣',
  金門: '金門縣',
  連江: '連江縣',
};

const DISTRICT_MAPPING = {
  新莊: '新北市新莊區',
  板橋: '新北市板橋區',
  中和: '新北市中和區',
  永和: '新北市永和區',
  三重: '新北市三重區',
  土城: '新北市土城區',
  淡水: '新北市淡水區',
  竹北: '新竹縣竹北市',
  中壢: '桃園市中壢區',
  內壢: '桃園市中壢區',
  士林: '臺北市士林區',
  信義: '臺北市信義區',
  左營: '高雄市左營區',
  鳳山: '高雄市鳳山區',
  東區: 'AMBIGUOUS_EAST_DISTRICT',
};

const WEATHER_KEYWORDS = [
  '天氣', '氣溫', '溫度', 'weather', '會不會下雨', '會下雨嗎', '下雨嗎', '下雨',
  '熱不熱', '冷不冷', '會不會冷', '會不會熱', '有沒有下雨', '雨天', '晴天', '陰天',
  '一週天氣', '一周天氣', '未來一週', '未來一周', '明天天氣', '今天氣象', '氣象', '降雨', '雨',
  '幫我查', '幫我看一下', '幫我看', '查一下', '查詢', '看看', '看一下', '請幫我', '請問'
];

function parseWeatherQuery(text) {
  let time = 'today';
  let location = '';
  let ambiguous = null;
  let suggest = null;

  const isWeatherIntent = WEATHER_KEYWORDS.some(kw => text.toLowerCase().includes(kw)) || text.includes('天氣') || text.includes('氣象');
  if (!isWeatherIntent) return null;

  let cleanedText = text;
  // Use sorting to replace longer time words first (e.g. 未來一週 vs 一週)
  const sortedTimeWords = Object.keys(TIME_WORDS).sort((a, b) => b.length - a.length);
  for (const word of sortedTimeWords) {
    if (cleanedText.includes(word)) {
      time = TIME_WORDS[word];
      cleanedText = cleanedText.replace(new RegExp(word, 'g'), ' ');
      break;
    }
  }

  const stopWords = ['的', '嗎', '呢', '會不會', '會', '有', '沒有', '如何', ...WEATHER_KEYWORDS];
  stopWords.sort((a, b) => b.length - a.length);

  for (const word of stopWords) {
    cleanedText = cleanedText.replace(new RegExp(word, 'gi'), ' ');
  }

  location = cleanedText.replace(/\s+/g, '').trim();

  for (const [alias, formal] of Object.entries(CITY_ALIASES)) {
    if (location.startsWith(alias) && location.length > alias.length) {
      let dist = location.slice(alias.length);
      if (dist === '東區') {
        location = formal + '東區';
      } else if (DISTRICT_MAPPING[dist]) {
        location = DISTRICT_MAPPING[dist];
      } else if (dist.endsWith('區') || dist.endsWith('市')) {
        location = formal + dist;
      } else {
        // Guess it's a district without the suffix
        location = formal + dist + (dist === '竹北' ? '市' : '區');
      }
      break;
    }
  }

  for (const formal of Object.values(CITY_ALIASES)) {
    if (location.startsWith(formal) && location.length > formal.length) {
      let dist = location.slice(formal.length);
      if (dist === '東區') {
        location = formal + '東區';
      } else if (DISTRICT_MAPPING[dist]) {
        location = DISTRICT_MAPPING[dist];
      } else if (dist.endsWith('區') || dist.endsWith('市')) {
        location = formal + dist;
      } else {
        location = formal + dist + (dist === '竹北' ? '市' : '區');
      }
      break;
    }
  }

  if (location === '東區') {
    ambiguous = '東區';
  } else if (DISTRICT_MAPPING[location]) {
    location = DISTRICT_MAPPING[location];
  } else if (CITY_ALIASES[location]) {
    location = CITY_ALIASES[location];
    if (text.includes('新竹') && location === '新竹市') suggest = '新竹縣';
    if (text.includes('嘉義') && location === '嘉義市') suggest = '嘉義縣';
  }

  return { time, location, ambiguous, suggest };
}

module.exports = {
  parseWeatherQuery,
};