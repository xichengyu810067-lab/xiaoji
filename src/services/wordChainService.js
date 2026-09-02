const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const {
  claimFeatureOutbox,
  enqueueFeatureOutbox,
  markFeatureOutboxDelivered,
  retryFeatureOutbox,
} = require('./featurePlatformService');
const { wordSet, words } = require('./wordChainLexicon');
const logger = require('../utils/logger');

const FEATURE_KEY = 'word_chain';
const REACTION_EVENT_TYPE = 'discord_reaction';
const REACTION_EMOJI = '✅';
const MAX_ID_LENGTH = 80;
const DEFAULT_SEED = '明白';

class WordChainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WordChainError';
    this.code = code;
  }
}

function requireId(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH) {
    throw new WordChainError('INVALID_ARGUMENT', `${name} is required.`);
  }
  return normalized;
}

function graphemes(value) {
  return Array.from(new Intl.Segmenter('zh-Hant', { granularity: 'grapheme' }).segment(value), ({ segment }) => segment);
}

function validateWord(input) {
  const normalized = String(input ?? '').normalize('NFC').trim();
  const segments = graphemes(normalized);

  if (segments.length < 1 || segments.length > 6) {
    return { ok: false, code: 'INVALID_LENGTH', message: '請輸入 1 到 6 個中文字。' };
  }
  if (!/^\p{Script=Han}+$/u.test(normalized)) {
    return { ok: false, code: 'INVALID_CHARACTERS', message: '文字接龍只接受純中文詞彙喔。' };
  }
  if (!wordSet.has(normalized)) {
    return { ok: false, code: 'UNKNOWN_WORD', message: '這不是小吉詞庫中的完整常用詞，請換一個 2 到 6 字的詞。' };
  }

  return { ok: true, word: normalized, graphemes: segments };
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    channelId: row.channel_id,
    status: row.status,
    currentWord: row.current_word,
    lastWord: row.last_word,
    lastUserId: row.last_user_id || null,
    revision: Number(row.revision),
    startedBy: row.started_by,
    stoppedBy: row.stopped_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stoppedAt: row.stopped_at || null,
  };
}

function selectActiveSession(api, guildId, channelId) {
  return api.get(
    `SELECT * FROM text_chain_sessions
     WHERE guild_id = ? AND channel_id = ? AND status = 'active'
     ORDER BY id DESC LIMIT 1`,
    [guildId, channelId]
  );
}

async function startWordChain({ guildId, channelId, actorId, seed = DEFAULT_SEED, now = new Date() }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedActorId = requireId(actorId, 'actorId');
  const checkedSeed = validateWord(seed);
  if (!checkedSeed.ok) throw new WordChainError(checkedSeed.code, checkedSeed.message);
  const timestamp = new Date(now).toISOString();
  if (Number.isNaN(new Date(timestamp).getTime())) throw new WordChainError('INVALID_ARGUMENT', 'now must be valid.');

  return withCoinTransaction((api) => {
    const existing = selectActiveSession(api, normalizedGuildId, normalizedChannelId);
    if (existing) return { alreadyActive: true, session: mapSession(existing) };

    api.run(
      `INSERT INTO text_chain_sessions
       (guild_id, channel_id, status, current_word, last_word, last_user_id, revision, started_by, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, NULL, 0, ?, ?, ?)`,
      [normalizedGuildId, normalizedChannelId, checkedSeed.word, checkedSeed.word, normalizedActorId, timestamp, timestamp]
    );
    return { alreadyActive: false, session: mapSession(api.get('SELECT * FROM text_chain_sessions WHERE id = last_insert_rowid()')) };
  });
}

async function stopWordChain({ guildId, channelId, actorId, now = new Date() }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedActorId = requireId(actorId, 'actorId');
  const timestamp = new Date(now).toISOString();

  return withCoinTransaction((api) => {
    const session = selectActiveSession(api, normalizedGuildId, normalizedChannelId);
    if (!session) return { stopped: false, session: null };
    api.run(
      `UPDATE text_chain_sessions
       SET status = 'stopped', stopped_by = ?, stopped_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND status = 'active'`,
      [normalizedActorId, timestamp, timestamp, session.id]
    );
    return { stopped: true, session: mapSession(api.get('SELECT * FROM text_chain_sessions WHERE id = ?', [session.id])) };
  });
}

async function getWordChainStatus(guildId, channelId) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  return withCoinDatabase((api) => mapSession(selectActiveSession(api, normalizedGuildId, normalizedChannelId)));
}

