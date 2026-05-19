const { randomInt } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const {
  CoinServiceError,
  TransactionType,
  ensureGuildSettings,
  ensurePlayer,
  getLocalDate,
  addDays,
  insertTransaction,
} = require('./coinService');
const { formatCoins } = require('../utils/coinPresentation');

const MAX_CASINO_AMOUNT = 9_000_000_000;
const LOAN_INTEREST_RATE = 0.03;
const BLACKJACK_TTL_MS = 10 * 60 * 1000;

const CasinoGameType = Object.freeze({
  DICE: 'dice',
  SLOTS: 'slots',
  BLACKJACK: 'blackjack',
});

const CasinoGameStatus = Object.freeze({
  SETTLED: 'settled',
  ACTIVE: 'active',
  EXPIRED_REFUNDED: 'expired_refunded',
});

const CasinoLedgerType = Object.freeze({
  GAME_WIN: 'game_win',
  GAME_LOSS: 'game_loss',
  GAME_PUSH: 'game_push',
  LOAN_BORROW: 'loan_borrow',
  LOAN_REPAY: 'loan_repay',
  LOAN_INTEREST: 'loan_interest',
  BLACKJACK_REFUND: 'blackjack_refund',
});

const BlackjackAction = Object.freeze({
  HIT: 'hit',
  STAND: 'stand',
});

const BlackjackStatus = Object.freeze({
  ACTIVE: 'active',
  SETTLED: 'settled',
  EXPIRED_REFUNDED: 'expired_refunded',
});

const SLOT_SYMBOLS = Object.freeze(['櫻桃', '檸檬', '鈴鐺', '星星', '七']);
const CARD_RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
const CARD_SUITS = Object.freeze(['S', 'H', 'D', 'C']);

function nowIso(date = new Date()) {
  return date.toISOString();
}

function defaultRng(maxExclusive) {
  return randomInt(maxExclusive);
}

function normalizeAmount(value, label = '金額') {
  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_CASINO_AMOUNT) {
    throw new CoinServiceError('INVALID_CASINO_AMOUNT', `${label}必須是 1 到 ${MAX_CASINO_AMOUNT.toLocaleString('zh-TW')} 的整數。`);
  }

  return amount;
}

function serializeJson(value) {
  return JSON.stringify(value || {});
}

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapGame(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    gameType: row.game_type,
    betAmount: Number(row.bet_amount),
    payoutAmount: Number(row.payout_amount || 0),
    netAmount: Number(row.net_amount || 0),
    status: row.status,
    result: parseJson(row.result_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLoan(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    principalAmount: Number(row.principal_amount || 0),
    currentDebtAmount: Number(row.current_debt_amount || 0),
    interestRate: Number(row.interest_rate || LOAN_INTEREST_RATE),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastInterestDate: row.last_interest_date,
    repaidAt: row.repaid_at || null,
  };
}

function mapLedger(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    entryType: row.entry_type,
    amount: Number(row.amount || 0),
    balanceBefore: row.balance_before === null || row.balance_before === undefined ? null : Number(row.balance_before),
    balanceAfter: row.balance_after === null || row.balance_after === undefined ? null : Number(row.balance_after),
    debtBefore: row.debt_before === null || row.debt_before === undefined ? null : Number(row.debt_before),
    debtAfter: row.debt_after === null || row.debt_after === undefined ? null : Number(row.debt_after),
    gameId: row.game_id === null || row.game_id === undefined ? null : Number(row.game_id),
    loanId: row.loan_id === null || row.loan_id === undefined ? null : Number(row.loan_id),
    details: parseJson(row.details, {}),
    createdAt: row.created_at,
  };
}

function mapBlackjackSession(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    channelId: row.channel_id || null,
    messageId: row.message_id || null,
    betAmount: Number(row.bet_amount),
    deck: parseJson(row.deck_json, []),
    playerHand: parseJson(row.player_hand_json, []),
    dealerHand: parseJson(row.dealer_hand_json, []),
    status: row.status,
    payoutAmount: Number(row.payout_amount || 0),
    netAmount: Number(row.net_amount || 0),
    result: parseJson(row.result_json, {}),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at || null,
  };
}

function ensureEconomyEnabled(api, guildId) {
  const settings = ensureGuildSettings(api, guildId);

  if (!settings.enabled) {
    throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
  }

  return settings;
}

function assertEnoughBalance(player, amount) {
  if (player.balance < amount) {
    throw new CoinServiceError('INSUFFICIENT_FUNDS', '吉幣不足，無法下注或還款。', {
      balance: player.balance,
      required: amount,
    });
  }
}

