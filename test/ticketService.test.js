const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-ticket-test-'));
process.env.XIAOJI_TICKET_DATA_PATH = path.join(testRoot, 'tickets.json');

const {
  TicketStateError,
  canCloseTicket,
  clearTicketLocksForTests,
  closeTicket,
  getOpenTicket,
  openTicket,
  readTicketState,
  sanitizeChannelName,
  writeTicketState,
} = require('../src/services/ticketService');

test.beforeEach(() => {
  fs.rmSync(process.env.XIAOJI_TICKET_DATA_PATH, { force: true });
  clearTicketLocksForTests();
});

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
  delete process.env.XIAOJI_TICKET_DATA_PATH;
});

test('ticket state persists and isolates the same user across guilds', () => {
  writeTicketState({
    version: 1,
    tickets: [
      { guildId: 'guild-1', channelId: 'channel-1', ownerId: 'user-1', status: 'open' },
      { guildId: 'guild-2', channelId: 'channel-2', ownerId: 'user-1', status: 'open' },
    ],
  });

  const restored = readTicketState();
  assert.equal(getOpenTicket(restored, 'guild-1', 'user-1').channelId, 'channel-1');
  assert.equal(getOpenTicket(restored, 'guild-2', 'user-1').channelId, 'channel-2');
});

test('corrupt ticket state fails closed without overwriting the file', () => {
  fs.writeFileSync(process.env.XIAOJI_TICKET_DATA_PATH, '{broken', 'utf8');
  assert.throws(() => readTicketState(), (error) => error instanceof TicketStateError && error.code === 'ticket_state_corrupt');
  assert.equal(fs.readFileSync(process.env.XIAOJI_TICKET_DATA_PATH, 'utf8'), '{broken');
});

test('closeTicket does not overwrite corrupt ticket state', async () => {
  const { guild } = createGuild();
  fs.writeFileSync(process.env.XIAOJI_TICKET_DATA_PATH, '{broken', 'utf8');

  await assert.rejects(
    closeTicket({
      guild,
      channelId: 'missing-ticket',
      closer: { id: 'staff-1', tag: 'Staff#0001' },
      closerMember: supportMember('guild-1-support'),
    }),
    (error) => error instanceof TicketStateError && error.code === 'ticket_state_corrupt'
  );
  assert.equal(fs.readFileSync(process.env.XIAOJI_TICKET_DATA_PATH, 'utf8'), '{broken');
});

test('ticket close access allows support role and administrators only', () => {
  const member = (permissions = [], roles = []) => ({
    permissions: { has: (permission) => permissions.includes(permission) },
    roles: { cache: { has: (roleId) => roles.includes(roleId) } },
  });

  assert.equal(canCloseTicket(member([], ['support']), 'support'), true);
  assert.equal(canCloseTicket(member([PermissionFlagsBits.Administrator]), 'support'), true);
  assert.equal(canCloseTicket(member(), 'support'), false);
  assert.equal(canCloseTicket(null, 'support', true), true);
});

function createGuild(guildId = 'guild-1') {
  const created = [];
  const intake = { id: `${guildId}-intake`, parentId: `${guildId}-category`, isTextBased: () => true, toString: () => '#support' };
  const supportRole = { id: `${guildId}-support`, toString: () => '@Support' };
  const botMember = {
    id: `${guildId}-bot`,
    permissions: { has: (permission) => permission === PermissionFlagsBits.ManageChannels },
  };
  const channelCache = new Map([[intake.id, intake]]);

  return {
    channelCache,
    created,
    guild: {
      id: guildId,
      roles: {
        everyone: { id: guildId },
        fetch: async (roleId) => (roleId === supportRole.id ? supportRole : null),
      },
      members: { me: botMember },
      channels: {
        fetch: async (channelId) => channelCache.get(channelId) || null,
        create: async (payload) => {
          const sent = [];
          const channel = {
            id: `${guildId}-ticket-${created.length + 1}`,
            toString: () => `<#${guildId}-ticket-${created.length + 1}>`,
            send: async (message) => sent.push(message),
            delete: async () => channelCache.delete(channel.id),
            sent,
            payload,
          };
          created.push(channel);
          channelCache.set(channel.id, channel);
          return channel;
        },
      },
    },
    config: { ticket: { intakeChannelId: intake.id, supportRoleId: supportRole.id } },
  };
}

test('openTicket creates a private channel and rejects a duplicate after state reload', async () => {
  const { guild, config, created } = createGuild();
  const user = { id: 'user-1', username: 'Test User', tag: 'Test User#0001', toString: () => '<@user-1>' };

  const opened = await openTicket({ guild, channelId: 'guild-1-intake', user, subject: 'Help', config });
  assert.equal(opened.ticket.ownerId, 'user-1');
  assert.equal(created.length, 1);
  assert.equal(created[0].payload.parent, 'guild-1-category');
  assert.ok(created[0].payload.permissionOverwrites.some((entry) => entry.id === 'guild-1' && entry.deny));
  assert.equal(readTicketState().tickets.length, 1);

  await assert.rejects(
    openTicket({ guild, channelId: 'guild-1-intake', user, config }),
    (error) => error.code === 'ticket_duplicate'
  );
  assert.equal(created.length, 1);
});

