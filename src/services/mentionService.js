const { generateChatReply } = require('./aiService');
const { WeatherError, getWeather } = require('./weatherService');
const { parseWeatherQuery } = require('../utils/weatherNLP');
const logger = require('../utils/logger');

function createBotMentionPattern(botId) {
  return new RegExp(`<@!?${botId}>`, 'g');
}

function getMentionText(content, botId) {
  const mentionPattern = createBotMentionPattern(botId);

  if (!mentionPattern.test(content)) {
    return null;
  }

  return content.replace(createBotMentionPattern(botId), '').trim();
}

function getAdvice(weather) {
  let advice = [];
  
  if (weather.tempMaxRaw >= 30) {
    advice.push('天氣炎熱，請注意防曬並多補充水分');
  } else if (weather.tempMinRaw <= 15) {
    advice.push('天氣偏冷，出門請記得穿暖一點');
  } else {
    advice.push('溫度舒適，出門可帶件薄外套');
  }

  if (weather.popRaw > 0.4) {
    advice.push('出門建議攜帶雨具');
  } else if (weather.popRaw > 0.1) {
    advice.push('降雨機率不高，但有機會下毛毛雨');
  }

  return advice.join('，') + '。';
}

function formatWeatherReply(weather, timeStr, suggest) {
  let reply = '';
  if (suggest) {
    reply += `我先幫你查${weather.city}的天氣；如果之後 API 支援行政區，可以再精準到該區，或者你可以說${suggest}天氣。\n\n`;
  }

  if (weather.isWeek) {
    reply += `${weather.city}未來一週天氣：\n${weather.weekSummary}`;
    return reply;
  }

  reply += `${weather.city}${timeStr}天氣：\n\n`;
  reply += `天氣狀況：${weather.description}\n`;
  reply += `氣溫：${weather.tempMin} ~ ${weather.tempMax}\n`;
  
  if (weather.pop) {
    reply += `降雨機率：${weather.pop}\n`;
  }
  
  reply += `體感提醒：${getAdvice(weather)}`;
  
  return reply;
}

async function getWeatherMentionReply(userText) {
  const query = parseWeatherQuery(userText);
  if (!query) {
    return null;
  }

  if (query.ambiguous) {
    return `你說的${query.ambiguous}是哪個城市的${query.ambiguous}呢？例如：新竹${query.ambiguous}、台南${query.ambiguous}、嘉義${query.ambiguous}。`;
  }

  if (!query.location) {
    return '你想查哪個城市的明天天氣呢？例如：明天新竹天氣、新北明天天氣。';
  }

  try {
    const weather = await getWeather(query.location, query.time);
    
    const timeLabels = {
      today: '今天',
      tomorrow: '明天',
      day_after_tomorrow: '後天',
      week: '一週',
      weekend: '週末'
    };
    const timeStr = timeLabels[query.time] || '今天';

    return formatWeatherReply(weather, timeStr, query.suggest);
  } catch (error) {
    if (error instanceof WeatherError && error.code === 'missing_api_key') {
      return '小吉有查詢天氣功能，但目前還沒設定 `OPENWEATHER_API_KEY`。請在 `.env` 補上後重新啟動小吉。';
    }

    if (error instanceof WeatherError && error.code === 'unauthorized') {
      return '小吉有查詢天氣功能，但 OpenWeather API key 目前無效或尚未啟用。請確認 `.env` 的 `OPENWEATHER_API_KEY` 是正確 key，儲存後重新啟動小吉。';
    }

    if (error instanceof WeatherError && error.code === 'city_not_found') {
      return '這個地名有點模糊，你可以補上縣市嗎？例如：新北新莊、台南東區。';
    }

    logger.warn(`weather mention failed: ${error?.message || error}`);
    return '我剛剛有抓到地點，但天氣資料查詢失敗。可能是 API 暫時沒有回應，請稍後再試。';
  }
}

function getMentionFallbackReply(userText) {
  logger.info('[HELP_FALLBACK] using mention fallback reply');
  if (!userText) {
    return '小吉在，想問什麼都可以直接說。';
  }

  const normalized = userText.toLowerCase();

  const query = parseWeatherQuery(userText);
  if (query) {
    return '你想查哪個城市的明天天氣呢？例如：明天新竹天氣、新北明天天氣。';
  }

  if (userText.includes('早安') || userText.includes('你好') || normalized.includes('hi')) {
    return '你好，我是小吉。需要指令說明可以輸入 /help。';
  }

  if (userText.includes('幫助') || userText.includes('指令')) {
    return '你可以輸入 /help 查看小吉目前支援的指令，也可以使用 /weather 查詢天氣。';
  }

  return `我收到你的訊息：「${userText}」。`;
}

function splitReply(content, maxLength = 1800) {
  if (content.length <= maxLength) {
    return [content];
  }

  const chunks = [];
  let remaining = content;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);

    if (splitAt < Math.floor(maxLength * 0.6)) {
      splitAt = remaining.lastIndexOf('。', maxLength);
      if (splitAt >= Math.floor(maxLength * 0.6)) {
        splitAt += 1;
      }
    }

    if (splitAt < Math.floor(maxLength * 0.6)) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function replyInChunks(message, content) {
  const [firstChunk, ...restChunks] = splitReply(content);

  await message.reply({
    content: firstChunk,
    allowedMentions: { repliedUser: false },
  });

  for (const chunk of restChunks) {
    await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
  }
}

async function handleMentionMessage(message) {
  const botId = message.client.user?.id;

  if (!botId) {
    return;
  }

  const userText = getMentionText(message.content, botId);

  if (userText === null) {
    return;
  }

  logger.info(`[mention] ${message.author.tag}: ${message.content}`);

  const weatherReply = await getWeatherMentionReply(userText);

  if (weatherReply) {
    await replyInChunks(message, weatherReply);
    return;
  }

  let reply;

  try {
    reply = await generateChatReply({
      userText,
      username: message.author.username,
      channelId: message.channelId,
      guildId: message.guildId,
    });
  } catch (error) {
    logger.error('AI mention reply failed', error);
  }

  await replyInChunks(message, reply || getMentionFallbackReply(userText));
}

module.exports = {
  getMentionFallbackReply,
  getMentionText,
  getWeatherMentionReply,
  handleMentionMessage,
  splitReply,
};