function insertCasinoLedger(api, entry) {
  api.run(
    `INSERT INTO casino_ledger
      (guild_id, user_id, entry_type, amount, balance_before, balance_after, debt_before, debt_after, game_id, loan_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.guildId,
      entry.userId,
      entry.entryType,
      entry.amount,
      entry.balanceBefore ?? null,
      entry.balanceAfter ?? null,
      entry.debtBefore ?? null,
      entry.debtAfter ?? null,
      entry.gameId ?? null,
      entry.loanId ?? null,
      serializeJson(entry.details || {}),
      entry.createdAt || nowIso(),
    ]
  );
}

function getActiveLoanRow(api, guildId, userId) {
  return api.get(
    "SELECT * FROM casino_loans WHERE guild_id = ? AND user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
    [guildId, userId]
  );
}

function applyLoanInterestForRow(api, loanRow, date = new Date()) {
  if (!loanRow || loanRow.status !== 'active') {
    return { loan: loanRow ? mapLoan(loanRow) : null, interestAmount: 0, daysApplied: 0 };
  }

  const today = getLocalDate(date);
  let cursor = addDays(loanRow.last_interest_date, 1);

  if (cursor > today) {
    return { loan: mapLoan(loanRow), interestAmount: 0, daysApplied: 0 };
  }

  let debt = Number(loanRow.current_debt_amount || 0);
  const beforeDebt = debt;
  let daysApplied = 0;
  const rate = Number(loanRow.interest_rate || LOAN_INTEREST_RATE);

  while (cursor <= today) {
    debt = Math.ceil(debt * (1 + rate));
    daysApplied += 1;
    cursor = addDays(cursor, 1);
  }

  const timestamp = nowIso(date);
  const interestAmount = debt - beforeDebt;
  api.run(
    'UPDATE casino_loans SET current_debt_amount = ?, last_interest_date = ?, updated_at = ? WHERE id = ?',
    [debt, today, timestamp, loanRow.id]
  );

  if (interestAmount > 0) {
    insertCasinoLedger(api, {
      guildId: loanRow.guild_id,
      userId: loanRow.user_id,
      entryType: CasinoLedgerType.LOAN_INTEREST,
      amount: interestAmount,
      debtBefore: beforeDebt,
      debtAfter: debt,
      loanId: loanRow.id,
      details: { daysApplied, rate },
      createdAt: timestamp,
    });
  }

  const updatedLoan = api.get('SELECT * FROM casino_loans WHERE id = ?', [loanRow.id]);
  return { loan: mapLoan(updatedLoan), interestAmount, daysApplied };
}

function applyLoanInterest(api, guildId, userId, date = new Date()) {
  return applyLoanInterestForRow(api, getActiveLoanRow(api, guildId, userId), date);
}

function writeCoinBalance(api, guildId, userId, balance, { earned = 0, spent = 0, timestamp = nowIso() } = {}) {
  api.run(
    `UPDATE coin_players
     SET balance = ?,
         total_earned = total_earned + ?,
         total_spent = total_spent + ?,
         updated_at = ?
     WHERE guild_id = ? AND user_id = ?`,
    [balance, earned, spent, timestamp, guildId, userId]
  );
}

function insertGame(api, { guildId, userId, gameType, betAmount, payoutAmount, netAmount, status, result, createdAt }) {
  api.run(
    `INSERT INTO casino_games
      (guild_id, user_id, game_type, bet_amount, payout_amount, net_amount, status, result_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      guildId,
      userId,
      gameType,
      betAmount,
      payoutAmount,
      netAmount,
      status,
      serializeJson(result),
      createdAt,
      createdAt,
    ]
  );

  const gameId = Number(api.get('SELECT last_insert_rowid() AS id').id);
  return mapGame(api.get('SELECT * FROM casino_games WHERE id = ?', [gameId]));
}

