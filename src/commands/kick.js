const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  buildAuditReason,
  describeMember,
  ensureModerationAccess,
  fetchTargetMember,
  formatReason,
  getMemberManageBlockReason,
  handleCommandError,
  replyEphemeral,
  sendModerationLog,
} = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('踢出成員')
    .addUserOption((option) => option.setName('user').setDescription('要踢出的成員').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('原因').setMaxLength(300)),

  async execute(interaction) {
    try {
      const user = interaction.options.getUser('user', true);
      const reason = formatReason(interaction.options.getString('reason'));
      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.KickMembers,
        userPermissionName: 'Kick Members',
        botPermissions: [PermissionFlagsBits.KickMembers],
        botPermissionNames: ['Kick Members'],
      });

      if (!access.ok) {
        return;
      }

      const targetMember = await fetchTargetMember(interaction, user);

      if (!targetMember) {
        await replyEphemeral(interaction, '找不到這位伺服器成員，無法踢出。');
        return;
      }

      const blockReason = getMemberManageBlockReason(interaction.guild, targetMember, access.botMember);

      if (blockReason) {
        await replyEphemeral(interaction, blockReason);
        return;
      }

      await targetMember.kick(buildAuditReason('/kick', interaction.user, reason));
      await interaction.reply({ content: `已踢出 ${targetMember.user.tag}。`, ephemeral: true });
      await sendModerationLog(interaction, {
        action: '/kick',
        target: describeMember(targetMember),
        reason,
      });
    } catch (error) {
      await handleCommandError(interaction, error, '踢出失敗，請確認小吉權限與身分組位置。');
    }
  },
};
