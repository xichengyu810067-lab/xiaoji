require('dotenv').config({ quiet: true });

const { Client, GatewayIntentBits } = require('discord.js');
const logger = require('../src/utils/logger');

const token = process.env.DISCORD_TOKEN;
const timeoutMs = 30_000;

if (!token) {
  throw new Error('Missing required environment variable: DISCORD_TOKEN');
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

const timeout = setTimeout(() => {
  logger.error('Login smoke check timed out before ready.');
  client.destroy();
  process.exit(1);
}, timeoutMs);

client.once('ready', () => {
  clearTimeout(timeout);
  logger.info(`Login smoke check passed. Bot user: ${client.user.tag}`);
  client.destroy();
  process.exit(0);
});

client.login(token).catch((error) => {
  clearTimeout(timeout);
  logger.error('Login smoke check failed.', error);
  client.destroy();
  process.exit(1);
});
