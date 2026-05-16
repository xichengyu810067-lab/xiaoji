const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildConfig } = require('../utils/guildConfig');
const logger = require('../utils/logger');

function truncate(value, maxLength = 1024) {
  const text = String(value ?? '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

async function fetchBotMember(guild) {
  return guild.members.me || guild.members.fetchMe();
}

async function sendGuildLog(guild, { title, color = 0xf59e0b, fields = [] }) {
  try {
    const config = getGuildConfig(guild.id);

    if (!config.logChannelId) {
      return;
    }

    const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);

    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
      return;
    }

    const botMember = await fetchBotMember(guild);
    const permissions = channel.permissionsFor?.(botMember);

    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions?.has(PermissionFlagsBits.SendMessages) ||
      !permissions?.has(PermissionFlagsBits.EmbedLinks)
    ) {
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(truncate(title, 256))
      .setTimestamp(new Date())
      .addFields(
        fields.map((field) => ({
          name: truncate(field.name, 256),
          value: truncate(field.value, 1024) || '-',
          inline: Boolean(field.inline),
        }))
      );

    await channel.send({ embeds: [embed] });
  } catch (error) {
    logger.warn(`Failed to send guild log: ${error?.code ?? 'unknown'} ${error?.message ?? ''}`);
  }
}

module.exports = {
  sendGuildLog,
  truncate,
};
