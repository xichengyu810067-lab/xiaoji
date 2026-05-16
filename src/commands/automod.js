const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  addAllowedDomain,
  getGuildConfig,
  normalizeDomain,
  removeAllowedDomain,
  setAutomodOptions,
} = require('../utils/guildConfig');
const {
  ensureModerationAccess,
  handleCommandError,
  replyEphemeral,
  sendModerationLog,
} = require('../utils/moderation');

function formatStatus(config) {
  const automod = config.automod;
  const domains = automod.allowDomains.length > 0 ? automod.allowDomains.join(', ') : '無';

  return [
    `啟用：${automod.enabled ? '是' : '否'}`,
    `反洗版：${automod.spam.enabled ? '是' : '否'}`,
    `防廣告：${automod.ads.enabled ? '是' : '否'}`,
    `防大量標記：${automod.massMentions.enabled ? '是' : '否'}`,
    `允許網域：${domains}`,
    `重複違規 timeout：${automod.action.timeoutAfter} 次 / ${automod.action.timeoutMinutes} 分鐘`,
  ].join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('設定小吉自動防護')
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查看自動防護設定'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('set')
        .setDescription('開關自動防護功能')
        .addBooleanOption((option) => option.setName('enabled').setDescription('是否啟用自動防護'))
        .addBooleanOption((option) => option.setName('spam').setDescription('是否啟用反洗版'))
        .addBooleanOption((option) => option.setName('ads').setDescription('是否啟用防廣告'))
        .addBooleanOption((option) => option.setName('mass-mentions').setDescription('是否啟用防大量標記'))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('allow-domain')
        .setDescription('管理防廣告允許網域')
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('動作')
            .setRequired(true)
            .addChoices(
              { name: 'add', value: 'add' },
              { name: 'remove', value: 'remove' },
              { name: 'list', value: 'list' }
            )
        )
        .addStringOption((option) => option.setName('domain').setDescription('網域，例如 example.com').setMaxLength(120))
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

      if (subcommand === 'status') {
        await interaction.reply({ content: formatStatus(getGuildConfig(interaction.guildId)), ephemeral: true });
        return;
      }

      if (subcommand === 'set') {
        const updates = {};
        const enabled = interaction.options.getBoolean('enabled');
        const spam = interaction.options.getBoolean('spam');
        const ads = interaction.options.getBoolean('ads');
        const massMentions = interaction.options.getBoolean('mass-mentions');

        if (enabled !== null) updates.enabled = enabled;
        if (spam !== null) updates['spam.enabled'] = spam;
        if (ads !== null) updates['ads.enabled'] = ads;
        if (massMentions !== null) updates['massMentions.enabled'] = massMentions;

        if (Object.keys(updates).length === 0) {
          await replyEphemeral(interaction, '請至少指定一個要修改的開關。');
          return;
        }

        const config = setAutomodOptions(interaction.guildId, updates);
        await interaction.reply({ content: `自動防護設定已更新。\n${formatStatus(config)}`, ephemeral: true });
        await sendModerationLog(interaction, {
          action: '/automod set',
          target: interaction.guild.name,
          reason: Object.entries(updates)
            .map(([key, value]) => `${key}=${value}`)
            .join(', '),
        });
        return;
      }

      const action = interaction.options.getString('action', true);
      const domain = interaction.options.getString('domain');

      if (action === 'list') {
        await interaction.reply({ content: formatStatus(getGuildConfig(interaction.guildId)), ephemeral: true });
        return;
      }

      const normalizedDomain = normalizeDomain(domain);

      if (!normalizedDomain) {
        await replyEphemeral(interaction, '請輸入有效網域。');
        return;
      }

      const config =
        action === 'add'
          ? addAllowedDomain(interaction.guildId, normalizedDomain)
          : removeAllowedDomain(interaction.guildId, normalizedDomain);

      await interaction.reply({
        content: `允許網域已${action === 'add' ? '新增' : '移除'}：${normalizedDomain}\n${formatStatus(config)}`,
        ephemeral: true,
      });
      await sendModerationLog(interaction, {
        action: `/automod allow-domain ${action}`,
        target: normalizedDomain,
        reason: '更新防廣告允許網域',
      });
    } catch (error) {
      await handleCommandError(interaction, error, '自動防護設定失敗，請稍後再試。');
    }
  },
};
