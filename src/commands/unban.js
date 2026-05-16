const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  buildAuditReason,
  describeUser,
  ensureModerationAccess,
  formatReason,
  handleCommandError,
  replyEphemeral,
  sendModerationLog,
} = require('../utils/moderation');

const snowflakePattern = /^\d{17,20}$/;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('解除封鎖使用者')
    .addStringOption((option) =>
      option.setName('user-id').setDescription('要解除封鎖的使用者 ID').setRequired(true)
    )
    .addStringOption((option) => option.setName('reason').setDescription('原因').setMaxLength(300)),

  async execute(interaction) {
    try {
      const userId = interaction.options.getString('user-id', true).trim();
      const reason = formatReason(interaction.options.getString('reason'));

      if (!snowflakePattern.test(userId)) {
        await replyEphemeral(interaction, '請提供有效的 Discord user ID。');
        return;
      }

      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.BanMembers,
        userPermissionName: 'Ban Members',
        botPermissions: [PermissionFlagsBits.BanMembers],
        botPermissionNames: ['Ban Members'],
      });

      if (!access.ok) {
        return;
      }

      const ban = await interaction.guild.bans.fetch(userId).catch(() => null);

      if (!ban) {
        await replyEphemeral(interaction, '找不到這個使用者的封鎖紀錄。');
        return;
      }

      const user = await interaction.guild.bans.remove(userId, buildAuditReason('/unban', interaction.user, reason));
      await interaction.reply({ content: `已解除封鎖 ${user?.tag ?? userId}。`, ephemeral: true });
      await sendModerationLog(interaction, {
        action: '/unban',
        target: user ? describeUser(user) : describeUser(ban.user),
        reason,
      });
    } catch (error) {
      await handleCommandError(interaction, error, '解除封鎖失敗，請確認 user ID 與小吉權限。');
    }
  },
};
