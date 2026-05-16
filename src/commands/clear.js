const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  ensureModerationAccess,
  handleCommandError,
  replyEphemeral,
  sendModerationLog,
} = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('刪除近期訊息')
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('要刪除的訊息數量，限 1 到 100')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    ),

  async execute(interaction) {
    try {
      const amount = interaction.options.getInteger('amount', true);
      const channel = interaction.channel;

      if (amount < 1 || amount > 100) {
        await replyEphemeral(interaction, '請輸入 1 到 100 之間的訊息數量。');
        return;
      }

      if (!channel?.isTextBased?.() || typeof channel.bulkDelete !== 'function') {
        await replyEphemeral(interaction, '這個頻道不支援批次刪除訊息。');
        return;
      }

      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.ManageMessages,
        userPermissionName: 'Manage Messages',
        botPermissions: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
        botPermissionNames: ['View Channel', 'Read Message History', 'Manage Messages'],
        permissionChannel: channel,
      });

      if (!access.ok) {
        return;
      }

      const deleted = await channel.bulkDelete(amount, true);
      const skipped = amount - deleted.size;
      const content =
        skipped > 0
          ? `已刪除 ${deleted.size} 則訊息；${skipped} 則可能太舊或無法批次刪除。`
          : `已刪除 ${deleted.size} 則訊息。`;

      await interaction.reply({ content, ephemeral: true });
      await sendModerationLog(interaction, {
        action: '/clear',
        target: `${channel} (${channel.id})`,
        reason: `刪除 ${deleted.size} 則訊息`,
      });
    } catch (error) {
      await handleCommandError(
        interaction,
        error,
        '刪除訊息失敗，請確認小吉有 Manage Messages 權限，且訊息不是超過 14 天的舊訊息。'
      );
    }
  },
};
