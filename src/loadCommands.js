const fs = require('node:fs');
const path = require('node:path');
const { Collection, PermissionFlagsBits } = require('discord.js');

const ADMIN_ONLY_COMMANDS = new Set([
  'announce',
  'automod',
  'autorole',
  'ban',
  'clear',
  'config',
  'export-config',
  'kick',
  'mute',
  'role-add',
  'role-remove',
  'set-log',
  'timeout',
  'unban',
]);

const OWNER_ONLY_COMMANDS = new Set([
  'quota',
  'quota-set',
  'quota-list',
  'quota-reset',
  'servers',
  'admin-guilds',
  'admin-whitelist',
]);
const GUILD_ONLY_COMMANDS = OWNER_ONLY_COMMANDS;

function getCommandFiles(commandsPath = path.join(__dirname, 'commands')) {
  if (!fs.existsSync(commandsPath)) {
    throw new Error(`Commands directory does not exist: ${commandsPath}`);
  }

  return fs.readdirSync(commandsPath, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(commandsPath, entry.name);

    if (entry.isDirectory()) {
      return getCommandFiles(fullPath);
    }

    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

function loadCommandModule(filePath) {
  const command = require(filePath);

  if (!command.data || !command.execute) {
    throw new Error(`Command file must export data and execute: ${filePath}`);
  }

  if (!command.data.name || typeof command.execute !== 'function') {
    throw new Error(`Invalid command module: ${filePath}`);
  }

  return command;
}

function loadCommands(commandsPath) {
  const commands = new Collection();

  for (const filePath of getCommandFiles(commandsPath)) {
    const command = loadCommandModule(filePath);
    commands.set(command.data.name, command);
  }

  return commands;
}

function applyCommandDeploySettings(commandData) {
  if (ADMIN_ONLY_COMMANDS.has(commandData.name)) {
    let permissions = PermissionFlagsBits.Administrator;

    if (commandData.name === 'announce') {
      permissions = PermissionFlagsBits.ManageGuild;
    }

    commandData.default_member_permissions = String(permissions);
    commandData.dm_permission = false;
  }

  if (OWNER_ONLY_COMMANDS.has(commandData.name)) {
    commandData.dm_permission = false;
  }

  return commandData;
}

function shouldIncludeCommand(commandName, scope) {
  if (scope === 'global') {
    return !GUILD_ONLY_COMMANDS.has(commandName);
  }

  if (scope === 'guild') {
    return GUILD_ONLY_COMMANDS.has(commandName);
  }

  return true;
}

function loadCommandData(commandsPath, { scope = 'all' } = {}) {
  return getCommandFiles(commandsPath).flatMap((filePath) => {
    const command = loadCommandModule(filePath);
    const commandData = applyCommandDeploySettings(command.data.toJSON());

    if (!shouldIncludeCommand(commandData.name, scope)) {
      return [];
    }

    return [commandData];
  });
}

module.exports = {
  ADMIN_ONLY_COMMANDS,
  GUILD_ONLY_COMMANDS,
  OWNER_ONLY_COMMANDS,
  loadCommands,
  loadCommandData,
};
