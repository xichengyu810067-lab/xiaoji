const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { getGuildConfig, setAutorole } = require('../utils/guildConfig');
const { validateAutorole } = require('../services/autoroleService');
const {
  ensureModerationAccess,
  handleCommandError,
  replyEphemeral,
  sendModerationLog,
} = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('設定新成員自動加入的身分組')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('set')
        .setDescription('設定自動身分組')
        .addRoleOption((option) => option.setName('role').setDescription('新成員要取得的身分組').setRequired(true))
    )
    .addSubcommand((subcommand) => subcommand.setName('off').setDescription('關閉自動身分組'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查看目前自動身分組設定')),

  async execute(interaction) {
    try {
      const subcommand = interaction.options.getSubcommand();
      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.ManageRoles,
        userPermissionName: 'Manage Roles',
        botPermissions: [PermissionFlagsBits.ManageRoles],
        botPermissionNames: ['Manage Roles'],
      });

      if (!access.ok) {
        return;
      }

      if (subcommand === 'status') {
        const config = getGuildConfig(interaction.guildId);
        const roleText = config.autorole.roleId ? `<@&${config.autorole.roleId}>` : '未設定';
        await interaction.reply({ content: `目前自動身分組：${roleText}`, ephemeral: true });
        return;
      }

      if (subcommand === 'off') {
        setAutorole(interaction.guildId, null);
        await interaction.reply({ content: '已關閉自動身分組。', ephemeral: true });
        await sendModerationLog(interaction, {
          action: '/autorole off',
          target: interaction.guild.name,
          reason: '關閉自動身分組',
        });
        return;
      }

      const selectedRole = interaction.options.getRole('role', true);
      const role = await interaction.guild.roles.fetch(selectedRole.id).catch(() => null);

      if (!role) {
        await replyEphemeral(interaction, '找不到這個身分組，請重新選擇。');
        return;
      }

      const validation = await validateAutorole(interaction.guild, role);

      if (!validation.ok) {
        await replyEphemeral(interaction, validation.message);
        return;
      }

      setAutorole(interaction.guildId, role.id);
      await interaction.reply({ content: `已設定新成員自動取得 ${role}。`, ephemeral: true });
      await sendModerationLog(interaction, {
        action: '/autorole set',
        target: `${role.name} (${role.id})`,
        reason: '設定新成員自動身分組',
      });
    } catch (error) {
      await handleCommandError(interaction, error, '自動身分組設定失敗，請確認小吉權限與身分組位置。');
    }
  },
};