function settleImmediateGame(api, { guildId, userId, gameType, betAmount, payoutAmount, result, timestamp }) {
  const player = ensurePlayer(api, guildId, userId);
  assertEnoughBalance(player, betAmount);

  const balanceAfterBet = player.balance - betAmount;
  const balanceAfter = balanceAfterBet + payoutAmount;
  const netAmount = payoutAmount - betAmount;
  writeCoinBalance(api, guildId, userId, balanceAfter, {
    earned: payoutAmount,
    spent: betAmount,
    timestamp,
  });
  insertTransaction(api, {
    guildId,
    userId,
    type: TransactionType.CASINO_BET,
    balanceBefore: player.balance,
    amount: -betAmount,
    balanceAfter: balanceAfterBet,
    operatorId: null,
    reason: `賭場下注：${gameType}`,
    metadata: { gameType, result },
    createdAt: timestamp,
  });

  if (payoutAmount > 0) {
    insertTransaction(api, {
      guildId,
      userId,
      type: TransactionType.CASINO_PAYOUT,
      balanceBefore: balanceAfterBet,
      amount: payoutAmount,
      balanceAfter,
      operatorId: null,
      reason: `賭場派彩：${gameType}`,
      metadata: { gameType, result },
      createdAt: timestamp,
    });
  }

  const game = insertGame(api, {
    guildId,
    userId,
    gameType,
    betAmount,
    payoutAmount,
    netAmount,
    status: CasinoGameStatus.SETTLED,
    result,
    createdAt: timestamp,
  });
  insertCasinoLedger(api, {
    guildId,
    userId,
    entryType: netAmount > 0 ? CasinoLedgerType.GAME_WIN : netAmount < 0 ? CasinoLedgerType.GAME_LOSS : CasinoLedgerType.GAME_PUSH,
    amount: netAmount,
    balanceBefore: player.balance,
    balanceAfter,
    gameId: game.id,
    details: result,
    createdAt: timestamp,
  });

  return {
    game,
    betAmount,
    payoutAmount,
    netAmount,
    balanceBefore: player.balance,
    balanceAfter,
  };
}

function playDice(guildId, userId, { amount, choice, rng = defaultRng, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    applyLoanInterest(api, guildId, userId, date);
    const betAmount = normalizeAmount(amount, '下注金額');
    const normalizedChoice = String(choice || '').trim().toLowerCase();

    if (!['big', 'small', 'seven'].includes(normalizedChoice)) {
      throw new CoinServiceError('INVALID_DICE_CHOICE', '骰子下注只能選 big、small 或 seven。');
    }

    const dice = [rng(6) + 1, rng(6) + 1];
    const sum = dice[0] + dice[1];
    const win =
      (normalizedChoice === 'big' && sum >= 8 && sum <= 12) ||
      (normalizedChoice === 'small' && sum >= 2 && sum <= 6) ||
      (normalizedChoice === 'seven' && sum === 7);
    const multiplier = normalizedChoice === 'seven' ? 5 : 2;
    const payoutAmount = win ? betAmount * multiplier : 0;

    return settleImmediateGame(api, {
      guildId,
      userId,
      gameType: CasinoGameType.DICE,
      betAmount,
      payoutAmount,
      result: { choice: normalizedChoice, dice, sum, win, multiplier: win ? multiplier : 0 },
      timestamp: nowIso(date),
    });
  });
}

function playSlots(guildId, userId, { amount, rng = defaultRng, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    applyLoanInterest(api, guildId, userId, date);
    const betAmount = normalizeAmount(amount, '下注金額');
    const reels = [SLOT_SYMBOLS[rng(SLOT_SYMBOLS.length)], SLOT_SYMBOLS[rng(SLOT_SYMBOLS.length)], SLOT_SYMBOLS[rng(SLOT_SYMBOLS.length)]];
    const counts = new Map();

    for (const symbol of reels) {
      counts.set(symbol, (counts.get(symbol) || 0) + 1);
    }

    const maxMatches = Math.max(...counts.values());
    let multiplier = 0;

    if (maxMatches === 3) {
      multiplier = reels[0] === '七' ? 10 : 5;
    } else if (maxMatches === 2) {
      multiplier = 2;
    }

    const payoutAmount = betAmount * multiplier;

    return settleImmediateGame(api, {
      guildId,
      userId,
      gameType: CasinoGameType.SLOTS,
      betAmount,
      payoutAmount,
      result: { reels, multiplier, win: multiplier > 0 },
      timestamp: nowIso(date),
    });
  });
}

function createDeck(rng = defaultRng) {
  const deck = [];

  for (const suit of CARD_SUITS) {
    for (const rank of CARD_RANKS) {
      deck.push(`${rank}${suit}`);
    }
  }

  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = rng(index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }

  return deck;
}

function drawCard(deck) {
  const card = deck.shift();

  if (!card) {
    throw new CoinServiceError('BLACKJACK_DECK_EMPTY', '牌堆已空，無法繼續這局 21點。');
  }

  return card;
}

function getCardRank(card) {
  return String(card).slice(0, -1);
}

