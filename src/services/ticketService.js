const fs = require('node:fs');
const path = require('node:path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { getGuildConfig } = require('../utils/guildConfig');

const DEFAULT_TICKET_DATA_PATH = path.join(__dirname, '..', 'data', 'tickets.json');
const ticketLocks = new Map();

class TicketStateError extends Error {
  constructor(message, code = 'ticket_state_error') {
    super(message);
    this.name = 'TicketStateError';
    this.code = code;
  }
}

function getTicketDataPath() {
  return process.env.XIAOJI_TICKET_DATA_PATH || DEFAULT_TICKET_DATA_PATH;
}

function emptyState() {
  return { version: 1, tickets: [] };
}

function normalizeState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.tickets)) {
    throw new TicketStateError('客服單資料格式損毀，已停止操作以避免覆寫。', 'ticket_state_corrupt');
  }

  const hasInvalidTicket = value.tickets.some(
    (ticket) =>
      !ticket ||
      typeof ticket.guildId !== 'string' ||
      typeof ticket.channelId !== 'string' ||
      typeof ticket.ownerId !== 'string' ||
      !['open', 'closed'].includes(ticket.status)
  );

  if (hasInvalidTicket) {
    throw new TicketStateError('客服單資料包含無效紀錄，已停止操作以避免覆寫。', 'ticket_state_corrupt');
  }

  return {
    version: 1,
    tickets: value.tickets,
  };
}

function readTicketState() {
  const dataPath = getTicketDataPath();

  if (!fs.existsSync(dataPath)) {
    return emptyState();
  }

  try {
    const raw = fs.readFileSync(dataPath, 'utf8').trim();
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof TicketStateError) {
      throw error;
    }
    throw new TicketStateError('客服單資料無法讀取，已停止操作以避免重複開單。', 'ticket_state_corrupt');
  }
}

function writeTicketState(state) {
  const dataPath = getTicketDataPath();
  const directory = path.dirname(dataPath);
  const temporaryPath = `${dataPath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(directory, { recursive: true });

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, dataPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function getOpenTicket(state, guildId, ownerId) {
  return state.tickets.find(
    (ticket) => ticket.guildId === guildId && ticket.ownerId === ownerId && ticket.status === 'open'
  );
}

function getOpenTicketByChannel(state, guildId, channelId) {
  return state.tickets.find(
    (ticket) => ticket.guildId === guildId && ticket.channelId === channelId && ticket.status === 'open'
  );
}

function sanitizeChannelName(username) {
  const normalized = String(username || 'user')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return `ticket-${normalized || 'user'}`;
}

function withTicketLock(key, task) {
  const previous = ticketLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  ticketLocks.set(key, current);
  return current.finally(() => {
    if (ticketLocks.get(key) === current) {
      ticketLocks.delete(key);
    }
  });
}

async function fetchExistingChannel(guild, channelId) {
  try {
    return await guild.channels.fetch(channelId);
  } catch (error) {
    if (error?.code === 10003) {
      return null;
    }
    throw error;
  }
}

async function validateTicketConfiguration(guild, config = getGuildConfig(guild.id)) {
  const intakeChannelId = config.ticket?.intakeChannelId;
  const supportRoleId = config.ticket?.supportRoleId;

  if (!intakeChannelId || !supportRoleId) {
    throw new TicketStateError('此伺服器尚未完成客服頻道與客服角色設定。', 'ticket_not_configured');
  }

  const [intakeChannel, supportRole, botMember] = await Promise.all([
    guild.channels.fetch(intakeChannelId).catch(() => null),
    guild.roles.fetch(supportRoleId).catch(() => null),
    Promise.resolve(guild.members.me || guild.members.fetchMe()).catch(() => null),
  ]);

  if (!intakeChannel?.isTextBased?.() || !supportRole || !botMember) {
    throw new TicketStateError('客服設定已失效，請管理員重新設定後再試。', 'ticket_config_invalid');
  }

  if (!botMember.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    throw new TicketStateError('小吉缺少 Manage Channels 權限，無法安全建立私人客服頻道。', 'ticket_bot_permission');
  }

  return { intakeChannel, supportRole, botMember };
}

async function openTicket({ guild, channelId, user, subject = null, config = null }) {
  return withTicketLock(`${guild.id}:${user.id}`, async () => {
    const resolvedConfig = config || getGuildConfig(guild.id);
    const { intakeChannel, supportRole, botMember } = await validateTicketConfiguration(guild, resolvedConfig);

    if (channelId !== intakeChannel.id) {
      throw new TicketStateError(`請到 ${intakeChannel} 使用 \`/ticket open\`。`, 'ticket_wrong_channel');
    }

    const state = readTicketState();
    const existing = getOpenTicket(state, guild.id, user.id);

    if (existing) {
      const existingChannel = await fetchExistingChannel(guild, existing.channelId);
      if (existingChannel) {
        throw new TicketStateError(`你已經有開啟中的客服單：${existingChannel}`, 'ticket_duplicate');
      }
      existing.status = 'closed';
      existing.closedAt = new Date().toISOString();
      existing.closeReason = '原客服頻道已不存在';
      writeTicketState(state);
    }

    const permissionOverwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      {
        id: supportRole.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
      },
    ];

    const ticketChannel = await guild.channels.create({
      name: sanitizeChannelName(user.username),
      type: ChannelType.GuildText,
      parent: intakeChannel.parentId || undefined,
      topic: `小吉客服單 owner=${user.id}`,
      permissionOverwrites,
      reason: `客服單由 ${user.tag || user.id} 開啟`,
    });

    const ticket = {
      guildId: guild.id,
      channelId: ticketChannel.id,
      ownerId: user.id,
      supportRoleId: supportRole.id,
      subject: String(subject || '').trim().slice(0, 500) || null,
      status: 'open',
      openedAt: new Date().toISOString(),
    };

    try {
      const nextState = readTicketState();
      nextState.tickets.push(ticket);
      writeTicketState(nextState);
    } catch (error) {
      await ticketChannel.delete('客服單狀態無法持久化，回滾新頻道').catch(() => undefined);
      throw error;
    }

    try {
      await ticketChannel.send({
        content: `${user} 你好，客服人員 ${supportRole} 會在這裡協助你。${ticket.subject ? `\n主旨：${ticket.subject}` : ''}`,
        allowedMentions: { users: [user.id], roles: [supportRole.id] },
      });
    } catch (error) {
      await ticketChannel.delete('客服單起始訊息發送失敗，回滾新頻道').catch(() => undefined);
      const rollbackState = readTicketState();
      const rollbackTicket = getOpenTicketByChannel(rollbackState, guild.id, ticketChannel.id);
      if (rollbackTicket) {
        rollbackTicket.status = 'closed';
        rollbackTicket.closedAt = new Date().toISOString();
        rollbackTicket.closeReason = '客服單起始訊息發送失敗';
        writeTicketState(rollbackState);
      }
      throw error;
    }

    return { ticket, channel: ticketChannel };
  });
}

