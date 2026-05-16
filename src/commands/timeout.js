const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  buildAuditReason,
  describeMember,
  ensureModerationAccess,
  fetchTargetMember,
  formatReason,
  getMemberManageBlockReason,
  handleCommandError,
  parseDuration,
  replyEphemeral,
  sendModerationLog,
} = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('暫時禁言成員')
    .addUserOption((option) => option.setName('user').setDescription('要 timeout 的成員').setRequired(true))
    .addStringOption((option) =>
      option.setName('duration').setDescription('時間，例如 10s、10m、1h、1d').setRequired(true)
    )
    .addStringOption((option) => option.setName('reason').setDescription('原因').setMaxLength(300)),

  async execute(interaction) {
    try {
      const user = interaction.options.getUser('user', true);
      const durationInput = interaction.options.getString('duration', true);
      const reason = formatReason(interaction.options.getString('reason'));
      const duration = parseDuration(durationInput);

      if (!duration) {
        await replyEphemeral(interaction, 'duration 格式請使用 10s、10m、1h、1d，最長 28 天。');
        return;
      }

      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.ModerateMembers,
        userPermissionName: 'Moderate Members',
        botPermissions: [PermissionFlagsBits.ModerateMembers],
        botPermissionNames: ['Moderate Members'],
      });

      if (!access.ok) {
        return;
      }

      const targetMember = await fetchTargetMember(interaction, user);

      if (!targetMember) {
        await replyEphemeral(interaction, '找不到這位伺服器成員，無法 timeout。');
        return;
      }

      const blockReason = getMemberManageBlockReason(interaction.guild, targetMember, access.botMember);

      if (blockReason) {
        await replyEphemeral(interaction, blockReason);
        return;
      }

      await targetMember.timeout(duration.ms, buildAuditReason('/timeout', interaction.user, reason));
      await interaction.reply({
        content: `已 timeout ${targetMember.user.tag} ${duration.label}。`,
        ephemeral: true,
      });
      await sendModerationLog(interaction, {
        action: '/timeout',
        target: describeMember(targetMember),
        reason: `${reason}；時長：${duration.input}`,
      });
    } catch (error) {
      await handleCommandError(interaction, error, 'timeout 失敗，請確認小吉權限與身分組位置。');
    }
  },
};