function getHandValue(hand) {
  let value = 0;
  let aces = 0;

  for (const card of hand) {
    const rank = getCardRank(card);

    if (rank === 'A') {
      value += 11;
      aces += 1;
    } else if (['J', 'Q', 'K'].includes(rank)) {
      value += 10;
    } else {
      value += Number(rank);
    }
  }

  while (value > 21 && aces > 0) {
    value -= 10;
    aces -= 1;
  }

  return value;
}

function isNaturalBlackjack(hand) {
  return hand.length === 2 && getHandValue(hand) === 21;
}

function compareBlackjack(playerHand, dealerHand) {
  const playerValue = getHandValue(playerHand);
  const dealerValue = getHandValue(dealerHand);

  if (playerValue > 21) {
    return { outcome: 'lose', reason: '玩家爆牌。' };
  }

  if (dealerValue > 21) {
    return { outcome: 'win', reason: '莊家爆牌。' };
  }

  if (playerValue > dealerValue) {
    return { outcome: 'win', reason: '玩家點數較高。' };
  }

  if (playerValue < dealerValue) {
    return { outcome: 'lose', reason: '莊家點數較高。' };
  }

  return { outcome: 'push', reason: '平手，退回下注。' };
}

function calculateBlackjackPayout(betAmount, playerHand, dealerHand) {
  const playerNatural = isNaturalBlackjack(playerHand);
  const dealerNatural = isNaturalBlackjack(dealerHand);

  if (playerNatural && dealerNatural) {
    return { payoutAmount: betAmount, outcome: 'push', reason: '雙方都是自然 21 點，平手退回下注。' };
  }

  if (playerNatural) {
    return { payoutAmount: Math.floor((betAmount * 5) / 2), outcome: 'blackjack', reason: '自然 21 點，賠率 3:2。' };
  }

  if (dealerNatural) {
    return { payoutAmount: 0, outcome: 'lose', reason: '莊家自然 21 點。' };
  }

  const compared = compareBlackjack(playerHand, dealerHand);
  if (compared.outcome === 'win') {
    return { payoutAmount: betAmount * 2, ...compared };
  }

  if (compared.outcome === 'push') {
    return { payoutAmount: betAmount, ...compared };
  }

  return { payoutAmount: 0, ...compared };
}

function insertBlackjackGameAndLedger(api, session, playerBeforeSettle, balanceAfter, result, timestamp) {
  const game = insertGame(api, {
    guildId: session.guildId,
    userId: session.userId,
    gameType: CasinoGameType.BLACKJACK,
    betAmount: session.betAmount,
    payoutAmount: result.payoutAmount,
    netAmount: result.payoutAmount - session.betAmount,
    status: CasinoGameStatus.SETTLED,
    result,
    createdAt: timestamp,
  });

  insertCasinoLedger(api, {
    guildId: session.guildId,
    userId: session.userId,
    entryType:
      result.payoutAmount > session.betAmount
        ? CasinoLedgerType.GAME_WIN
        : result.payoutAmount < session.betAmount
          ? CasinoLedgerType.GAME_LOSS
          : CasinoLedgerType.GAME_PUSH,
    amount: result.payoutAmount - session.betAmount,
    balanceBefore: playerBeforeSettle,
    balanceAfter,
    gameId: game.id,
    details: result,
    createdAt: timestamp,
  });

  return game;
}

function settleBlackjackSession(api, sessionRow, { date = new Date(), resultOverride = null } = {}) {
  const session = mapBlackjackSession(sessionRow);
  const timestamp = nowIso(date);
  const player = ensurePlayer(api, session.guildId, session.userId);
  const result = resultOverride || {
    ...calculateBlackjackPayout(session.betAmount, session.playerHand, session.dealerHand),
    playerHand: session.playerHand,
    dealerHand: session.dealerHand,
    playerValue: getHandValue(session.playerHand),
    dealerValue: getHandValue(session.dealerHand),
  };
  const balanceAfter = player.balance + result.payoutAmount;

  if (result.payoutAmount > 0) {
    writeCoinBalance(api, session.guildId, session.userId, balanceAfter, {
      earned: result.payoutAmount,
      timestamp,
    });
    insertTransaction(api, {
      guildId: session.guildId,
      userId: session.userId,
      type: TransactionType.CASINO_PAYOUT,
      balanceBefore: player.balance,
      amount: result.payoutAmount,
      balanceAfter,
      operatorId: null,
      reason: '賭場派彩：blackjack',
      metadata: { blackjackSessionId: session.id, result },
      createdAt: timestamp,
    });
  }

  api.run(
    `UPDATE casino_blackjack_sessions
     SET status = ?, payout_amount = ?, net_amount = ?, result_json = ?, updated_at = ?, settled_at = ?
     WHERE id = ?`,
    [
      BlackjackStatus.SETTLED,
      result.payoutAmount,
      result.payoutAmount - session.betAmount,
      serializeJson(result),
      timestamp,
      timestamp,
      session.id,
    ]
  );

  const game = insertBlackjackGameAndLedger(api, session, player.balance, balanceAfter, result, timestamp);

  return {
    session: mapBlackjackSession(api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [session.id])),
    game,
    result,
    balanceAfter,
  };
}

