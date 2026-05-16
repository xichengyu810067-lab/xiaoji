const { AttachmentBuilder, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { getExportableGuildConfig } = require('../utils/guildConfig');
const { ensureModerationAccess, handleCommandError } = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder().setName('export-config').setDescription('匯出目前伺服器設定'),

  async execute(interaction) {
    try {
      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.ManageGuild,
        userPermissionName: 'Manage Server',
      });

      if (!access.ok) {
        return;
      }

      const payload = {
        guildName: interaction.guild.name,
        ...getExportableGuildConfig(interaction.guildId),
      };
      const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(payload, null, 2), 'utf8'), {
        name: `xiaoji-config-${interaction.guildId}.json`,
      });

      await interaction.reply({
        content: '已匯出伺服器設定。此檔案不包含 token 或 API key。',
        files: [attachment],
        ephemeral: true,
      });
    } catch (error) {
      await handleCommandError(interaction, error, '匯出設定失敗，請稍後再試。');
    }
  },
};
