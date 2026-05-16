require('dotenv').config({ quiet: true });

const { REST, Routes } = require('discord.js');
const { loadCommandData } = require('./src/loadCommands');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

async function main() {
  requireEnv('DISCORD_TOKEN', token);
  requireEnv('DISCORD_CLIENT_ID', clientId);
  requireEnv('DISCORD_GUILD_ID', guildId);

  const globalCommands = loadCommandData(undefined, { scope: 'global' });
  const guildCommands = loadCommandData(undefined, { scope: 'guild' });
  const rest = new REST({ version: '10' }).setToken(token);

  console.log(`Deploying ${globalCommands.length} global slash commands...`);
  await rest.put(Routes.applicationCommands(clientId), { body: globalCommands });

  console.log(`Deploying ${guildCommands.length} management slash commands to guild ${guildId}...`);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: guildCommands });

  console.log(`Slash commands deployed. Management commands are registered to guild ${guildId}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