function expireBlackjackSessionRow(api, sessionRow, date = new Date()) {
  const session = mapBlackjackSession(sessionRow);

  if (!session || session.status !== BlackjackStatus.ACTIVE) {
    return { session, refunded: false };
  }

  const timestamp = nowIso(date);
  const player = ensurePlayer(api, session.guildId, session.userId);
  const balanceAfter = player.balance + session.betAmount;
  writeCoinBalance(api, session.guildId, session.userId, balanceAfter, {
    earned: session.betAmount,
    timestamp,
  });
  insertTransaction(api, {
    guildId: session.guildId,
    userId: session.userId,
    type: TransactionType.CASINO_PAYOUT,
    balanceBefore: player.balance,
    amount: session.betAmount,
    balanceAfter,
    operatorId: null,
    reason: '21點逾時退回下注',
    metadata: { blackjackSessionId: session.id },
    createdAt: timestamp,
  });
  api.run(
    `UPDATE casino_blackjack_sessions
     SET status = ?, payout_amount = ?, net_amount = 0, result_json = ?, updated_at = ?, settled_at = ?
     WHERE id = ?`,
    [
      BlackjackStatus.EXPIRED_REFUNDED,
      session.betAmount,
      serializeJson({ outcome: 'expired_refunded', reason: '逾時未操作，已退回下注。' }),
      timestamp,
      timestamp,
      session.id,
    ]
  );
  insertCasinoLedger(api, {
    guildId: session.guildId,
    userId: session.userId,
    entryType: CasinoLedgerType.BLACKJACK_REFUND,
    amount: session.betAmount,
    balanceBefore: player.balance,
    balanceAfter,
    loanId: null,
    details: { blackjackSessionId: session.id },
    createdAt: timestamp,
  });

  return {
    session: mapBlackjackSession(api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [session.id])),
    refunded: true,
    balanceAfter,
  };
}

function expireUserBlackjackSessions(api, guildId, userId, date = new Date()) {
  const rows = api.all(
    'SELECT * FROM casino_blackjack_sessions WHERE guild_id = ? AND user_id = ? AND status = ? AND expires_at <= ?',
    [guildId, userId, BlackjackStatus.ACTIVE, nowIso(date)]
  );

  return rows.map((row) => expireBlackjackSessionRow(api, row, date));
}

