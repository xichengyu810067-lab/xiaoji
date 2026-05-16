const { PermissionFlagsBits } = require('discord.js');
const { sendGuildLog, truncate } = require('../services/guildLogService');
const logger = require('./logger');

const DISCORD_BULK_DELETE_TOO_OLD = 50034;
const DISCORD_MISSING_PERMISSIONS = 50013;
const DISCORD_UNKNOWN_BAN = 10026;
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

function canUseModCommand(member) {
  return Boolean(member?.guild && member.permissions?.has(PermissionFlagsBits.Administrator));
}

function formatReason(reason) {
  const normalized = reason?.trim();
  return normalized || '未提供原因';
}

function buildAuditReason(action, executor, reason) {
  return truncate(`${action} by ${executor.tag} (${executor.id}): ${formatReason(reason)}`, 512);
}

function parseDuration(input) {
  const match = String(input || '')
    .trim()
    .match(/^(\d+)([smhd])$/i);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }

  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  const labels = {
    s: '秒',
    m: '分鐘',
    h: '小時',
    d: '天',
  };
  const ms = amount * multipliers[unit];

  if (ms > MAX_TIMEOUT_MS) {
    return null;
  }

  return {
    input: `${amount}${unit}`,
    label: `${amount} ${labels[unit]}`,
    ms,
  };
}

async function replyEphemeral(interaction, content) {
  const payload = typeof content === 'string' ? { content, ephemeral: true } : { ...content, ephemeral: true };

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

async function fetchBotMember(guild) {
  return guild.members.me || guild.members.fetchMe();
}

function hasAllPermissions(permissions, requiredPermissions) {
  return requiredPermissions.every((permission) => permissions?.has(permission));
}

async function ensureModerationAccess(
  interaction,
  {
    userPermission = PermissionFlagsBits.Administrator,
    userPermissionName = 'Administrator',
    botPermissions = [],
    botPermissionNames = [],
    permissionChannel = null,
  }
) {
  if (!interaction.inGuild() || !interaction.guild) {
    await replyEphemeral(interaction, '這個管理指令只能在伺服器內使用。');
    return { ok: false };
  }

  const { isBotOwner } = require('./ownerOnly');
  const executorMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const memberPermissions = interaction.memberPermissions || executorMember?.permissions;
  
  const isOwner = isBotOwner(interaction.user.id);
  const hasUserPermission = memberPermissions?.has(userPermission) || memberPermissions?.has(PermissionFlagsBits.Administrator);
  const canUse = isOwner || hasUserPermission;

  if (!canUse) {
    logger.warn(`[PERMISSION_BLOCK] User ${interaction.user.tag} denied access to mod command /${interaction.commandName}`);
    await replyEphemeral(interaction, `只有該伺服器的管理員 (${userPermissionName}) 可以使用 /${interaction.commandName}。`);
    return { ok: false };
  }

  const botMember = await fetchBotMember(interaction.guild);
  const botPermissionSource = permissionChannel?.permissionsFor?.(botMember) || botMember.permissions;

  if (botPermissions.length > 0 && !hasAllPermissions(botPermissionSource, botPermissions)) {
    logger.warn(`[PERMISSION_BLOCK] Bot missing permissions ${botPermissionNames.join(', ')} for /${interaction.commandName}`);
    await replyEphemeral(
      interaction,
      `小吉需要 ${botPermissionNames.join(', ')} 權限才能執行 /${interaction.commandName}。`
    );
    return { ok: false };
  }

  return { ok: true, botMember, executorMember };
}

async function fetchTargetMember(interaction, user) {
  try {
    return await interaction.guild.members.fetch(user.id);
  } catch {
    return null;
  }
}

function getMemberManageBlockReason(guild, targetMember, botMember) {
  if (targetMember.id === guild.ownerId) {
    return '小吉不能管理伺服器擁有者。';
  }

  if (targetMember.id === botMember.id) {
    return '小吉不能對自己執行這個動作。';
  }

  if (botMember.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
    return '小吉的最高身分組必須高於目標成員。';
  }

  return null;
}

function getRoleManageBlockReason(role, botMember) {
  if (role.id === role.guild.id) {
    return '小吉不能管理 @everyone 身分組。';
  }

  if (role.managed) {
    return '小吉不能管理 Discord 或整合服務自動管理的身分組。';
  }

  if (role.comparePositionTo(botMember.roles.highest) >= 0) {
    return '小吉的最高身分組必須高於這個身分組。';
  }

  return null;
}

function describeUser(user) {
  return `${user.tag} (${user.id})`;
}

function describeMember(member) {
  return `${member.user.tag} (${member.id})`;
}

function getFriendlyDiscordError(error, fallbackMessage) {
  if (error?.code === DISCORD_MISSING_PERMISSIONS) {
    return '小吉缺少執行此操作所需的 Discord 權限，請檢查 bot 權限與身分組位置。';
  }

  if (error?.code === DISCORD_BULK_DELETE_TOO_OLD) {
    return 'Discord 不允許批次刪除超過 14 天前的訊息。';
  }

  if (error?.code === DISCORD_UNKNOWN_BAN) {
    return '找不到這個使用者的封鎖紀錄。';
  }

  return fallbackMessage;
}

async function handleCommandError(interaction, error, fallbackMessage = '執行失敗，請稍後再試。') {
  const friendlyMessage = getFriendlyDiscordError(error, fallbackMessage);
  logger.warn(`/${interaction.commandName} failed: ${error?.code || 'unknown'} ${error?.message || ''}`);
  await replyEphemeral(interaction, friendlyMessage);
}

async function sendModerationLog(interaction, { action, target, reason }) {
  if (!interaction.guild) {
    return;
  }

  await sendGuildLog(interaction.guild, {
    title: '管理紀錄',
    color: 0xf59e0b,
    fields: [
      { name: '動作', value: action, inline: true },
      { name: '執行者', value: describeUser(interaction.user) },
      { name: '目標', value: target },
      { name: '原因', value: formatReason(reason) },
    ],
  });
}

module.exports = {
  DISCORD_BULK_DELETE_TOO_OLD,
  buildAuditReason,
  canUseModCommand,
  describeMember,
  describeUser,
  ensureModerationAccess,
  fetchTargetMember,
  formatReason,
  getFriendlyDiscordError,
  getMemberManageBlockReason,
  getRoleManageBlockReason,
  handleCommandError,
  parseDuration,
  replyEphemeral,
  sendModerationLog,
};