async function acceptWordChainMessage({ guildId, channelId, messageId, userId, content, expectedChannelId = channelId, now = new Date() }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedMessageId = requireId(messageId, 'messageId');
  const normalizedUserId = requireId(userId, 'userId');
  const normalizedExpectedChannelId = requireId(expectedChannelId, 'expectedChannelId');
  const checkedWord = validateWord(content);
  const timestamp = new Date(now).toISOString();

  return withCoinTransaction((api) => {
    const duplicate = api.get('SELECT session_id FROM text_chain_entries WHERE message_id = ?', [normalizedMessageId]);
    if (duplicate) return { ok: true, duplicate: true, sessionId: Number(duplicate.session_id) };
    if (normalizedChannelId !== normalizedExpectedChannelId) {
      return { ok: false, code: 'WRONG_CHANNEL', message: '這一局文字接龍不在這個頻道進行喔。' };
    }
    const session = selectActiveSession(api, normalizedGuildId, normalizedChannelId);
    if (!session) {
      const anotherSession = api.get(
        "SELECT id FROM text_chain_sessions WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
        [normalizedGuildId]
      );
      return {
        ok: false,
        code: anotherSession ? 'WRONG_CHANNEL' : 'NO_ACTIVE_SESSION',
        message: anotherSession ? '這一局文字接龍不在這個頻道進行喔。' : '目前沒有進行中的文字接龍。',
      };
    }
    if (!checkedWord.ok) return checkedWord;
    if (session.last_user_id === normalizedUserId) {
      return { ok: false, code: 'SAME_USER', message: '要輪到其他人接詞才行喔。' };
    }
    const expectedFirst = graphemes(session.current_word).at(-1);
    if (checkedWord.graphemes[0] !== expectedFirst) {
      return { ok: false, code: 'CHAIN_MISMATCH', message: `這一輪要從「${expectedFirst}」字開始接喔。` };
    }
    if (api.get('SELECT id FROM text_chain_entries WHERE session_id = ? AND word = ? LIMIT 1', [session.id, checkedWord.word])) {
      return { ok: false, code: 'REPEATED_WORD', message: '這個詞已經接過了，換一個新的詞吧。' };
    }

    api.run(
      `INSERT INTO text_chain_entries (session_id, guild_id, channel_id, message_id, user_id, word, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [session.id, normalizedGuildId, normalizedChannelId, normalizedMessageId, normalizedUserId, checkedWord.word, timestamp]
    );
    api.run(
      `UPDATE text_chain_sessions
       SET current_word = ?, last_word = ?, last_user_id = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND status = 'active'`,
      [checkedWord.word, checkedWord.word, normalizedUserId, timestamp, session.id]
    );
    return {
      ok: true,
      duplicate: false,
      session: mapSession(api.get('SELECT * FROM text_chain_sessions WHERE id = ?', [session.id])),
    };
  });
}

function buildReactionPayload({ guildId, channelId, messageId, emoji = REACTION_EMOJI }) {
  const payload = {
    guildId: requireId(guildId, 'guildId'),
    channelId: requireId(channelId, 'channelId'),
    messageId: requireId(messageId, 'messageId'),
    emoji,
  };
  if (payload.emoji !== REACTION_EMOJI || Buffer.byteLength(JSON.stringify(payload), 'utf8') > 300) {
    throw new WordChainError('INVALID_REACTION_PAYLOAD', 'Invalid word-chain reaction payload.');
  }
  return payload;
}

async function enqueueReaction(message) {
  const payload = buildReactionPayload({ guildId: message.guildId, channelId: message.channelId, messageId: message.id });
  return enqueueFeatureOutbox({
    guildId: payload.guildId,
    featureKey: FEATURE_KEY,
    eventType: REACTION_EVENT_TYPE,
    dedupeKey: `reaction:${payload.messageId}`,
    payload,
  });
}

async function handleWordChainMessage(message, setting) {
  const result = await acceptWordChainMessage({
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author.id,
    content: message.content,
    expectedChannelId: setting.channelId,
  });

  if (result.duplicate) return true;
  if (!result.ok) {
    await message.reply({ content: result.message, allowedMentions: { repliedUser: false } }).catch((error) => {
      logger.warn('文字接龍拒絕訊息回覆失敗', error);
    });
    return true;
  }

  await message.react(REACTION_EMOJI).catch(async (error) => {
    logger.warn('文字接龍確認反應失敗，已加入重試佇列', error);
    await enqueueReaction(message);
  });
  return true;
}

function getRetryDelay(attemptCount) {
  return Math.min(5 * 60 * 1000, 15_000 * 2 ** Math.min(4, Math.max(0, Number(attemptCount) - 1)));
}

async function processWordChainReactionOutbox(client, {
  workerId = `word-chain-reaction:${process.pid}`,
  limit = 20,
  now = new Date(),
  claim = claimFeatureOutbox,
  markDelivered = markFeatureOutboxDelivered,
  retry = retryFeatureOutbox,
} = {}) {
  const events = await claim({ workerId, eventType: REACTION_EVENT_TYPE, limit, now });
  const summary = { claimed: events.length, delivered: 0, retried: 0 };

  for (const event of events) {
    try {
      const payload = buildReactionPayload(event.payload || {});
      if (event.featureKey !== FEATURE_KEY || payload.guildId !== event.guildId) {
        throw new WordChainError('INVALID_REACTION_EVENT', 'Reaction event does not match word-chain ownership.');
      }
      const guild = client?.guilds?.cache?.get(payload.guildId) || (await client?.guilds?.fetch?.(payload.guildId));
      const channel = guild?.channels?.cache?.get(payload.channelId) || (await guild?.channels?.fetch?.(payload.channelId));
      if (!channel?.messages?.fetch) throw new WordChainError('CHANNEL_UNAVAILABLE', 'Discord channel is unavailable.');
      const message = await channel.messages.fetch(payload.messageId);
      await message.react(payload.emoji);
      await markDelivered(event.id, { workerId, now });
      summary.delivered += 1;
    } catch (error) {
      await retry(event.id, { workerId, error, delayMs: getRetryDelay(event.attemptCount), now });
      summary.retried += 1;
    }
  }
  return summary;
}

module.exports = {
  FEATURE_KEY,
  DEFAULT_SEED,
  REACTION_EMOJI,
  REACTION_EVENT_TYPE,
  WordChainError,
  acceptWordChainMessage,
  buildReactionPayload,
  getRetryDelay,
  getWordChainStatus,
  graphemes,
  handleWordChainMessage,
  processWordChainReactionOutbox,
  startWordChain,
  stopWordChain,
  validateWord,
};
