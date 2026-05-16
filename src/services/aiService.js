require('dotenv').config({ quiet: true });

const OpenAI = require('openai');
const { tryConsumeGuildQuota } = require('./quotaService');
const logger = require('../utils/logger');

const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const MAX_TURNS_PER_USER = 10;
const MAX_MEMORY_USERS = 500;
const conversationMemory = new Map();

const developerInstructions = [
  'You are Xiaoji, a friendly Discord server assistant. Reply in Traditional Chinese.',
  'You are a casual chat bot. You can answer daily questions, recommend food, music, movies, or just chat normally.',
  'If a user asks for a song recommendation (e.g. "推薦一首歌曲"), just tell them the song and artist. This is a normal chat. Do NOT tell them to use /music unless they specifically ask to play music in a voice channel.',
  'If a user asks you to introduce yourself, just say a friendly hello and a brief description of yourself as Xiaoji.',
  'Do not constantly remind users about slash commands. Only list slash commands if the user explicitly asks for help, asks what commands you have, or tries to use a command via chat.',
  'Xiaoji supports these slash commands: /help, /ping, /status, /about, /fortune, /roll, /weather, /poll, /remind, /calendar, /music, /announce, /autorole, /automod, /config, /export-config, /set-log, /clear, /timeout, /mute, /kick, /ban, /unban, /role-add, /role-remove.',
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
      baseURL: process.env.GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL,
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
  return process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
}

function getMemoryKey({ username, guildId }) {
  const guildPart = guildId || 'dm';
  const userPart = username || 'unknown-user';

  return `${guildPart}:${userPart}`;
}

function deleteOldestMemoryEntry() {
  const oldestKey = conversationMemory.keys().next().value;

  if (oldestKey) {
    conversationMemory.delete(oldestKey);
  }
}

function getRecentTurns(memoryKey) {
  return conversationMemory.get(memoryKey) || [];
}

function rememberTurn(memoryKey, userText, assistantText) {
  if (!conversationMemory.has(memoryKey) && conversationMemory.size >= MAX_MEMORY_USERS) {
    deleteOldestMemoryEntry();
  }

  const turns = getRecentTurns(memoryKey);
  turns.push({
    user: userText,
    assistant: assistantText,
  });

  conversationMemory.set(memoryKey, turns.slice(-MAX_TURNS_PER_USER));
}

function buildConversationInput({ userText, username, channelId, guildId, recentTurns }) {
  const history = recentTurns
    .map((turn, index) => [`Turn ${index + 1}`, `User: ${turn.user}`, `Xiaoji: ${turn.assistant}`].join('\n'))
    .join('\n\n');

  return [
    `Discord username: ${username || 'unknown-user'}`,
    `Discord guildId: ${guildId || 'DM'}`,
    `Discord channelId: ${channelId || 'unknown-channel'}`,
    history ? `Recent conversation:\n${history}` : 'Recent conversation: none',
    `Current user message: ${userText || '(empty mention)'}`,
    'Answer as Xiaoji in Traditional Chinese.',
  ].join('\n\n');
}

function getBriefError(error) {
  const status = error?.status ? `status ${error.status}` : null;
  const code = error?.code ? `code ${error.code}` : null;
  const type = error?.type ? `type ${error.type}` : null;
  const message = String(error?.message || error || 'API error')
    .replace(/\s+/g, ' ')
    .slice(0, 180);

  return [status, code, type, message].filter(Boolean).join('; ');
}

function logProviderError(provider, error) {
  logger.warn(`[API_ERROR] [${provider}] AI reply failed; using keyword fallback. ${getBriefError(error)}`);
}

async function generateGroqReply(context) {
  const groq = getGroqClient();

  if (!groq) {
    return null;
  }

  try {
    const response = await groq.chat.completions.create({
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
      max_tokens: 500,
      temperature: 0.8,
    });

    const reply = response.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      logger.warn('[PARSE_ERROR] Groq chat completion returned an empty reply.');
      throw new Error('Groq chat completion returned an empty reply.');
    }

    return reply;
  } catch (error) {
    logProviderError('groq', error);
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

async function generateChatReply({ userText, username, channelId, guildId }) {
  const quota = tryConsumeGuildQuota(guildId);

  if (!quota.ok) {
    logger.info('[QUOTA_BLOCK] quota exhausted for guild ' + guildId);
    return quota.message;
  }

  const memoryKey = getMemoryKey({ username, guildId });
  const context = {
    userText,
    username,
    channelId,
    guildId,
    recentTurns: getRecentTurns(memoryKey),
  };

  const reply = process.env.GROQ_API_KEY ? await generateGroqReply(context) : await generateOpenAIReply(context);

  if (!reply) {
    return null;
  }

  rememberTurn(memoryKey, userText || '', reply);
  
  logger.info('[NORMAL_CHAT] Generated chat reply.');

  return reply;
}

module.exports = {
  buildConversationInput,
  developerInstructions,
  generateChatReply,
};
