require('dotenv').config({ quiet: true });

const { Client, GatewayIntentBits } = require('discord.js');
const { loadCommands } = require('./loadCommands');
const { registerEvents } = require('./handlers/registerEvents');
const logger = require('./utils/logger');

const token = process.env.DISCORD_TOKEN;
const ownerId = process.env.BOT_OWNER_ID;

if (!token) {
  throw new Error('Missing required environment variable: DISCORD_TOKEN');
}

if (!ownerId) {
  throw new Error('Missing required environment variable: BOT_OWNER_ID');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = loadCommands();
registerEvents(client);

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exitCode = 1;
});

process.on('SIGINT', () => {
  logger.info('收到 SIGINT，正在關閉小吉。');
  client.destroy();
  process.exit(0);
});

client.login(token);
