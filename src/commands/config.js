const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  getGuildConfig,
  setAnnounceAllowMentions,
  setAntiSpamEnabled,
  setGuildLogChannel,
  setWeatherDefaultCity,
} = require('../utils/guildConfig');
const {
  ensureModerationAccess,
  handleCommandError,
  sendModerationLog,
} = require('../utils/moderation');

function formatConfig(config) {
  return [
    `log_channel: ${config.logChannelId ? `<#${config.logChannelId}>` : '未設定'}`,
    `anti_spam_enabled: ${config.automod.enabled && config.automod.spam.enabled ? 'true' : 'false'}`,
    `weather_default_city: ${config.weatherDefaultCity || '未設定'}`,
    `announce_allow_mentions: ${config.announce.allowMentions ? 'true' : 'false'}`,
  ].join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('設定伺服器設定')
    .addSubcommand((subcommand) => subcommand.setName('view').setDescription('查看目前設定'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('log-channel')
        .setDescription('設定 log_channel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('紀錄頻道')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('anti-spam')
        .setDescription('設定 anti_spam_enabled')
        .addBooleanOption((option) => option.setName('enabled').setDescription('是否啟用反洗版').setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('weather-default-city')
        .setDescription('設定 weather_default_city')
        .addStringOption((option) =>
          option.setName('city').setDescription('預設城市，例如 Taipei；輸入 off 可清除').setRequired(true).setMaxLength(100)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('announce-mentions')
        .setDescription('設定 announce_allow_mentions')
        .addBooleanOption((option) => option.setName('enabled').setDescription('公告預設是否允許 mention').setRequired(true))
    ),

  async execute(interaction) {
    try {
      const access = await ensureModerationAccess(interaction, {
        userPermission: PermissionFlagsBits.ManageGuild,
        userPermissionName: 'Manage Server',
      });

      if (!access.ok) {
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      let config;
      let reason;

      if (subcommand === 'view') {
        await interaction.reply({ content: formatConfig(getGuildConfig(interaction.guildId)), ephemeral: true });
        return;
      }

      if (subcommand === 'log-channel') {
        const channel = interaction.options.getChannel('channel', true);
        config = setGuildLogChannel(interaction.guildId, channel.id);
        reason = `log_channel=${channel.id}`;
      }

      if (subcommand === 'anti-spam') {
        const enabled = interaction.options.getBoolean('enabled', true);
        config = setAntiSpamEnabled(interaction.guildId, enabled);
        reason = `anti_spam_enabled=${enabled}`;
      }

      if (subcommand === 'weather-default-city') {
        const city = interaction.options.getString('city', true).trim();
        const normalizedCity = ['off', 'none', 'clear', '關閉', '清除'].includes(city.toLowerCase()) ? null : city;
        config = setWeatherDefaultCity(interaction.guildId, normalizedCity);
        reason = `weather_default_city=${normalizedCity || 'null'}`;
      }

      if (subcommand === 'announce-mentions') {
        const enabled = interaction.options.getBoolean('enabled', true);
        config = setAnnounceAllowMentions(interaction.guildId, enabled);
        reason = `announce_allow_mentions=${enabled}`;
      }

      await interaction.reply({
        content: `設定已更新。\n${formatConfig(config)}`,
        ephemeral: true,
      });
      await sendModerationLog(interaction, {
        action: `/config ${subcommand}`,
        target: interaction.guild.name,
        reason,
      });
    } catch (error) {
      await handleCommandError(interaction, error, '設定更新失敗，請稍後再試。');
    }
  },
};

module.exports.formatConfig = formatConfig;
