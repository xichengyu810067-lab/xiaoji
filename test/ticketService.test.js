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
