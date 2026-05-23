const test = require('node:test');
const assert = require('node:assert/strict');
const {
  answerMemoryQuery,
  clearMemoryForTests,
  recordPrivateInteraction,
  recordPublicMessage,
} = require('../src/services/memoryService');

function createMessage({ guildId = 'guild-1', channelId = 'channel-1', userId, username, displayName, content }) {
  return {
    guildId,
    channelId,
    content,
    createdTimestamp: Date.now(),
    author: {
      id: userId,
      username,
      tag: `${username}#0000`,
      bot: false,
    },
    member: {
      displayName,
    },
  };
}

function createQueryMessage({ userId = 'user-2', username = 'sister', displayName = '妹妹', content = '' } = {}) {
  return createMessage({ userId, username, displayName, content });
}

test('self memory query can use the requester private memory', () => {
  clearMemoryForTests();
  recordPrivateInteraction({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    displayName: '哥哥',
    userText: '晚安',
    assistantText: '晚安呀',
  });

  const reply = answerMemoryQuery({
    text: '我剛剛有沒有說晚安？',
    message: createQueryMessage({ userId: 'user-1', username: 'brother', displayName: '哥哥' }),
  });

  assert.match(reply, /有喔/);
  assert.match(reply, /晚安/);
});

test('another user can find public same-channel memory by display name', () => {
  clearMemoryForTests();
  recordPublicMessage(
    createMessage({
      userId: 'user-1',
      username: 'brother',
      displayName: '哥哥',
      content: '<@123> 晚安',
    })
  );

  const reply = answerMemoryQuery({
    text: '哥哥剛剛有沒有說晚安？',
    message: createQueryMessage(),
  });

  assert.match(reply, /哥哥/);
  assert.match(reply, /說過晚安/);
});

test('private memory about another user is not disclosed', () => {
  clearMemoryForTests();
  recordPrivateInteraction({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    displayName: '哥哥',
    userText: '秘密',
    assistantText: '我知道了',
  });

  const reply = answerMemoryQuery({
    text: '哥哥私下跟你說了什麼？',
    message: createQueryMessage(),
  });

  assert.match(reply, /私人對話/);
  assert.doesNotMatch(reply, /秘密/);
});

test('another user gets privacy response when only private target memory matches', () => {
  clearMemoryForTests();
  recordPrivateInteraction({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    displayName: '哥哥',
    userText: '晚安',
    assistantText: '晚安呀',
  });

  const reply = answerMemoryQuery({
    text: '哥哥剛剛有沒有說晚安？',
    message: createQueryMessage(),
  });

  assert.match(reply, /私人對話/);
  assert.doesNotMatch(reply, /晚安呀/);
});

test('unknown public memory query avoids definitive denial', () => {
  clearMemoryForTests();

  const reply = answerMemoryQuery({
    text: '剛剛有人說晚安嗎？',
    message: createQueryMessage(),
  });

  assert.match(reply, /目前沒有在可查的公開紀錄中找到/);
  assert.doesNotMatch(reply, /沒有人說過/);
});
