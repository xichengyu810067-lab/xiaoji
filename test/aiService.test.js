const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_GROQ_MODEL,
  buildConversationInput,
  buildGroqCompletionRequest,
  developerInstructions,
  generateGroqReply,
  getGroqBaseUrl,
  getGroqModel,
  getMemoryKey,
} = require('../src/services/aiService');

test('AI short-term memory key is isolated by Discord user ID before username', () => {
  assert.equal(
    getMemoryKey({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1', username: 'same-name' }),
    'guild-1:channel-1:user-1'
  );
  assert.equal(
    getMemoryKey({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-2', username: 'same-name' }),
    'guild-1:channel-1:user-2'
  );
  assert.notEqual(
    getMemoryKey({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }),
    getMemoryKey({ guildId: 'guild-1', channelId: 'channel-2', userId: 'user-1' })
  );
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

test('Groq uses the fixed GPT OSS 120B chat completions contract', () => {
  const previousModel = process.env.GROQ_MODEL;
  const previousBaseUrl = process.env.GROQ_BASE_URL;

  try {
    process.env.GROQ_MODEL = 'retired-deployment-override';
    process.env.GROQ_BASE_URL = 'https://untrusted.invalid/v1';

    const request = buildGroqCompletionRequest({
      userText: '你好',
      username: 'user',
      userId: 'user-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      recentTurns: [],
    });

    assert.equal(DEFAULT_GROQ_MODEL, 'openai/gpt-oss-120b');
    assert.equal(getGroqModel(), DEFAULT_GROQ_MODEL);
    assert.equal(DEFAULT_GROQ_BASE_URL, 'https://api.groq.com/openai/v1');
    assert.equal(getGroqBaseUrl(), DEFAULT_GROQ_BASE_URL);
    assert.equal(request.model, DEFAULT_GROQ_MODEL);
    assert.equal(request.max_completion_tokens, 500);
    assert.equal(request.max_tokens, undefined);
    assert.equal(request.temperature, 0.8);
    assert.deepEqual(request.messages.map((message) => message.role), ['system', 'user']);
    assert.doesNotMatch(developerInstructions, /\/music(?:\b|,)/);
  } finally {
    if (previousModel === undefined) delete process.env.GROQ_MODEL;
    else process.env.GROQ_MODEL = previousModel;
    if (previousBaseUrl === undefined) delete process.env.GROQ_BASE_URL;
    else process.env.GROQ_BASE_URL = previousBaseUrl;
  }
});

test('Groq errors fail closed without logging API secrets', async () => {
  const previousKey = process.env.GROQ_API_KEY;
  const secret = 'synthetic-test-secret-should-never-leak';
  const warnings = [];

  try {
    process.env.GROQ_API_KEY = secret;
    const result = await generateGroqReply(
      {
        userText: '你好',
        username: 'user',
        userId: 'user-1',
        guildId: 'guild-1',
        channelId: 'channel-1',
        recentTurns: [],
      },
      {
        client: {
          chat: {
            completions: {
              create: async () => {
                throw new Error(`request failed with Bearer ${secret} and token=${secret}`);
              },
            },
          },
        },
        loggerImpl: { warn: (message) => warnings.push(message) },
      }
    );

    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], new RegExp(secret));
    assert.match(warnings[0], /\[REDACTED\]/);
    assert.match(warnings[0], /using keyword fallback/);
  } finally {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
  }
});

test('retired Groq model identifier is absent from tracked release sources', () => {
  const root = path.resolve(__dirname, '..');
  const retiredIdentifier = ['llama-3.3', '70b-versatile'].join('-');
  const trackedTextFiles = [
    '.env.example',
    'README.md',
    'src/services/aiService.js',
    'scripts/check-project.js',
  ];

  for (const relativePath of trackedTextFiles) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, relativePath), 'utf8'), new RegExp(retiredIdentifier));
  }
});
