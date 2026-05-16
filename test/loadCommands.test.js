const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const {
  ADMIN_ONLY_COMMANDS,
  GUILD_ONLY_COMMANDS,
  OWNER_ONLY_COMMANDS,
  loadCommandData,
  loadCommands,
} = require('../src/loadCommands');

test('loads all slash commands', () => {
  const commands = loadCommands();

  for (const commandName of [
    'weather',
    'poll',
    'quota',
    'quota-set',
    'quota-list',
    'quota-reset',
    'announce',
    'autorole',
    'automod',
    'export-config',
    'status',
    'remind',
    'config',
  ]) {
    assert.ok(commands.has(commandName), `missing ${commandName}`);
  }
});

test('management slash commands require appropriate Discord permissions', () => {
  const commandData = loadCommandData();

  for (const commandJson of commandData) {
    if (ADMIN_ONLY_COMMANDS.has(commandJson.name)) {
      const expectedPermission =
        commandJson.name === 'announce' ? PermissionFlagsBits.ManageGuild : PermissionFlagsBits.Administrator;

      assert.equal(
        commandJson.default_member_permissions,
        String(expectedPermission),
        `${commandJson.name} should require ${commandJson.name === 'announce' ? 'ManageGuild' : 'Administrator'}`
      );
      assert.equal(commandJson.dm_permission, false, `${commandJson.name} should be guild-only`);
    } else if (OWNER_ONLY_COMMANDS.has(commandJson.name)) {
      assert.equal(commandJson.default_member_permissions, undefined, `${commandJson.name} should not use admin gates`);
      assert.equal(commandJson.dm_permission, false, `${commandJson.name} should be guild-only`);
    } else {
      assert.equal(commandJson.default_member_permissions, undefined, `${commandJson.name} should remain visible`);
    }
  }
});

test('global deploy data excludes management commands', () => {
  const globalCommandNames = loadCommandData(undefined, { scope: 'global' }).map((command) => command.name);
  const guildCommandNames = loadCommandData(undefined, { scope: 'guild' }).map((command) => command.name);

  for (const commandName of globalCommandNames) {
    assert.equal(GUILD_ONLY_COMMANDS.has(commandName), false, `${commandName} should not be global`);
  }

  for (const commandName of guildCommandNames) {
    assert.equal(GUILD_ONLY_COMMANDS.has(commandName), true, `${commandName} should be guild-only`);
  }
});
