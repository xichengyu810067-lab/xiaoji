const { SlashCommandBuilder } = require('discord.js');
const { listShopItems } = require('../services/coinService');
const { formatShopItemLine, replyCoinError } = require('../utils/coinPresentation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('查看目前伺服器的吉幣商店')
    .addIntegerOption((option) => option.setName('page').setDescription('頁數').setMinValue(1)),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '商店只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const page = interaction.options.getInteger('page') || 1;
      const result = await listShopItems(interaction.guildId, { page, limit: 10 });

      if (result.items.length === 0) {
        await interaction.reply({ content: '目前商店沒有可購買的商品。', ephemeral: true });
        return;
      }

      await interaction.reply({
        content: [`**吉幣商店｜第 ${result.page} 頁**`, ...result.items.map(formatShopItemLine)].join('\n\n'),
        ephemeral: true,
      });
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