function startBlackjack(guildId, userId, { amount, rng = defaultRng, deck = null, date = new Date(), channelId = null } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    applyLoanInterest(api, guildId, userId, date);
    expireUserBlackjackSessions(api, guildId, userId, date);

    const existing = api.get(
      'SELECT * FROM casino_blackjack_sessions WHERE guild_id = ? AND user_id = ? AND status = ? ORDER BY id DESC LIMIT 1',
      [guildId, userId, BlackjackStatus.ACTIVE]
    );

    if (existing) {
      throw new CoinServiceError('ACTIVE_BLACKJACK_SESSION', '你已經有一局進行中的 21點，請先完成或等待逾時。');
    }

    const betAmount = normalizeAmount(amount, '下注金額');
    const player = ensurePlayer(api, guildId, userId);
    assertEnoughBalance(player, betAmount);

    const timestamp = nowIso(date);
    const balanceAfterBet = player.balance - betAmount;
    writeCoinBalance(api, guildId, userId, balanceAfterBet, {
      spent: betAmount,
      timestamp,
    });
    insertTransaction(api, {
      guildId,
      userId,
      type: TransactionType.CASINO_BET,
      balanceBefore: player.balance,
      amount: -betAmount,
      balanceAfter: balanceAfterBet,
      operatorId: null,
      reason: '賭場下注：blackjack',
      metadata: { gameType: CasinoGameType.BLACKJACK },
      createdAt: timestamp,
    });

    const gameDeck = Array.isArray(deck) ? [...deck] : createDeck(rng);
    const playerHand = [drawCard(gameDeck), drawCard(gameDeck)];
    const dealerHand = [drawCard(gameDeck), drawCard(gameDeck)];
    const expiresAt = new Date(date.getTime() + BLACKJACK_TTL_MS).toISOString();

    api.run(
      `INSERT INTO casino_blackjack_sessions
        (guild_id, user_id, channel_id, bet_amount, deck_json, player_hand_json, dealer_hand_json, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guildId,
        userId,
        channelId,
        betAmount,
        serializeJson(gameDeck),
        serializeJson(playerHand),
        serializeJson(dealerHand),
        BlackjackStatus.ACTIVE,
        expiresAt,
        timestamp,
        timestamp,
      ]
    );

    const sessionId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    let sessionRow = api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [sessionId]);
    let settled = null;

    if (isNaturalBlackjack(playerHand) || isNaturalBlackjack(dealerHand)) {
      settled = settleBlackjackSession(api, sessionRow, { date });
      sessionRow = api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [sessionId]);
    }

    return {
      session: mapBlackjackSession(sessionRow),
      settled,
      balanceAfter: settled?.balanceAfter ?? balanceAfterBet,
    };
  });
}

function getBlackjackSession(api, guildId, userId, sessionId) {
  const row = api.get('SELECT * FROM casino_blackjack_sessions WHERE guild_id = ? AND id = ?', [guildId, sessionId]);

  if (!row) {
    throw new CoinServiceError('BLACKJACK_SESSION_NOT_FOUND', '找不到這局 21點，可能已經結束或被清除。');
  }

  if (row.user_id !== userId) {
    throw new CoinServiceError('BLACKJACK_SESSION_OWNER_ONLY', '只有開局的玩家可以操作這局 21點。');
  }

  return row;
}

function hitBlackjack(guildId, userId, sessionId, { date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const row = getBlackjackSession(api, guildId, userId, sessionId);

    if (row.status !== BlackjackStatus.ACTIVE) {
      return { session: mapBlackjackSession(row), settled: true };
    }

    if (row.expires_at <= nowIso(date)) {
      return { ...expireBlackjackSessionRow(api, row, date), expired: true };
    }

    const session = mapBlackjackSession(row);
    session.playerHand.push(drawCard(session.deck));
    const timestamp = nowIso(date);
    api.run(
      'UPDATE casino_blackjack_sessions SET deck_json = ?, player_hand_json = ?, updated_at = ? WHERE id = ?',
      [serializeJson(session.deck), serializeJson(session.playerHand), timestamp, session.id]
    );

    const updatedRow = api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [session.id]);

    if (getHandValue(session.playerHand) >= 21) {
      return settleBlackjackSession(api, updatedRow, { date });
    }

    return {
      session: mapBlackjackSession(updatedRow),
      settled: false,
    };
  });
}

function standBlackjack(guildId, userId, sessionId, { date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const row = getBlackjackSession(api, guildId, userId, sessionId);

    if (row.status !== BlackjackStatus.ACTIVE) {
      return { session: mapBlackjackSession(row), settled: true };
    }

    if (row.expires_at <= nowIso(date)) {
      return { ...expireBlackjackSessionRow(api, row, date), expired: true };
    }

    const session = mapBlackjackSession(row);

    while (getHandValue(session.dealerHand) < 17) {
      session.dealerHand.push(drawCard(session.deck));
    }

    const timestamp = nowIso(date);
    api.run(
      'UPDATE casino_blackjack_sessions SET deck_json = ?, dealer_hand_json = ?, updated_at = ? WHERE id = ?',
      [serializeJson(session.deck), serializeJson(session.dealerHand), timestamp, session.id]
    );

    const updatedRow = api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [session.id]);
    return settleBlackjackSession(api, updatedRow, { date });
  });
}

function borrowCasinoLoan(guildId, userId, { amount, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    const loanAmount = normalizeAmount(amount, '借款金額');
    const player = ensurePlayer(api, guildId, userId);
    const interest = applyLoanInterest(api, guildId, userId, date);
    const activeLoan = interest.loan;
    const debtBefore = activeLoan?.currentDebtAmount || 0;

    if (debtBefore + loanAmount > MAX_CASINO_AMOUNT) {
      throw new CoinServiceError('CASINO_LOAN_LIMIT', `借款後總債務不可超過 ${MAX_CASINO_AMOUNT.toLocaleString('zh-TW')} 吉幣。`);
    }

    const timestamp = nowIso(date);
    const today = getLocalDate(date);
    let loanId;

    if (activeLoan) {
      api.run(
        'UPDATE casino_loans SET principal_amount = principal_amount + ?, current_debt_amount = current_debt_amount + ?, updated_at = ? WHERE id = ?',
        [loanAmount, loanAmount, timestamp, activeLoan.id]
      );
      loanId = activeLoan.id;
    } else {
      api.run(
        `INSERT INTO casino_loans
          (guild_id, user_id, principal_amount, current_debt_amount, interest_rate, status, created_at, updated_at, last_interest_date)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [guildId, userId, loanAmount, loanAmount, LOAN_INTEREST_RATE, timestamp, timestamp, today]
      );
      loanId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    }

    const balanceAfter = player.balance + loanAmount;
    writeCoinBalance(api, guildId, userId, balanceAfter, { timestamp });
    insertTransaction(api, {
      guildId,
      userId,
      type: TransactionType.CASINO_LOAN_BORROW,
      balanceBefore: player.balance,
      amount: loanAmount,
      balanceAfter,
      operatorId: null,
      reason: '賭場貸幣借款',
      metadata: { loanId },
      createdAt: timestamp,
    });
    insertCasinoLedger(api, {
      guildId,
      userId,
      entryType: CasinoLedgerType.LOAN_BORROW,
      amount: loanAmount,
      balanceBefore: player.balance,
      balanceAfter,
      debtBefore,
      debtAfter: debtBefore + loanAmount,
      loanId,
      createdAt: timestamp,
    });

    return {
      loan: mapLoan(api.get('SELECT * FROM casino_loans WHERE id = ?', [loanId])),
      borrowedAmount: loanAmount,
      balanceBefore: player.balance,
      balanceAfter,
      interestApplied: interest.interestAmount,
    };
  });
}

