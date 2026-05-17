const { withCoinTransaction, withCoinDatabase } = require('./coinDatabase');
const {
  CoinServiceError,
  TransactionType,
  ensureGuildSettings,
  ensurePlayer,
  nowIso,
  getLocalDate,
  insertTransaction,
} = require('./coinService');
const logger = require('../utils/logger');

const INTEREST_RATE = 0.0003; // 0.03%
const INTEREST_TIME_TW = '23:00';

/**
 * Get the Taiwan time interest date for a given real date.
 * If it's before 23:00, the "interest date" is today.
 * If it's after 23:00, it might already be processed.
 * Actually, we just need the date string "YYYY-MM-DD" to mark if interest was paid for that day.
 */
function getInterestDate(date = new Date()) {
  return getLocalDate(date);
}

async function deposit(guildId, userId, amount) {
  return withCoinTransaction(async (api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
    }

    const val = Number(amount);
    if (!Number.isSafeInteger(val) || val <= 0) {
      throw new CoinServiceError('INVALID_AMOUNT', '存款金額必須是正整數。');
    }

    const player = ensurePlayer(api, guildId, userId);
    if (player.balance < val) {
      throw new CoinServiceError('INSUFFICIENT_FUNDS', '錢包餘額不足。', {
        balance: player.balance,
        required: val,
      });
    }

    const timestamp = nowIso();
    const newBalance = player.balance - val;
    const newBankBalance = player.bankBalance + val;

    api.run(
      'UPDATE coin_players SET balance = ?, bank_balance = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
      [newBalance, newBankBalance, timestamp, guildId, userId]
    );

    insertTransaction(api, {
      guildId,
      userId,
      type: TransactionType.BANK_DEPOSIT,
      balanceBefore: player.balance,
      amount: -val,
      balanceAfter: newBalance,
      operatorId: null,
      reason: '銀行存款',
      metadata: { bankBalanceBefore: player.bankBalance, bankBalanceAfter: newBankBalance },
      createdAt: timestamp,
    });

    return {
      walletBefore: player.balance,
      walletAfter: newBalance,
      bankBefore: player.bankBalance,
      bankAfter: newBankBalance,
    };
  });
}

async function withdraw(guildId, userId, amount) {
  return withCoinTransaction(async (api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
    }

    const val = Number(amount);
    if (!Number.isSafeInteger(val) || val <= 0) {
      throw new CoinServiceError('INVALID_AMOUNT', '提款金額必須是正整數。');
    }

    const player = ensurePlayer(api, guildId, userId);
    if (player.bankBalance < val) {
      throw new CoinServiceError('INSUFFICIENT_BANK_FUNDS', '銀行存款不足。', {
        bankBalance: player.bankBalance,
        required: val,
      });
    }

    const timestamp = nowIso();
    const newBalance = player.balance + val;
    const newBankBalance = player.bankBalance - val;

    api.run(
      'UPDATE coin_players SET balance = ?, bank_balance = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
      [newBalance, newBankBalance, timestamp, guildId, userId]
    );

    insertTransaction(api, {
      guildId,
      userId,
      type: TransactionType.BANK_WITHDRAW,
      balanceBefore: player.balance,
      amount: val,
      balanceAfter: newBalance,
      operatorId: null,
      reason: '銀行提款',
      metadata: { bankBalanceBefore: player.bankBalance, bankBalanceAfter: newBankBalance },
      createdAt: timestamp,
    });

    return {
      walletBefore: player.balance,
      walletAfter: newBalance,
      bankBefore: player.bankBalance,
      bankAfter: newBankBalance,
    };
  });
}

/**
 * Process bank interest for all eligible players.
 * Should be called periodically or at specific times.
 */
