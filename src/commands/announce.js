const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { getGuildConfig } = require('../utils/guildConfig');
const {
  ensureModerationAccess,
  handleCommandError,
  replyEphemeral,
  sendModerationLog,
} = require('../utils/moderation');

function buildAnnouncementContent(title, message) {
  return [title ? `**${title.trim()}**` : null, message.trim()].filter(Boolean).join('\n\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('讓小吉發送公告')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('公告頻道')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addStringOption((option) =>
      option.setName('message').setDescription('公告內容').setRequired(true).setMaxLength(1800)
    )
    .addStringOption((option) => option.setName('title').setDescription('公告標題').setMaxLength(100))
    .addBooleanOption((option) =>
      option.setName('allow-mentions').setDescription('是否允許公告實際觸發 @everyone、身分組或使用者標記')
    ),

  async execute(interaction) {
    const { isGuildApproved } = require('../services/auditService');
    const { isBotOwner } = require('../utils/ownerOnly');

    // Audit Check
    if (interaction.guildId && !isBotOwner(interaction.user.id)) {
      if (!isGuildApproved(interaction.guildId)) {
        await replyEphemeral(interaction, '此伺服器尚未通過小吉擁有者審核，因此不能使用公告功能。');
        return;
      }
    }

    try {
      const selectedChannel = interaction.options.getChannel('channel', true);
      const channel = await interaction.guild.channels.fetch(selectedChannel.id).catch(() => null);
      const message = interaction.options.getString('message', true);
      const title = interaction.options.getString('title');
      const allowMentionOption = interaction.options.getBoolean('allow-mentions');
      const allowMentions =
        allowMentionOption === null ? getGuildConfig(interaction.guildId).announce.allowMentions : allowMentionOption;
      const content = buildAnnouncementContent(title, message);

      if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        await replyEphemeral(interaction, '請選擇可以傳送公告的文字頻道。');
        return;
      }

      if (content.length > 2000) {
        await replyEphemeral(interaction, '公告內容太長，請縮短標題或內容。');
        return;
      }

      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.ManageGuild,
        userPermissionName: 'Manage Server',
        botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        botPermissionNames: ['View Channel', 'Send Messages'],
        permissionChannel: channel,
      });

      if (!access.ok) {
        return;
      }

      await channel.send({
        content,
        allowedMentions: allowMentions ? { parse: ['users', 'roles', 'everyone'] } : { parse: [] },
      });
      await interaction.reply({ content: `公告已送出到 ${channel}。`, ephemeral: true });
      await sendModerationLog(interaction, {
        action: '/announce',
        target: `${channel} (${channel.id})`,
        reason: allowMentions ? '公告允許 mention' : '公告未觸發 mention',
      });
    } catch (error) {
      await handleCommandError(interaction, error, '公告發送失敗，請確認小吉在該頻道的權限。');
    }
  },
};
