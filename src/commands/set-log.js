const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { setGuildLogChannel } = require('../utils/guildConfig');
const {
  ensureModerationAccess,
  handleCommandError,
  replyEphemeral,
  sendModerationLog,
} = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-log')
    .setDescription('設定管理紀錄頻道')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('要接收管理紀錄的頻道')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild() || !interaction.guild) {
        await replyEphemeral(interaction, '這個管理指令只能在伺服器內使用。');
        return;
      }

      const selectedChannel = interaction.options.getChannel('channel', true);
      const channel = await interaction.guild.channels.fetch(selectedChannel.id).catch(() => null);

      if (!channel) {
        await replyEphemeral(interaction, '找不到這個頻道，請重新選擇。');
        return;
      }

      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.ManageGuild,
        userPermissionName: 'Manage Server',
        botPermissions: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ],
        botPermissionNames: ['View Channel', 'Send Messages', 'Embed Links'],
        permissionChannel: channel,
      });

      if (!access.ok) {
        return;
      }

      if (!channel.isTextBased?.() || typeof channel.send !== 'function') {
        await replyEphemeral(interaction, '請選擇小吉可以傳送訊息的文字頻道。');
        return;
      }

      setGuildLogChannel(interaction.guildId, channel.id);
      await interaction.reply({ content: `已將管理紀錄頻道設定為 ${channel}。`, ephemeral: true });
      await sendModerationLog(interaction, {
        action: '/set-log',
        target: `${channel} (${channel.id})`,
        reason: '設定管理紀錄頻道',
      });
    } catch (error) {
      await handleCommandError(interaction, error, '設定管理紀錄頻道失敗，請稍後再試。');
    }
  },
};
