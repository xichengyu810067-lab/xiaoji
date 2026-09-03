const MAX_WALLET_VALUE = Number.MAX_SAFE_INTEGER;

class CoinWalletError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CoinWalletError';
    this.code = code;
    this.details = details;
  }
}

function requireId(value, fieldName) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 80) {
    throw new CoinWalletError('INVALID_ARGUMENT', `${fieldName} is required.`);
  }
  return normalized;
}

function requireWalletValue(value, fieldName) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > MAX_WALLET_VALUE) {
    throw new CoinWalletError('WALLET_VALUE_OUT_OF_RANGE', `${fieldName} must be a non-negative safe integer.`);
  }
  return normalized;
}

function requireDelta(value, fieldName) {
  const normalized = Number(value || 0);
  if (!Number.isSafeInteger(normalized)) {
    throw new CoinWalletError('WALLET_VALUE_OUT_OF_RANGE', `${fieldName} must be a safe integer.`);
  }
  return normalized;
}

function serializeMetadata(metadata) {
  if (metadata == null) return null;
  return JSON.stringify(metadata);
}

function ensureWalletContext(api, guildId, userId, timestamp = new Date().toISOString()) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedUserId = requireId(userId, 'userId');

  api.run(
    `INSERT INTO coin_wallets (user_id, balance, total_earned, total_spent, revision, created_at, updated_at)
     VALUES (?, 0, 0, 0, 0, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
    [normalizedUserId, timestamp, timestamp]
  );
  api.run(
    `INSERT INTO coin_guild_players
      (guild_id, user_id, bank_balance, bank_interest_accrued, last_interest_date,
       last_daily_date, daily_streak, created_at, updated_at)
     VALUES (?, ?, 0, 0, NULL, NULL, 0, ?, ?)
     ON CONFLICT(guild_id, user_id) DO NOTHING`,
    [normalizedGuildId, normalizedUserId, timestamp, timestamp]
  );

  return { guildId: normalizedGuildId, userId: normalizedUserId };
}

function mapWalletPlayer(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    balance: Number(row.balance),
    bankBalance: Number(row.bank_balance || 0),
    bankInterestAccrued: Number(row.bank_interest_accrued || 0),
    lastInterestDate: row.last_interest_date || null,
    totalEarned: Number(row.total_earned),
    totalSpent: Number(row.total_spent),
    lastDailyDate: row.last_daily_date || null,
    dailyStreak: Number(row.daily_streak || 0),
    revision: Number(row.revision),
    createdAt: row.wallet_created_at || row.created_at,
    updatedAt: row.wallet_updated_at || row.updated_at,
    guildCreatedAt: row.guild_created_at || row.created_at,
    guildUpdatedAt: row.guild_updated_at || row.updated_at,
  };
}

function getWalletPlayerWithApi(api, guildId, userId, { ensure = true, timestamp = new Date().toISOString() } = {}) {
  const ids = ensure
    ? ensureWalletContext(api, guildId, userId, timestamp)
    : { guildId: requireId(guildId, 'guildId'), userId: requireId(userId, 'userId') };
  const row = api.get(
    `SELECT gp.guild_id, gp.user_id,
            w.balance, w.total_earned, w.total_spent, w.revision,
            gp.bank_balance, gp.bank_interest_accrued, gp.last_interest_date,
            gp.last_daily_date, gp.daily_streak,
            w.created_at AS wallet_created_at, w.updated_at AS wallet_updated_at,
            gp.created_at AS guild_created_at, gp.updated_at AS guild_updated_at
     FROM coin_guild_players gp
     JOIN coin_wallets w ON w.user_id = gp.user_id
     WHERE gp.guild_id = ? AND gp.user_id = ?`,
    [ids.guildId, ids.userId]
  );
  return mapWalletPlayer(row);
}

function mutateWalletWithApi(api, input) {
  const timestamp = input.createdAt || new Date().toISOString();
  const player = getWalletPlayerWithApi(api, input.guildId, input.userId, { timestamp });
  const balanceDelta = requireDelta(input.balanceDelta, 'balanceDelta');
  const earnedDelta = requireDelta(input.totalEarnedDelta, 'totalEarnedDelta');
  const spentDelta = requireDelta(input.totalSpentDelta, 'totalSpentDelta');
  const balanceAfter = Object.prototype.hasOwnProperty.call(input, 'balanceTarget')
    ? requireWalletValue(input.balanceTarget, 'balanceTarget')
    : requireWalletValue(player.balance + balanceDelta, 'balanceAfter');
  const totalEarnedAfter = Object.prototype.hasOwnProperty.call(input, 'totalEarnedTarget')
    ? requireWalletValue(input.totalEarnedTarget, 'totalEarnedTarget')
    : requireWalletValue(player.totalEarned + earnedDelta, 'totalEarnedAfter');
  const totalSpentAfter = Object.prototype.hasOwnProperty.call(input, 'totalSpentTarget')
    ? requireWalletValue(input.totalSpentTarget, 'totalSpentTarget')
    : requireWalletValue(player.totalSpent + spentDelta, 'totalSpentAfter');
  const revisionAfter = requireWalletValue(player.revision + 1, 'revisionAfter');
  const amount = balanceAfter - player.balance;

  api.run(
    `UPDATE coin_wallets
     SET balance = ?, total_earned = ?, total_spent = ?, revision = ?, updated_at = ?
     WHERE user_id = ? AND revision = ?`,
    [balanceAfter, totalEarnedAfter, totalSpentAfter, revisionAfter, timestamp, player.userId, player.revision]
  );
  if (Number(api.get('SELECT changes() AS count').count) !== 1) {
    throw new CoinWalletError('WALLET_CONFLICT', 'Wallet revision changed during mutation.');
  }

  api.run(
    `INSERT INTO coin_transactions
      (guild_id, user_id, type, balance_before, amount, balance_after, operator_id,
       reason, metadata, wallet_scope, wallet_revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'global', ?, ?)`,
    [
      player.guildId,
      player.userId,
      String(input.type || 'wallet_adjustment'),
      player.balance,
      amount,
      balanceAfter,
      input.operatorId || null,
      input.reason ? String(input.reason).trim().slice(0, 300) : null,
      serializeMetadata(input.metadata),
      revisionAfter,
      timestamp,
    ]
  );

  return {
    before: player,
    after: getWalletPlayerWithApi(api, player.guildId, player.userId, { ensure: false }),
    amount,
    transactionId: Number(api.get('SELECT last_insert_rowid() AS id').id),
  };
}

module.exports = {
  CoinWalletError,
  MAX_WALLET_VALUE,
  ensureWalletContext,
  getWalletPlayerWithApi,
  mapWalletPlayer,
  mutateWalletWithApi,
};
