const DEFAULT_TTL_MS = 8 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 3000;
const DEFAULT_MAX_MESSAGE_LENGTH = 1500;

const activeConversations = new Map();
const cooldowns = new Map();

const stopPhrases = ['小吉閉嘴', '結束對話', '不用回了'];

function getConversationKey({ guildId, channelId, userId }) {
  return `${guildId || 'dm'}:${channelId || 'unknown-channel'}:${userId || 'unknown-user'}`;
}

function nowMs(now = Date.now()) {
  return typeof now === 'number' ? now : Date.now();
}

function normalizeContent(content) {
  return String(content || '').trim();
}

function isStopConversationCommand(content) {
  const normalized = normalizeContent(content);
  return stopPhrases.some((phrase) => normalized.includes(phrase));
}

function startConversation(message, now = Date.now()) {
  const key = getConversationKey({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author?.id,
  });

  activeConversations.set(key, {
    guildId: message.guildId || null,
    channelId: message.channelId || null,
    userId: message.author?.id || null,
    expiresAt: nowMs(now) + DEFAULT_TTL_MS,
    updatedAt: new Date(nowMs(now)).toISOString(),
  });

  return activeConversations.get(key);
}

function endConversation(message) {
  const key = getConversationKey({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author?.id,
  });

  activeConversations.delete(key);
}

function getActiveConversation(message, now = Date.now()) {
  const key = getConversationKey({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author?.id,
  });
  const session = activeConversations.get(key);

  if (!session) {
    return null;
  }

  if (session.expiresAt <= nowMs(now)) {
    activeConversations.delete(key);
    return null;
  }

  return session;
}

function refreshConversation(message, now = Date.now()) {
  const session = getActiveConversation(message, now);

  if (!session) {
    return null;
  }

  session.expiresAt = nowMs(now) + DEFAULT_TTL_MS;
  session.updatedAt = new Date(nowMs(now)).toISOString();
  return session;
}

function hasActiveConversation(message, now = Date.now()) {
  return Boolean(getActiveConversation(message, now));
}

function isLikelyAddressedElsewhere(content) {
  const normalized = normalizeContent(content);

  if (!normalized) {
    return true;
  }

  return /^<@!?\d+>/.test(normalized) || /^<@&\d+>/.test(normalized) || /^@(?:everyone|here)\b/i.test(normalized);
}

function validateChatInput(content) {
  const normalized = normalizeContent(content);

  if (!normalized) {
    return { ok: false, reason: 'empty' };
  }

  if (normalized.length > DEFAULT_MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      reason: 'too_long',
      message: `這段訊息太長了，小吉一次最多先看 ${DEFAULT_MAX_MESSAGE_LENGTH} 個字，幫我縮短一點再說喔。`,
    };
  }

  if (isLikelyAddressedElsewhere(normalized)) {
    return { ok: false, reason: 'addressed_elsewhere' };
  }

  return { ok: true };
}

function checkCooldown(message, now = Date.now()) {
  const key = getConversationKey({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author?.id,
  });
  const current = nowMs(now);
  const lastTriggeredAt = cooldowns.get(key);

  if (lastTriggeredAt !== undefined && current - lastTriggeredAt < DEFAULT_COOLDOWN_MS) {
    return {
      ok: false,
      remainingMs: DEFAULT_COOLDOWN_MS - (current - lastTriggeredAt),
    };
  }

  cooldowns.set(key, current);
  return { ok: true };
}

function clearConversationStateForTests() {
  activeConversations.clear();
  cooldowns.clear();
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_TTL_MS,
  checkCooldown,
  clearConversationStateForTests,
  endConversation,
  getConversationKey,
  hasActiveConversation,
  isLikelyAddressedElsewhere,
  isStopConversationCommand,
  refreshConversation,
  startConversation,
  validateChatInput,
};
