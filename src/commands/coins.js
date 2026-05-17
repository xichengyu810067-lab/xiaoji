const { SlashCommandBuilder } = require('discord.js');
const { getPlayerBalance } = require('../services/coinService');
const { formatCoins, formatUser, replyCoinError } = require('../utils/coinPresentation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('coins')
    .setDescription('查詢吉幣餘額')
    .addUserOption((option) => option.setName('user').setDescription('要查詢的使用者')),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '吉幣只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const user = interaction.options.getUser('user') || interaction.user;
      const player = await getPlayerBalance(interaction.guildId, user.id);

      await interaction.reply({
        content: [
          `**${formatUser(user)} 的吉幣資料**`,
          `目前餘額：${formatCoins(player.balance)}`,
          `連續簽到：${player.dailyStreak} 天`,
          `累積取得：${formatCoins(player.totalEarned)}`,
          `累積花費：${formatCoins(player.totalSpent)}`,
        ].join('\n'),
        ephemeral: true,
      });
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
