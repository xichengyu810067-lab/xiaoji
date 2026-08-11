require('dotenv').config({ quiet: true });

const { REST, Routes } = require('discord.js');
const { loadCommandData } = require('./src/loadCommands');
const {
  getDiscordClientId,
  getDiscordGuildId,
  getDiscordToken,
  requireEnvValue,
} = require('./src/utils/env');

function shouldAutoDeployCommands(env = process.env) {
  return String(env.AUTO_DEPLOY_COMMANDS || '').trim().toLowerCase() === 'true';
}

async function deployCommands({
  token = getDiscordToken(),
  clientId = getDiscordClientId(),
  guildId = getDiscordGuildId(),
  rest = new REST({ version: '10' }).setToken(token),
} = {}) {
  requireEnvValue('DISCORD_TOKEN', token);
  requireEnvValue('DISCORD_CLIENT_ID', clientId, ['CLIENT_ID']);
  requireEnvValue('DISCORD_GUILD_ID', guildId, ['GUILD_ID']);

  const globalCommands = loadCommandData(undefined, { scope: 'global' });
  const guildCommands = loadCommandData(undefined, { scope: 'guild' });

  console.log(`Deploying ${globalCommands.length} global slash commands...`);
  console.log(`Global commands: ${globalCommands.map((c) => c.name).join(', ')}`);
  await rest.put(Routes.applicationCommands(clientId), { body: globalCommands });

  console.log(`Deploying ${guildCommands.length} management slash commands to guild ${guildId}...`);
  console.log(`Guild commands: ${guildCommands.map((c) => c.name).join(', ')}`);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: guildCommands });

  console.log(`Slash commands deployed. Management commands are registered to guild ${guildId}.`);

  return {
    globalCount: globalCommands.length,
    guildCount: guildCommands.length,
  };
}

if (require.main === module) {
  deployCommands().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  deployCommands,
  shouldAutoDeployCommands,
};