test('openTicket enforces the configured intake and isolates guild state', async () => {
  const first = createGuild('guild-1');
  const second = createGuild('guild-2');
  const user = { id: 'user-1', username: 'User', tag: 'User#0001', toString: () => '<@user-1>' };

  await assert.rejects(
    openTicket({ guild: first.guild, channelId: 'wrong', user, config: first.config }),
    (error) => error.code === 'ticket_wrong_channel'
  );
  await openTicket({ guild: first.guild, channelId: 'guild-1-intake', user, config: first.config });
  await openTicket({ guild: second.guild, channelId: 'guild-2-intake', user, config: second.config });
  assert.equal(first.created.length, 1);
  assert.equal(second.created.length, 1);
});

test('ticket channel names are normalized and bounded', () => {
  assert.equal(sanitizeChannelName(' Test User '), 'ticket-test-user');
  assert.ok(sanitizeChannelName('a'.repeat(200)).length <= 77);
});

function supportMember(supportRoleId) {
  return {
    permissions: { has: () => false },
    roles: { cache: { has: (roleId) => roleId === supportRoleId } },
  };
}

test('closeTicket persists closing before deleting the Discord channel', async () => {
  const { guild, config, created, channelCache } = createGuild();
  const user = { id: 'user-1', username: 'User', tag: 'User#0001', toString: () => '<@user-1>' };
  await openTicket({ guild, channelId: 'guild-1-intake', user, config });
  const channel = created[0];
  let deleteCalls = 0;
  channel.delete = async () => {
    deleteCalls += 1;
    channelCache.delete(channel.id);
  };

  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('simulated closing write failure');
  };
  try {
    await assert.rejects(
      closeTicket({
        guild,
        channelId: channel.id,
        closer: { id: 'staff-1', tag: 'Staff#0001' },
        closerMember: supportMember(config.ticket.supportRoleId),
      }),
      /simulated closing write failure/
    );
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(deleteCalls, 0);
  assert.equal(readTicketState().tickets[0].status, 'open');
  assert.equal(channelCache.has(channel.id), true);
});

test('closeTicket preserves closing after delete failure and retries idempotently', async () => {
  const { guild, config, created, channelCache } = createGuild();
  const user = { id: 'user-1', username: 'User', tag: 'User#0001', toString: () => '<@user-1>' };
  await openTicket({ guild, channelId: 'guild-1-intake', user, config });
  const channel = created[0];
  let shouldFailDelete = true;
  let deleteCalls = 0;
  channel.delete = async () => {
    deleteCalls += 1;
    if (shouldFailDelete) throw new Error('simulated Discord delete failure');
    channelCache.delete(channel.id);
  };
  const closeInput = {
    guild,
    channelId: channel.id,
    closer: { id: 'staff-1', tag: 'Staff#0001' },
    closerMember: supportMember(config.ticket.supportRoleId),
    reason: 'resolved',
  };

  await assert.rejects(closeTicket(closeInput), (error) => error.code === 'ticket_channel_delete_failed');
  assert.equal(readTicketState().tickets[0].status, 'closing');
  assert.equal(channelCache.has(channel.id), true);

  shouldFailDelete = false;
  clearTicketLocksForTests();
  const closed = await closeTicket(closeInput);
  assert.equal(closed.status, 'closed');
  assert.equal(readTicketState().tickets[0].status, 'closed');
  assert.equal(deleteCalls, 2);

  const retried = await closeTicket(closeInput);
  assert.equal(retried.status, 'closed');
  assert.equal(deleteCalls, 2);
});

test('closeTicket recovers after restart when finalize write failed and channel is gone', async () => {
  const { guild, config, created, channelCache } = createGuild();
  const user = { id: 'user-1', username: 'User', tag: 'User#0001', toString: () => '<@user-1>' };
  await openTicket({ guild, channelId: 'guild-1-intake', user, config });
  const channel = created[0];
  let deleteCalls = 0;
  channel.delete = async () => {
    deleteCalls += 1;
    channelCache.delete(channel.id);
  };
  const closeInput = {
    guild,
    channelId: channel.id,
    closer: { id: 'staff-1', tag: 'Staff#0001' },
    closerMember: supportMember(config.ticket.supportRoleId),
  };

  const originalRename = fs.renameSync;
  let renameCalls = 0;
  fs.renameSync = (...args) => {
    renameCalls += 1;
    if (renameCalls === 2) throw new Error('simulated finalize write failure');
    return originalRename(...args);
  };
  try {
    await assert.rejects(closeTicket(closeInput), /simulated finalize write failure/);
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(deleteCalls, 1);
  assert.equal(channelCache.has(channel.id), false);
  assert.equal(readTicketState().tickets[0].status, 'closing');

  clearTicketLocksForTests();
  const recovered = await closeTicket(closeInput);
  assert.equal(recovered.status, 'closed');
  assert.equal(readTicketState().tickets[0].status, 'closed');
  assert.equal(deleteCalls, 1);
});
