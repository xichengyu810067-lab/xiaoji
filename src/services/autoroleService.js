const { PermissionFlagsBits } = require('discord.js');
const { getGuildConfig } = require('../utils/guildConfig');
const { getRoleManageBlockReason } = require('../utils/moderation');
const { sendGuildLog } = require('./guildLogService');
const logger = require('../utils/logger');

async function fetchBotMember(guild) {
  return guild.members.me || guild.members.fetchMe();
}

async function validateAutorole(guild, role) {
  const botMember = await fetchBotMember(guild);

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, message: '小吉缺少 Manage Roles 權限。' };
  }

  const blockReason = getRoleManageBlockReason(role, botMember);

  if (blockReason) {
    return { ok: false, message: blockReason };
  }

  return { ok: true, botMember };
}

async function handleGuildMemberAdd(member) {
  const config = getGuildConfig(member.guild.id);
  const roleId = config.autorole.roleId;

  if (!roleId || member.user.bot) {
    return;
  }

  const role = await member.guild.roles.fetch(roleId).catch(() => null);

  if (!role) {
    logger.warn(`Autorole role ${roleId} no longer exists in guild ${member.guild.id}`);
    return;
  }

  const validation = await validateAutorole(member.guild, role);

  if (!validation.ok) {
    logger.warn(`Autorole skipped in guild ${member.guild.id}: ${validation.message}`);
    return;
  }

  await member.roles.add(role, '小吉 autorole：新成員自動身分組');
  await sendGuildLog(member.guild, {
    title: '自動身分組',
    color: 0x22c55e,
    fields: [
      { name: '成員', value: `${member.user.tag} (${member.id})` },
      { name: '身分組', value: `${role.name} (${role.id})` },
    ],
  });
}

module.exports = {
  handleGuildMemberAdd,
  validateAutorole,
};
