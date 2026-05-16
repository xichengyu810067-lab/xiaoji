const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  buildAuditReason,
  describeMember,
  ensureModerationAccess,
  fetchTargetMember,
  formatReason,
  getMemberManageBlockReason,
  getRoleManageBlockReason,
  handleCommandError,
  replyEphemeral,
  sendModerationLog,
} = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('role-remove')
    .setDescription('移除成員身分組')
    .addUserOption((option) => option.setName('user').setDescription('要移除身分組的成員').setRequired(true))
    .addRoleOption((option) => option.setName('role').setDescription('要移除的身分組').setRequired(true)),

  async execute(interaction) {
    try {
      const user = interaction.options.getUser('user', true);
      const selectedRole = interaction.options.getRole('role', true);
      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.ManageRoles,
        userPermissionName: 'Manage Roles',
        botPermissions: [PermissionFlagsBits.ManageRoles],
        botPermissionNames: ['Manage Roles'],
      });

      if (!access.ok) {
        return;
      }

      const role = await interaction.guild.roles.fetch(selectedRole.id).catch(() => null);

      if (!role) {
        await replyEphemeral(interaction, '找不到這個身分組，請重新選擇。');
        return;
      }

      const targetMember = await fetchTargetMember(interaction, user);

      if (!targetMember) {
        await replyEphemeral(interaction, '找不到這位伺服器成員，無法移除身分組。');
        return;
      }

      const memberBlockReason = getMemberManageBlockReason(interaction.guild, targetMember, access.botMember);
      const roleBlockReason = getRoleManageBlockReason(role, access.botMember);

      if (memberBlockReason || roleBlockReason) {
        await replyEphemeral(interaction, memberBlockReason || roleBlockReason);
        return;
      }

      if (!targetMember.roles.cache.has(role.id)) {
        await replyEphemeral(interaction, `${targetMember.user.tag} 沒有 ${role.name} 身分組。`);
        return;
      }

      const reason = formatReason(`移除身分組 ${role.name}`);
      await targetMember.roles.remove(role, buildAuditReason('/role-remove', interaction.user, reason));
      await interaction.reply({ content: `已從 ${targetMember.user.tag} 移除 ${role.name}。`, ephemeral: true });
      await sendModerationLog(interaction, {
        action: '/role-remove',
        target: describeMember(targetMember),
        reason,
      });
    } catch (error) {
      await handleCommandError(interaction, error, '移除身分組失敗，請確認小吉權限與身分組位置。');
    }
  },
};
