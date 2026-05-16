const { PermissionFlagsBits } = require('discord.js');
const { getGuildConfig } = require('../utils/guildConfig');
const {
  canUseModCommand,
  getMemberManageBlockReason,
} = require('../utils/moderation');
const { sendGuildLog } = require('./guildLogService');
const logger = require('../utils/logger');

const messageHistory = new Map();
const infractionHistory = new Map();
const urlPattern = /https?:\/\/[^\s<>()]+/gi;
const discordInvitePattern = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;
const suspiciousWords = [
  'free nitro',
  'steam gift',
  'airdrop',
  '免費 nitro',
  '免費領',
  '抽獎群',
  '加賴',
  '代儲',
  '賺錢',
];

function getHistoryKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function normalizeMessageContent(content) {
  return String(content || '')
    .toLowerCase()
    .replace(/<@!?\d+>/g, '@user')
    .replace(/<@&\d+>/g, '@role')
    .replace(/\s+/g, ' ')
    .trim();
}

function pruneTimestamps(timestamps, now, windowMs) {
  return timestamps.filter((timestamp) => now - timestamp <= windowMs);
}

function getMessageHistory(key, now, maxWindowMs) {
  const records = messageHistory.get(key) || [];
  const freshRecords = records.filter((record) => now - record.timestamp <= maxWindowMs);
  messageHistory.set(key, freshRecords);
  return freshRecords;
}

function detectSpam({ guildId, userId, content }, config, now = Date.now()) {
  if (!config.spam.enabled) {
    return null;
  }

  const key = getHistoryKey(guildId, userId);
  const normalizedContent = normalizeMessageContent(content);
  const maxWindowMs = Math.max(config.spam.windowSeconds, config.spam.repeatedWindowSeconds) * 1000;
  const records = getMessageHistory(key, now, maxWindowMs);

  records.push({
    timestamp: now,
    content: normalizedContent,
  });

  messageHistory.set(key, records);

  const burstWindowMs = config.spam.windowSeconds * 1000;
  const burstCount = records.filter((record) => now - record.timestamp <= burstWindowMs).length;

  if (burstCount > config.spam.maxMessages) {
    return '短時間內傳送太多訊息';
  }

  if (normalizedContent) {
    const repeatedWindowMs = config.spam.repeatedWindowSeconds * 1000;
    const repeatedCount = records.filter(
      (record) => now - record.timestamp <= repeatedWindowMs && record.content === normalizedContent
    ).length;

    if (repeatedCount >= config.spam.repeatedMessages) {
      return '重複傳送相同訊息';
    }
  }

  return null;
}

