const { SlashCommandBuilder } = require('discord.js');
const { getPlayerBalance } = require('../services/coinService');
const { deposit, withdraw, INTEREST_RATE, INTEREST_TIME_TW, getInterestDate } = require('../services/bankService');
const { formatCoins, replyCoinError } = require('../utils/coinPresentation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bank')
    .setDescription('小吉銀行系統')
    .addSubcommand((subcommand) =>
      subcommand.setName('balance').setDescription('查詢錢包餘額與銀行存款')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('deposit')
        .setDescription('將錢包吉幣存入銀行')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('存款金額').setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('withdraw')
        .setDescription('從銀行提款到錢包')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('提款金額').setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('interest').setDescription('查詢目前銀行利息規則')
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '銀行系統只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'balance') {
        const player = await getPlayerBalance(interaction.guildId, interaction.user.id);
        const today = getInterestDate();
        const hasInterestToday = player.lastInterestDate === today;

        await interaction.reply({
          content: [
            '**銀行帳戶狀態**',
            `• 錢包餘額：${formatCoins(player.balance)}`,
            `• 銀行存款：${formatCoins(player.bankBalance)}`,
            `• 未結利息：${player.bankInterestAccrued.toFixed(4)} 吉幣`,
            `• 今日已領利息：${hasInterestToday ? '✅ 是' : '❌ 否'}`,
            `• 下次發息時間：${INTEREST_TIME_TW} (台灣時間)`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'deposit') {
        const amount = interaction.options.getInteger('amount', true);
        const result = await deposit(interaction.guildId, interaction.user.id, amount);

        await interaction.reply({
          content: [
            '**存款成功！**',
            `• 存入金額：${formatCoins(amount)}`,
            `• 目前錢包：${formatCoins(result.walletAfter)}`,
            `• 目前銀行：${formatCoins(result.bankAfter)}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'withdraw') {
        const amount = interaction.options.getInteger('amount', true);
        const result = await withdraw(interaction.guildId, interaction.user.id, amount);

        await interaction.reply({
          content: [
            '**提款成功！**',
            `• 提款金額：${formatCoins(amount)}`,
            `• 目前錢包：${formatCoins(result.walletAfter)}`,
            `• 目前銀行：${formatCoins(result.bankAfter)}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'interest') {
        await interaction.reply({
          content: [
            '**銀行利息規則**',
            `• 活存每日利率：${(INTEREST_RATE * 100).toFixed(2)}%`,
            `• 利息結算時間：每日 ${INTEREST_TIME_TW} (台灣時間)`,
            '• 計算方式：依據每日結算時的銀行存款計算利息。',
            '• 入帳規則：利息中小數部分會持續累積，滿 1 吉幣時自動匯入錢包。',
          ].join('\n'),
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