function repayCasinoLoan(guildId, userId, { amount, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    const requestedAmount = normalizeAmount(amount, '還款金額');
    const player = ensurePlayer(api, guildId, userId);
    const interest = applyLoanInterest(api, guildId, userId, date);
    const activeLoan = interest.loan;

    if (!activeLoan) {
      throw new CoinServiceError('NO_ACTIVE_CASINO_LOAN', '你目前沒有賭場借款。');
    }

    const repaymentAmount = Math.min(requestedAmount, activeLoan.currentDebtAmount);
    assertEnoughBalance(player, repaymentAmount);

    const timestamp = nowIso(date);
    const debtAfter = activeLoan.currentDebtAmount - repaymentAmount;
    const balanceAfter = player.balance - repaymentAmount;
    writeCoinBalance(api, guildId, userId, balanceAfter, {
      spent: repaymentAmount,
      timestamp,
    });
    api.run(
      `UPDATE casino_loans
       SET current_debt_amount = ?, status = ?, updated_at = ?, repaid_at = CASE WHEN ? = 0 THEN ? ELSE repaid_at END
       WHERE id = ?`,
      [debtAfter, debtAfter === 0 ? 'repaid' : 'active', timestamp, debtAfter, timestamp, activeLoan.id]
    );
    insertTransaction(api, {
      guildId,
      userId,
      type: TransactionType.CASINO_LOAN_REPAY,
      balanceBefore: player.balance,
      amount: -repaymentAmount,
      balanceAfter,
      operatorId: null,
      reason: '賭場貸幣還款',
      metadata: { loanId: activeLoan.id },
      createdAt: timestamp,
    });
    insertCasinoLedger(api, {
      guildId,
      userId,
      entryType: CasinoLedgerType.LOAN_REPAY,
      amount: -repaymentAmount,
      balanceBefore: player.balance,
      balanceAfter,
      debtBefore: activeLoan.currentDebtAmount,
      debtAfter,
      loanId: activeLoan.id,
      createdAt: timestamp,
    });

    return {
      loan: mapLoan(api.get('SELECT * FROM casino_loans WHERE id = ?', [activeLoan.id])),
      repaymentAmount,
      balanceBefore: player.balance,
      balanceAfter,
      interestApplied: interest.interestAmount,
    };
  });
}

function getCasinoLoanStatus(guildId, userId, { date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    ensurePlayer(api, guildId, userId);
    const interest = applyLoanInterest(api, guildId, userId, date);
    const loan = interest.loan || mapLoan(getActiveLoanRow(api, guildId, userId));

    return {
      loan,
      interestApplied: interest.interestAmount,
      daysApplied: interest.daysApplied,
    };
  });
}

