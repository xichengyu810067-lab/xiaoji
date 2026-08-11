const test = require('node:test');
const assert = require('node:assert/strict');
const { Routes } = require('discord.js');
const { deployCommands, shouldAutoDeployCommands } = require('../deploy-commands');

test('AUTO_DEPLOY_COMMANDS accepts only explicit enabled values', () => {
  for (const value of ['true', 'TRUE', ' true ']) {
    assert.equal(shouldAutoDeployCommands({ AUTO_DEPLOY_COMMANDS: value }), true);
  }

  for (const value of [undefined, '', '0', '1', 'false', 'yes', 'on', 'anything']) {
    assert.equal(shouldAutoDeployCommands({ AUTO_DEPLOY_COMMANDS: value }), false);
  }
});

test('deployCommands updates global and guild command scopes without logging secrets', async () => {
  const calls = [];
  const rest = {
    put: async (route, options) => {
      calls.push({ route, body: options.body });
    },
  };

  const result = await deployCommands({
    token: 'test-token',
    clientId: 'client-1',
    guildId: 'guild-1',
    rest,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].route, Routes.applicationCommands('client-1'));
  assert.equal(calls[1].route, Routes.applicationGuildCommands('client-1', 'guild-1'));
  assert.equal(calls[0].body.some((command) => command.name === 'ticket'), true);
  assert.equal(calls[0].body.some((command) => command.name === 'music'), true);
  assert.equal(result.globalCount, calls[0].body.length);
  assert.equal(result.guildCount, calls[1].body.length);
});