function getUrlDomains(content) {
  return Array.from(String(content || '').matchAll(urlPattern))
    .map((match) => {
      try {
        return new URL(match[0]).hostname.toLowerCase().replace(/^www\./, '');
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isAllowedDomain(domain, allowDomains) {
  return allowDomains.some((allowedDomain) => domain === allowedDomain || domain.endsWith(`.${allowedDomain}`));
}

function detectAds(content, config) {
  if (!config.ads.enabled) {
    return null;
  }

  if (config.ads.blockDiscordInvites && discordInvitePattern.test(content)) {
    return 'Discord 邀請連結';
  }

  const domains = getUrlDomains(content);

  if (!config.ads.blockSuspiciousLinks || domains.length === 0) {
    return null;
  }

  const normalizedContent = normalizeMessageContent(content);
  const containsSuspiciousWord = suspiciousWords.some((word) => normalizedContent.includes(word));
  const untrustedDomains = domains.filter((domain) => !isAllowedDomain(domain, config.allowDomains));

  if (untrustedDomains.length >= 2 || (containsSuspiciousWord && untrustedDomains.length > 0)) {
    return `可疑廣告連結：${untrustedDomains.slice(0, 3).join(', ')}`;
  }

  return null;
}

function getMentionStatsFromContent(content) {
  const text = String(content || '');
  const userMentions = new Set(Array.from(text.matchAll(/<@!?(\d+)>/g)).map((match) => match[1]));
  const roleMentions = new Set(Array.from(text.matchAll(/<@&(\d+)>/g)).map((match) => match[1]));

  return {
    userCount: userMentions.size,
    roleCount: roleMentions.size,
    everyoneHere: /@(everyone|here)\b/.test(text),
  };
}

function getMentionStats(message) {
  return {
    userCount: message.mentions?.users?.size ?? getMentionStatsFromContent(message.content).userCount,
    roleCount: message.mentions?.roles?.size ?? getMentionStatsFromContent(message.content).roleCount,
    everyoneHere: Boolean(message.mentions?.everyone) || getMentionStatsFromContent(message.content).everyoneHere,
  };
}

function detectMassMentions(message, config) {
  if (!config.massMentions.enabled) {
    return null;
  }

  const stats = getMentionStats(message);
  const mentionCount = stats.userCount + stats.roleCount;

  if (config.massMentions.blockEveryoneHere && stats.everyoneHere) {
    return '@everyone 或 @here 標記';
  }

  if (mentionCount > config.massMentions.maxMentions) {
    return `大量標記 ${mentionCount} 個對象`;
  }

  return null;
}

function detectAutomodViolations(message, config, now = Date.now()) {
  const violations = [];
  const spamReason = detectSpam(
    {
      guildId: message.guildId,
      userId: message.author.id,
      content: message.content,
    },
    config,
    now
  );
  const adReason = detectAds(message.content, config);
  const mentionReason = detectMassMentions(message, config);

  if (spamReason) {
    violations.push({ type: 'spam', reason: spamReason });
  }

  if (adReason) {
    violations.push({ type: 'ads', reason: adReason });
  }

  if (mentionReason) {
    violations.push({ type: 'mass_mentions', reason: mentionReason });
  }

  return violations;
}

function shouldBypassAutomod(message) {
  if (!message.member) {
    return false;
  }

  return (
    message.member.id === message.guild.ownerId ||
    message.member.permissions?.has(PermissionFlagsBits.Administrator) ||
    message.member.permissions?.has(PermissionFlagsBits.ManageMessages) ||
    canUseModCommand(message.member)
  );
}

function recordInfraction(guildId, userId, config, now = Date.now()) {
  const key = getHistoryKey(guildId, userId);
  const windowMs = config.action.infractionWindowMinutes * 60 * 1000;
  const timestamps = pruneTimestamps(infractionHistory.get(key) || [], now, windowMs);

  timestamps.push(now);
  infractionHistory.set(key, timestamps);
  return timestamps.length;
}

async function deleteMessage(message, config) {
  if (!config.action.deleteMessage || !message.deletable) {
    return false;
  }

  try {
    await message.delete();
    return true;
  } catch (error) {
    logger.warn(`Automod failed to delete message ${message.id}: ${error?.code ?? 'unknown'} ${error?.message ?? ''}`);
    return false;
  }
}

async function warnUser(message, violations, deleted) {
  const reasonText = violations.map((violation) => violation.reason).join('、');
  const warning = `小吉提醒：你的訊息因為「${reasonText}」${deleted ? '已被刪除' : '已被記錄'}，請避免洗版、廣告或大量標記。`;

  try {
    await message.author.send(warning);
    return;
  } catch {
    // DM may be disabled. Fall back to a short channel warning.
  }

  try {
    const warningMessage = await message.channel.send({
      content: `${message.author} ${warning}`,
      allowedMentions: { users: [message.author.id], roles: [] },
    });
    setTimeout(() => warningMessage.delete().catch(() => {}), 8000);
  } catch (error) {
    logger.warn(`Automod failed to warn user: ${error?.code ?? 'unknown'} ${error?.message ?? ''}`);
  }
}

async function timeoutIfNeeded(message, config, infractionCount) {
  if (infractionCount < config.action.timeoutAfter || !message.member?.manageable) {
    return false;
  }

  const botMember = message.guild.members.me || (await message.guild.members.fetchMe());
  const blockReason = getMemberManageBlockReason(message.guild, message.member, botMember);

  if (blockReason || !botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return false;
  }

  const timeoutMs = config.action.timeoutMinutes * 60 * 1000;
  await message.member.timeout(timeoutMs, '小吉 automod：重複違規');
  return true;
}

async function handleAutomodMessage(message) {
  if (!message.inGuild?.() || !message.guild || !message.content) {
    return false;
  }

  const config = getGuildConfig(message.guildId).automod;

  if (!config.enabled || shouldBypassAutomod(message)) {
    return false;
  }

  const violations = detectAutomodViolations(message, config);

  if (violations.length === 0) {
    return false;
  }

  logger.warn(`[SAFETY_BLOCK] User ${message.author.tag} violated automod: ${violations.map(v => v.reason).join(', ')}`);

  const deleted = await deleteMessage(message, config);
  const infractionCount = recordInfraction(message.guildId, message.author.id, config);
  let timedOut = false;

  if (config.action.warnUser) {
    await warnUser(message, violations, deleted);
  }

  try {
    timedOut = await timeoutIfNeeded(message, config, infractionCount);
  } catch (error) {
    logger.warn(`Automod timeout failed: ${error?.code ?? 'unknown'} ${error?.message ?? ''}`);
  }

  await sendGuildLog(message.guild, {
    title: '自動防護',
    color: 0xef4444,
    fields: [
      { name: '使用者', value: `${message.author.tag} (${message.author.id})` },
      { name: '原因', value: violations.map((violation) => violation.reason).join('\n') },
      { name: '處置', value: `${deleted ? '已刪除訊息' : '未刪除訊息'}${timedOut ? '，已 timeout' : ''}` },
      { name: '頻道', value: `${message.channel} (${message.channelId})` },
    ],
  });

  return true;
}

module.exports = {
  detectAds,
  detectAutomodViolations,
  detectMassMentions,
  detectSpam,
  getMentionStatsFromContent,
  getUrlDomains,
  handleAutomodMessage,
  normalizeMessageContent,
  recordInfraction,
};
