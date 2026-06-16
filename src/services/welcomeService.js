const { PermissionFlagsBits } = require('discord.js');
const { getGuildConfig } = require('../utils/guildConfig');
const logger = require('../utils/logger');

function formatWelcomeMessage(member) {
  return `歡迎 ${member} 加入伺服器！小吉在這裡向你打招呼～`;
}

async function fetchBotMember(guild) {
  return guild.members.me || guild.members.fetchMe();
}

function canSendWelcome(channel, botMember) {
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
    return false;
  }

  const permissions = channel.permissionsFor?.(botMember);

  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
      permissions?.has(PermissionFlagsBits.SendMessages)
  );
}

async function handleGuildMemberWelcome(member, options = {}) {
  if (!member?.guild || member.user?.bot) {
    return false;
  }

  const config = options.config || getGuildConfig(member.guild.id);
  const channelId = config.welcomeChannelId;

  if (!channelId) {
    return false;
  }

  const channel = await member.guild.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    logger.warn(`Welcome channel ${channelId} no longer exists in guild ${member.guild.id}`);
    return false;
  }

  const botMember = await fetchBotMember(member.guild).catch(() => null);
  if (!botMember || !canSendWelcome(channel, botMember)) {
    logger.warn(`Welcome skipped in guild ${member.guild.id}: missing channel permissions`);
    return false;
  }

  await channel.send({
    content: formatWelcomeMessage(member),
    allowedMentions: { users: [member.id], roles: [] },
  });

  return true;
}

module.exports = {
  canSendWelcome,
  formatWelcomeMessage,
  handleGuildMemberWelcome,
};
