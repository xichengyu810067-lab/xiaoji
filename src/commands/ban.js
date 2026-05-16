const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  buildAuditReason,
  describeMember,
  describeUser,
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
    .setName('ban')
    .setDescription('封鎖使用者')
    .addUserOption((option) => option.setName('user').setDescription('要封鎖的使用者').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('原因').setMaxLength(300)),

  async execute(interaction) {
    try {
      const user = interaction.options.getUser('user', true);
      const reason = formatReason(interaction.options.getString('reason'));
      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.BanMembers,
        userPermissionName: 'Ban Members',
        botPermissions: [PermissionFlagsBits.BanMembers],
        botPermissionNames: ['Ban Members'],
      });

      if (!access.ok) {
        return;
      }

      if (user.id === interaction.guild.ownerId) {
        await replyEphemeral(interaction, '小吉不能封鎖伺服器擁有者。');
        return;
      }

      const targetMember = await fetchTargetMember(interaction, user);

      if (targetMember) {
        const blockReason = getMemberManageBlockReason(interaction.guild, targetMember, access.botMember);

        if (blockReason) {
          await replyEphemeral(interaction, blockReason);
          return;
        }
      }

      await interaction.guild.members.ban(user.id, {
        reason: buildAuditReason('/ban', interaction.user, reason),
      });
      await interaction.reply({ content: `已封鎖 ${user.tag}。`, ephemeral: true });
      await sendModerationLog(interaction, {
        action: '/ban',
        target: targetMember ? describeMember(targetMember) : describeUser(user),
        reason,
      });
    } catch (error) {
      await handleCommandError(interaction, error, '封鎖失敗，請確認小吉權限與身分組位置。');
    }
  },
};