function canCloseTicket(member, supportRoleId, ownerOverride = false) {
  return Boolean(
    ownerOverride ||
      member?.permissions?.has(PermissionFlagsBits.Administrator) ||
      member?.permissions?.has(PermissionFlagsBits.ManageChannels) ||
      member?.roles?.cache?.has(supportRoleId)
  );
}

async function closeTicket({ guild, channelId, closer, closerMember, ownerOverride = false, reason = null }) {
  return withTicketLock(`${guild.id}:channel:${channelId}`, async () => {
    const state = readTicketState();
    const ticket = getOpenTicketByChannel(state, guild.id, channelId);

    if (!ticket) {
      throw new TicketStateError('這個頻道不是開啟中的客服單。', 'ticket_not_open');
    }

    if (!canCloseTicket(closerMember, ticket.supportRoleId, ownerOverride)) {
      throw new TicketStateError('只有客服角色或管理員可以關閉客服單。', 'ticket_close_forbidden');
    }

    const channel = await fetchExistingChannel(guild, channelId);
    if (!channel) {
      throw new TicketStateError('客服頻道已不存在，請管理員檢查客服單資料。', 'ticket_channel_missing');
    }

    await channel.delete(`客服單由 ${closer.tag || closer.id} 關閉：${reason || '未提供原因'}`);
    ticket.status = 'closed';
    ticket.closedAt = new Date().toISOString();
    ticket.closedBy = closer.id;
    ticket.closeReason = String(reason || '').trim().slice(0, 500) || null;
    writeTicketState(state);
    return ticket;
  });
}

function clearTicketLocksForTests() {
  ticketLocks.clear();
}

module.exports = {
  TicketStateError,
  canCloseTicket,
  clearTicketLocksForTests,
  closeTicket,
  getOpenTicket,
  getOpenTicketByChannel,
  getTicketDataPath,
  openTicket,
  readTicketState,
  sanitizeChannelName,
  validateTicketConfiguration,
  writeTicketState,
};