async function processBankInterest() {
  const now = new Date();
  const todayStr = getInterestDate(now);
  
  // Check if it's 23:00 TW time or later
  // We'll use the TW date and check if it's already processed.
  // The "ready.js" event will call this.
  
  // Actually, we can just check if there are players who haven't received interest for "todayStr"
  // but only if current TW time is >= 23:00.
  
  const twTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).format(now);
  
  const [hour, minute] = twTime.split(':').map(Number);
  
  // If it's before 23:00, we don't process "today" yet, 
  // UNLESS we are catching up for PREVIOUS days.
  
  // Strategy:
  // 1. Find all players where bank_balance > 0 AND (last_interest_date IS NULL OR last_interest_date < todayStr)
  // 2. If TW time >= 23:00, we can process for todayStr.
  // 3. If TW time < 23:00, we only process for days strictly BEFORE todayStr.
  
  const targetDate = hour >= 23 ? todayStr : null; // If >= 23, we can pay for today.
  
  // We'll find players who need interest.
  // To keep it simple, we'll process one by one or in batches.
  
  const eligiblePlayers = await withCoinDatabase((api) => {
    return api.all(
      `SELECT guild_id, user_id, bank_balance, bank_interest_accrued, last_interest_date
       FROM coin_players
       WHERE bank_balance > 0
         AND (last_interest_date IS NULL OR last_interest_date < ?)` ,
      [todayStr]
    );
  });

  if (eligiblePlayers.length === 0) {
    return { processed: 0 };
  }

  // Filter: if targetDate is todayStr, we take all.
  // If targetDate is null, we only take those whose last_interest_date < todayStr.
  // Actually the SQL already did most of it.
  
  let processedCount = 0;
  for (const playerRow of eligiblePlayers) {
    // Determine which date we are paying for.
    // If last_interest_date is '2026-05-16' and today is '2026-05-17'
    // and TW time is 10:00, we pay for '2026-05-16' (which is already past its 23:00).
    // Actually, any day < todayStr is definitely past its 23:00.
    
    let payDate;
    if (playerRow.last_interest_date === null) {
      // First time interest. We should pay for the day before today if TW time < 23:00, 
      // or for today if TW time >= 23:00.
      // But wait, if they just deposited today, should they get interest today?
      // Usually yes, at 23:00.
      payDate = hour >= 23 ? todayStr : null;
      if (!payDate) {
         // Check if we should pay for yesterday?
         // Let's just say we pay for "the most recent day that is >= their creation date and < todayStr".
         // To simplify: we only pay for ONE day at a time per call to this function to avoid complex loops.
         // We'll pay for the oldest day they are missing.
         // But we don't have a "start date" for bank, so we'll just use yesterday.
         payDate = getInterestDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
      }
    } else {
      // They have a last_interest_date. Pay for the next day.
      payDate = require('./coinService').addDays(playerRow.last_interest_date, 1);
    }
    
    // If payDate is today and it's not 23:00 yet, skip.
    if (payDate === todayStr && hour < 23) {
      continue;
    }
    
    // If payDate is in the future, skip (shouldn't happen).
    if (payDate > todayStr) {
      continue;
    }

    try {
      await withCoinTransaction(async (api) => {
        // Re-fetch player to ensure no race condition
        const p = api.get('SELECT * FROM coin_players WHERE guild_id = ? AND user_id = ?', [playerRow.guild_id, playerRow.user_id]);
        if (!p || p.bank_balance <= 0 || (p.last_interest_date && p.last_interest_date >= payDate)) {
          return;
        }

        const interest = p.bank_balance * INTEREST_RATE;
        const totalAccrued = (p.bank_interest_accrued || 0) + interest;
        const creditAmount = Math.floor(totalAccrued);
        const remainingAccrued = totalAccrued - creditAmount;
        const timestamp = nowIso();

        if (creditAmount > 0) {
          const newBalance = p.balance + creditAmount;
          api.run(
            `UPDATE coin_players 
             SET balance = ?, bank_interest_accrued = ?, last_interest_date = ?, updated_at = ?
             WHERE guild_id = ? AND user_id = ?`,
            [newBalance, remainingAccrued, payDate, timestamp, p.guild_id, p.user_id]
          );
          
          insertTransaction(api, {
            guildId: p.guild_id,
            userId: p.user_id,
            type: TransactionType.BANK_INTEREST,
            balanceBefore: p.balance,
            amount: creditAmount,
            balanceAfter: newBalance,
            operatorId: null,
            reason: `銀行利息 (${payDate})`,
            metadata: { bankBalance: p.bank_balance, interestRate: INTEREST_RATE, accrued: totalAccrued },
            createdAt: timestamp,
          });
        } else {
          // Just update accrued and last_interest_date
          api.run(
            `UPDATE coin_players 
             SET bank_interest_accrued = ?, last_interest_date = ?, updated_at = ?
             WHERE guild_id = ? AND user_id = ?`,
            [remainingAccrued, payDate, timestamp, p.guild_id, p.user_id]
          );
        }
        processedCount++;
      });
    } catch (error) {
      logger.error(`發放銀行利息失敗 (Guild: ${playerRow.guild_id}, User: ${playerRow.user_id})`, error);
    }
  }

  if (processedCount > 0) {
    logger.info(`已處理 ${processedCount} 筆銀行利息發放。`);
  }
  return { processed: processedCount };
}

module.exports = {
  INTEREST_RATE,
  INTEREST_TIME_TW,
  deposit,
  withdraw,
  processBankInterest,
  getInterestDate,
};