function listCasinoHistory(guildId, userId, { limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const normalizedLimit = Math.min(Math.max(Number(limit || 10), 1), 25);
    return api
      .all(
        `SELECT *
         FROM casino_ledger
         WHERE guild_id = ? AND user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [guildId, userId, normalizedLimit]
      )
      .map(mapLedger);
  });
}

function processCasinoLoanInterest({ date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const loans = api.all("SELECT * FROM casino_loans WHERE status = 'active'");
    let processed = 0;
    let interestAmount = 0;

    for (const loan of loans) {
      const result = applyLoanInterestForRow(api, loan, date);
      if (result.interestAmount > 0) {
        processed += 1;
        interestAmount += result.interestAmount;
      }
    }

    return {
      checked: loans.length,
      processed,
      interestAmount,
    };
  });
}

function processExpiredBlackjackSessions({ date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const rows = api.all('SELECT * FROM casino_blackjack_sessions WHERE status = ? AND expires_at <= ?', [
      BlackjackStatus.ACTIVE,
      nowIso(date),
    ]);

    for (const row of rows) {
      expireBlackjackSessionRow(api, row, date);
    }

    return {
      checked: rows.length,
      refunded: rows.length,
    };
  });
}

function getSuitSymbol(suit) {
  return {
    S: '♠',
    H: '♥',
    D: '♦',
    C: '♣',
  }[suit] || suit;
}

function formatCard(card) {
  const text = String(card);
  return `${text.slice(0, -1)}${getSuitSymbol(text.slice(-1))}`;
}

function formatHand(hand, { hideHole = false } = {}) {
  if (hideHole && hand.length > 1) {
    return `${formatCard(hand[0])} 暗牌`;
  }

  return hand.map(formatCard).join(' ');
}

function buildBlackjackEmbed(session) {
  const active = session.status === BlackjackStatus.ACTIVE;
  const dealerHandText = active ? formatHand(session.dealerHand, { hideHole: true }) : formatHand(session.dealerHand);
  const dealerValueText = active ? `${getHandValue([session.dealerHand[0]])}+` : String(getHandValue(session.dealerHand));
  const resultLine = active ? `操作期限：<t:${Math.floor(new Date(session.expiresAt).getTime() / 1000)}:R>` : session.result.reason;

  return new EmbedBuilder()
    .setColor(active ? 0xf59e0b : session.netAmount > 0 ? 0x22c55e : session.netAmount < 0 ? 0xef4444 : 0x64748b)
    .setTitle(`小吉賭場｜21點 #${session.id}`)
    .setDescription(resultLine || '21點')
    .addFields(
      { name: '下注', value: formatCoins(session.betAmount), inline: true },
      { name: '狀態', value: session.status, inline: true },
      { name: '派彩', value: formatCoins(session.payoutAmount), inline: true },
      { name: '你的手牌', value: `${formatHand(session.playerHand)}\n點數：${getHandValue(session.playerHand)}`, inline: false },
      { name: '莊家手牌', value: `${dealerHandText}\n點數：${dealerValueText}`, inline: false }
    );
}

function buildBlackjackComponents(session) {
  const disabled = session.status !== BlackjackStatus.ACTIVE;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`casino:blackjack:${BlackjackAction.HIT}:${session.id}`)
        .setLabel('補牌')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`casino:blackjack:${BlackjackAction.STAND}:${session.id}`)
        .setLabel('停牌')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    ),
  ];
}

function buildBlackjackPayload(session) {
  return {
    content: '',
    embeds: [buildBlackjackEmbed(session)],
    components: buildBlackjackComponents(session),
    allowedMentions: { parse: [] },
  };
}

async function handleBlackjackButton(interaction) {
  const [, , action, sessionIdText] = interaction.customId.split(':');
  const sessionId = Number(sessionIdText);

  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
    await interaction.reply({ content: '找不到這局 21點。', ephemeral: true });
    return;
  }

  try {
    const result =
      action === BlackjackAction.HIT
        ? await hitBlackjack(interaction.guildId, interaction.user.id, sessionId)
        : await standBlackjack(interaction.guildId, interaction.user.id, sessionId);

    await interaction.update(buildBlackjackPayload(result.session));
  } catch (error) {
    if (error instanceof CoinServiceError) {
      await interaction.reply({ content: error.message, ephemeral: true });
      return;
    }

    throw error;
  }
}

module.exports = {
  BLACKJACK_TTL_MS,
  MAX_CASINO_AMOUNT,
  LOAN_INTEREST_RATE,
  CasinoGameStatus,
  CasinoGameType,
  CasinoLedgerType,
  BlackjackStatus,
  buildBlackjackPayload,
  borrowCasinoLoan,
  getCasinoLoanStatus,
  getHandValue,
  handleBlackjackButton,
  hitBlackjack,
  listCasinoHistory,
  playDice,
  playSlots,
  processCasinoLoanInterest,
  processExpiredBlackjackSessions,
  repayCasinoLoan,
  standBlackjack,
  startBlackjack,
};
