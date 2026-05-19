const { SlashCommandBuilder } = require('discord.js');
const {
  BlackjackStatus,
  LOAN_INTEREST_RATE,
  MAX_CASINO_AMOUNT,
  buildBlackjackPayload,
  borrowCasinoLoan,
  getCasinoLoanStatus,
  listCasinoHistory,
  playDice,
  playSlots,
  repayCasinoLoan,
  startBlackjack,
} = require('../services/casinoService');
const { formatCoins, replyCoinError } = require('../utils/coinPresentation');

const diceChoiceLabels = {
  big: '大（8-12）',
  small: '小（2-6）',
  seven: '指定 7 點',
};

const ledgerTypeLabels = {
  game_win: '遊戲獲勝',
  game_loss: '遊戲落敗',
  game_push: '遊戲平手',
  loan_borrow: '貸幣借款',
  loan_repay: '貸幣還款',
  loan_interest: '貸幣利息',
  blackjack_refund: '21點逾時退款',
};

function formatSignedCoins(amount) {
  const numeric = Number(amount || 0);
  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  return `${sign}${formatCoins(Math.abs(numeric))}`;
}

function formatTimestamp(isoString) {
  if (!isoString) {
    return '無';
  }

  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:F>`;
}

function formatDiceResult(result) {
  const gameResult = result.game.result;

  return [
    '**小吉賭場｜骰子**',
    `下注：${formatCoins(result.betAmount)}`,
    `選擇：${diceChoiceLabels[gameResult.choice] || gameResult.choice}`,
    `結果：${gameResult.dice.join(' + ')} = ${gameResult.sum}`,
    `狀態：${gameResult.win ? '中獎' : '未中獎'}`,
    `派彩：${formatCoins(result.payoutAmount)}`,
    `本局損益：${formatSignedCoins(result.netAmount)}`,
    `錢包餘額：${formatCoins(result.balanceAfter)}`,
  ].join('\n');
}

function formatSlotsResult(result) {
  const gameResult = result.game.result;

  return [
    '**小吉賭場｜角子機**',
    `下注：${formatCoins(result.betAmount)}`,
    `結果：${gameResult.reels.join(' | ')}`,
    `倍率：x${gameResult.multiplier}`,
    `派彩：${formatCoins(result.payoutAmount)}`,
    `本局損益：${formatSignedCoins(result.netAmount)}`,
    `錢包餘額：${formatCoins(result.balanceAfter)}`,
  ].join('\n');
}

function formatLoan(loan) {
  if (!loan) {
    return '目前沒有賭場借款。';
  }

  return [
    `借款編號：#${loan.id}`,
    `本金累計：${formatCoins(loan.principalAmount)}`,
    `目前債務：${formatCoins(loan.currentDebtAmount)}`,
    `每日複利：${(Number(loan.interestRate || LOAN_INTEREST_RATE) * 100).toFixed(2)}%`,
    `上次計息日期：${loan.lastInterestDate}`,
    `狀態：${loan.status}`,
  ].join('\n');
}

function formatHistoryRow(row) {
  const targetId = row.gameId ? `遊戲 #${row.gameId}` : row.loanId ? `借款 #${row.loanId}` : '系統';
  return [
    `#${row.id}`,
    ledgerTypeLabels[row.entryType] || row.entryType,
    targetId,
    formatSignedCoins(row.amount),
    formatTimestamp(row.createdAt),
  ].join('｜');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('casino')
    .setDescription('使用吉幣遊玩小吉虛擬賭場')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('dice')
        .setDescription('下注骰子大小或指定 7 點')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('下注吉幣').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
        .addStringOption((option) =>
          option
            .setName('choice')
            .setDescription('下注項目')
            .setRequired(true)
            .addChoices(
              { name: '大（8-12，賠 1:1）', value: 'big' },
              { name: '小（2-6，賠 1:1）', value: 'small' },
              { name: '指定 7 點（賠 4:1）', value: 'seven' }
            )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('slots')
        .setDescription('使用吉幣遊玩角子機')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('下注吉幣').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('blackjack')
        .setDescription('使用吉幣遊玩 21點')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('下注吉幣').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('loan-borrow')
        .setDescription('從賭場貸幣兌換區借入吉幣')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('借款吉幣').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('loan-repay')
        .setDescription('償還賭場貸幣借款')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('還款吉幣').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('loan-status').setDescription('查看自己的賭場借款狀態'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('查看自己的賭場流水')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '賭場功能只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      const guildId = interaction.guildId;
      const userId = interaction.user.id;

      if (subcommand === 'dice') {
        const result = await playDice(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
          choice: interaction.options.getString('choice', true),
        });
        await interaction.reply({ content: formatDiceResult(result) });
        return;
      }

      if (subcommand === 'slots') {
        const result = await playSlots(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
        });
        await interaction.reply({ content: formatSlotsResult(result) });
        return;
      }

      if (subcommand === 'blackjack') {
        const result = await startBlackjack(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
          channelId: interaction.channelId,
        });
        const payload = buildBlackjackPayload(result.session);
        payload.content =
          result.session.status === BlackjackStatus.ACTIVE
            ? `${interaction.user} 開了一局 21點，下注 ${formatCoins(result.session.betAmount)}。`
            : `${interaction.user} 的 21點已結算，本局損益 ${formatSignedCoins(result.session.netAmount)}。`;
        await interaction.reply(payload);
        return;
      }

      if (subcommand === 'loan-borrow') {
        const result = await borrowCasinoLoan(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
        });
        await interaction.reply({
          content: [
            '**小吉賭場｜貸幣兌換區**',
            `已借入：${formatCoins(result.borrowedAmount)}`,
            `錢包餘額：${formatCoins(result.balanceAfter)}`,
            formatLoan(result.loan),
            result.interestApplied > 0 ? `本次先補計利息：${formatCoins(result.interestApplied)}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'loan-repay') {
        const result = await repayCasinoLoan(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
        });
        await interaction.reply({
          content: [
            '**小吉賭場｜貸幣還款**',
            `已還款：${formatCoins(result.repaymentAmount)}`,
            `錢包餘額：${formatCoins(result.balanceAfter)}`,
            formatLoan(result.loan),
            result.interestApplied > 0 ? `本次先補計利息：${formatCoins(result.interestApplied)}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'loan-status') {
        const result = await getCasinoLoanStatus(guildId, userId);
        await interaction.reply({
          content: [
            '**小吉賭場｜借款狀態**',
            formatLoan(result.loan),
            result.interestApplied > 0 ? `本次補計利息：${formatCoins(result.interestApplied)}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'history') {
        const rows = await listCasinoHistory(guildId, userId, {
          limit: interaction.options.getInteger('limit') || 10,
        });
        await interaction.reply({
          content: rows.length
            ? ['**小吉賭場｜你的流水**', ...rows.map(formatHistoryRow)].join('\n')
            : '目前沒有賭場流水。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '小吉賭場剛剛執行失敗了，請稍後再試。');
    }
  },
};
