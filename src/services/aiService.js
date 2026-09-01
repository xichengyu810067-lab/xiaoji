require('dotenv').config({ quiet: true });

const OpenAI = require('openai');
const logger = require('../utils/logger');
const {
  getConversationKey,
  getRecentConversationTurns,
  rememberConversationTurn,
} = require('./conversationHistoryService');

const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

const developerInstructions = [
  'You are Xiaoji, a friendly Discord server assistant. Reply in Traditional Chinese.',
  'You are a casual chat bot. You can answer daily questions, recommend food, music, movies, or just chat normally.',
  'If a user asks for a song recommendation (e.g. "推薦一首歌曲"), just tell them the song and artist. Music playback is not a public feature in version 1.0.0.',
  'If a user asks you to introduce yourself, just say a friendly hello and a brief description of yourself as Xiaoji.',
  'Do not constantly remind users about slash commands. Only list slash commands if the user explicitly asks for help, asks what commands you have, or tries to use a command via chat.',
  'Xiaoji supports these public slash commands: /help, /ping, /status, /about, /fortune, /roll, /weather, /poll, /remind, /calendar, /coins, /daily, /leaderboard, /shop, /buy, /inventory, /bank, /exchange, /casino-lobby, /duel-tower, /casino, /casino-venue, /luxury, /pawn, /work, /announce, /autorole, /automod, /config, /export-config, /set-log, /set-welcome, /clear, /timeout, /mute, /kick, /ban, /unban, /role-add, /role-remove.',
  'If a user asks whether Xiaoji can check weather, say yes and tell them to use /weather city:<city>.',
  'Never say Xiaoji has no weather feature. If OPENWEATHER_API_KEY is missing, explain that the owner must configure it.',
  'If a user asks Xiaoji to create a poll, tell them to use /poll question:<question> option1:<option> option2:<option>.',
  'Never reveal or ask for Discord tokens, API keys, or other secrets.',
].join('\n');

let openaiClient;
let groqClient;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey,
      maxRetries: 1,
      timeout: 15000,
    });
  }

  return openaiClient;
}

function getGroqClient() {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return null;
  }

  if (!groqClient) {
    groqClient = new OpenAI({
      apiKey,
      baseURL: getGroqBaseUrl(),
      maxRetries: 1,
      timeout: 15000,
    });
  }

  return groqClient;
}

function getOpenAIModel() {
  return process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
}

function getGroqModel() {
  // Pin the model so a stale deployment override cannot re-enable a retired model.
  return DEFAULT_GROQ_MODEL;
}

function getGroqBaseUrl() {
  // Never send the Groq API key to a deployment-provided third-party endpoint.
  return DEFAULT_GROQ_BASE_URL;
}

function getMemoryKey(identity) {
  return getConversationKey(identity);
}

function buildConversationInput({ userText, username, userId, channelId, guildId, recentTurns }) {
  const history = recentTurns
    .map((turn, index) => [`Turn ${index + 1}`, `User: ${turn.user}`, `Xiaoji: ${turn.assistant}`].join('\n'))
    .join('\n\n');

  return [
    `Discord username: ${username || 'unknown-user'}`,
    `Discord userId: ${userId || 'unknown-user-id'}`,
    `Discord guildId: ${guildId || 'DM'}`,
    `Discord channelId: ${channelId || 'unknown-channel'}`,
    history ? `Recent conversation:\n${history}` : 'Recent conversation: none',
    `Current user message: ${userText || '(empty mention)'}`,
    'Answer as Xiaoji in Traditional Chinese.',
  ].join('\n\n');
}

function redactSecrets(value) {
  let text = String(value ?? '');
  const secrets = [process.env.GROQ_API_KEY, process.env.OPENAI_API_KEY, process.env.DISCORD_TOKEN]
    .map((secret) => String(secret || '').trim())
    .filter(Boolean);

  for (const secret of secrets) {
    text = text.split(secret).join('[REDACTED]');
  }

  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gsk|sk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/([?&](?:api_?key|token)=)[^&\s]+/gi, '$1[REDACTED]');
}

function getBriefError(error) {
  const status = error?.status ? `status ${error.status}` : null;
  const code = error?.code ? `code ${error.code}` : null;
  const type = error?.type ? `type ${error.type}` : null;
  const message = redactSecrets(error?.message || error || 'API error')
    .replace(/\s+/g, ' ')
    .slice(0, 180);

  return [status, code, type, message].filter(Boolean).join('; ');
}

function logProviderError(provider, error, loggerImpl = logger) {
  loggerImpl.warn(`[API_ERROR] [${provider}] AI reply failed; using keyword fallback. ${getBriefError(error)}`);
}

function buildGroqCompletionRequest(context) {
  return {
    model: getGroqModel(),
    messages: [
      {
        role: 'system',
        content: developerInstructions,
      },
      {
        role: 'user',
        content: buildConversationInput(context),
      },
    ],
    max_completion_tokens: 500,
    temperature: 0.8,
  };
}

async function generateGroqReply(context, { client, loggerImpl = logger } = {}) {
  const groq = client === undefined ? getGroqClient() : client;

  if (!groq) {
    return null;
  }

  try {
    const response = await groq.chat.completions.create(buildGroqCompletionRequest(context));

    const reply = response.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      logger.warn('[PARSE_ERROR] Groq chat completion returned an empty reply.');
      throw new Error('Groq chat completion returned an empty reply.');
    }

    return reply;
  } catch (error) {
    logProviderError('groq', error, loggerImpl);
    return null;
  }
}

async function generateOpenAIReply(context) {
  const openai = getOpenAIClient();

  if (!openai) {
    return null;
  }

  try {
    const response = await openai.responses.create({
      model: getOpenAIModel(),
      instructions: developerInstructions,
      input: buildConversationInput(context),
      max_output_tokens: 500,
    });

    const reply = response.output_text?.trim();

    if (!reply) {
      logger.warn('[PARSE_ERROR] OpenAI Responses API returned an empty reply.');
      throw new Error('OpenAI Responses API returned an empty reply.');
    }

    return reply;
  } catch (error) {
    logProviderError('openai', error);
    return null;
  }
}

async function generateChatReply({ userText, username, userId, channelId, guildId }) {
  const identity = { userId, username, guildId, channelId };
  const context = {
    userText,
    username,
    userId,
    channelId,
    guildId,
    recentTurns: getRecentConversationTurns(identity),
  };

  const reply = process.env.GROQ_API_KEY ? await generateGroqReply(context) : await generateOpenAIReply(context);

  if (!reply) {
    return null;
  }

  const persistence = await rememberConversationTurn(identity, userText || '', reply);
  if (!persistence.persisted) {
    logger.warn(`[NORMAL_CHAT] Reply generated but recent conversation was not persisted: ${persistence.reason}`);
  }
  
  logger.info('[NORMAL_CHAT] Generated chat reply.');

  return reply;
}

module.exports = {
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_GROQ_MODEL,
  buildGroqCompletionRequest,
  buildConversationInput,
  developerInstructions,
  generateChatReply,
  generateGroqReply,
  getBriefError,
  getGroqBaseUrl,
  getGroqModel,
  getMemoryKey,
};
