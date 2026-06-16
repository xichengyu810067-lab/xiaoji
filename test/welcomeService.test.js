const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const {
  canSendWelcome,
  formatWelcomeMessage,
  handleGuildMemberWelcome,
} = require('../src/services/welcomeService');

function createPermissions(allowedPermissions) {
  const allowed = new Set(allowedPermissions);
  return {
    has: (permission) => allowed.has(permission),
  };
}

function createMember({ channel = null, bot = false, allowedPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] } = {}) {
  const botMember = { id: 'bot-1' };
  const sent = [];
  const welcomeChannel =
    channel ||
    {
      id: 'welcome-1',
      isTextBased: () => true,
      permissionsFor: () => createPermissions(allowedPermissions),
      send: async (payload) => {
        sent.push(payload);
      },
    };

  return {
    member: {
      id: 'user-1',
      user: { bot },
      toString: () => '<@user-1>',
      guild: {
        id: 'guild-1',
        members: {
          me: botMember,
          fetchMe: async () => botMember,
        },
        channels: {
          fetch: async (channelId) => (channelId === 'welcome-1' ? welcomeChannel : null),
        },
      },
    },
    sent,
    welcomeChannel,
    botMember,
  };
}

test('formatWelcomeMessage mentions the new member', () => {
  assert.equal(
    formatWelcomeMessage({ toString: () => '<@user-1>' }),
    '歡迎 <@user-1> 加入伺服器！小吉在這裡向你打招呼～'
  );
});

test('canSendWelcome requires text channel and send permissions', () => {
  const { welcomeChannel, botMember } = createMember();
  assert.equal(canSendWelcome(welcomeChannel, botMember), true);

  const missingSend = {
    ...welcomeChannel,
    permissionsFor: () => createPermissions([PermissionFlagsBits.ViewChannel]),
  };
  assert.equal(canSendWelcome(missingSend, botMember), false);
});

test('handleGuildMemberWelcome does nothing without configured channel', async () => {
  const { member, sent } = createMember();

  const result = await handleGuildMemberWelcome(member, { config: { welcomeChannelId: null } });

  assert.equal(result, false);
  assert.equal(sent.length, 0);
});

test('handleGuildMemberWelcome sends configured welcome message', async () => {
  const { member, sent } = createMember();

  const result = await handleGuildMemberWelcome(member, { config: { welcomeChannelId: 'welcome-1' } });

  assert.equal(result, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /歡迎 <@user-1> 加入伺服器/);
  assert.deepEqual(sent[0].allowedMentions, { users: ['user-1'], roles: [] });
});

test('handleGuildMemberWelcome ignores bot members', async () => {
  const { member, sent } = createMember({ bot: true });

  const result = await handleGuildMemberWelcome(member, { config: { welcomeChannelId: 'welcome-1' } });

  assert.equal(result, false);
  assert.equal(sent.length, 0);
});
