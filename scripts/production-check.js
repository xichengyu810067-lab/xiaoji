const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({ quiet: true });

const { getBotOwnerId, getDiscordClientId, getDiscordGuildId, getDiscordToken } = require('../src/utils/env');

const root = path.resolve(__dirname, '..');
const requiredEnv = [
  { label: 'DISCORD_TOKEN', value: getDiscordToken() },
  { label: 'DISCORD_CLIENT_ID', value: getDiscordClientId(), aliases: ['CLIENT_ID'] },
  { label: 'DISCORD_GUILD_ID', value: getDiscordGuildId(), aliases: ['GUILD_ID'] },
  { label: 'BOT_OWNER_ID', value: getBotOwnerId(), aliases: ['OWNER_ID'] },
];
const optionalEnv = [
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
  'OPENWEATHER_API_KEY',
  'COIN_DB_PATH',
  'COIN_TIMEZONE',
  'LAVALINK_HOST',
  'LAVALINK_PORT',
  'LAVALINK_PASSWORD',
  'LAVALINK_SECURE',
  'LAVALINK_ALLOW_PUBLIC_FALLBACK',
  'LAVALINK_PUBLIC_FALLBACK_HOST',
  'LAVALINK_PUBLIC_FALLBACK_PORT',
  'LAVALINK_PUBLIC_FALLBACK_PASSWORD',
  'LAVALINK_PUBLIC_FALLBACK_SECURE',
  'MUSIC_STAY_IN_VOICE',
  'AI_CONVERSATION_PATH',
  'XIAOJI_MEMORY_PATH',
];
const dataFiles = [
  'calendarEvents.json',
  'guildAudit.json',
  'guildConfig.json',
  'guildQuotas.json',
  'inviterWhitelist.json',
  'polls.json',
  'reminders.json',
  'tickets.json',
];
const rootDataFiles = ['aiConversationHistory.json', 'xiaojiMemory.json'];

function hasValue(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim().length > 0;
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertRequiredEnv() {
  const missing = requiredEnv
    .filter((entry) => !entry.value)
    .map((entry) => [entry.label, ...(entry.aliases || [])].join(' or '));

  ensure(
    missing.length === 0,
    `Missing required environment variable(s): ${missing.join(', ')}. Fill them in .env on the VPS.`
  );
}

function assertGitignore() {
  const gitignore = readText('.gitignore');

  ensure(/(^|\r?\n)\.env(\r?\n|$)/.test(gitignore), '.gitignore must ignore .env');
  ensure(gitignore.includes('src/data/*.json'), '.gitignore must ignore runtime data JSON files');
  ensure(gitignore.includes('data/*'), '.gitignore must ignore root runtime data files');
  ensure(gitignore.includes('*.sqlite'), '.gitignore must ignore SQLite database files');
  ensure(gitignore.includes('logs/*'), '.gitignore must ignore PM2 log output');
}

function assertJsonDataFiles() {
  const dataDir = path.join(root, 'src', 'data');

  ensure(fs.existsSync(dataDir), 'src/data directory is missing');

  for (const fileName of dataFiles) {
    const fullPath = path.join(dataDir, fileName);

    if (!fs.existsSync(fullPath)) {
      continue;
    }

    try {
      JSON.parse(fs.readFileSync(fullPath, 'utf8') || '{}');
    } catch (error) {
      throw new Error(`${path.join('src/data', fileName)} is not valid JSON`);
    }
  }

  for (const fileName of rootDataFiles) {
    const fullPath = path.join(root, 'data', fileName);
    if (!fs.existsSync(fullPath)) continue;
    try {
      JSON.parse(fs.readFileSync(fullPath, 'utf8') || '{}');
    } catch {
      throw new Error(`${path.join('data', fileName)} is not valid JSON`);
    }
  }
}

function assertBooleanEnv(name) {
  if (!hasValue(name)) return;
  ensure(['true', 'false'].includes(process.env[name].trim().toLowerCase()), `${name} must be true or false`);
}

function assertOptionalServiceConfiguration() {
  for (const name of [
    'LAVALINK_SECURE',
    'LAVALINK_ALLOW_PUBLIC_FALLBACK',
    'LAVALINK_PUBLIC_FALLBACK_SECURE',
    'MUSIC_STAY_IN_VOICE',
    'AUTO_DEPLOY_COMMANDS',
  ]) {
    assertBooleanEnv(name);
  }

  if (hasValue('LAVALINK_HOST')) {
    ensure(hasValue('LAVALINK_PASSWORD'), 'LAVALINK_PASSWORD is required when LAVALINK_HOST is configured');
  }

  if (String(process.env.LAVALINK_ALLOW_PUBLIC_FALLBACK || '').trim().toLowerCase() === 'true') {
    ensure(
      hasValue('LAVALINK_PUBLIC_FALLBACK_HOST') && hasValue('LAVALINK_PUBLIC_FALLBACK_PASSWORD'),
      'Explicit public fallback requires LAVALINK_PUBLIC_FALLBACK_HOST and LAVALINK_PUBLIC_FALLBACK_PASSWORD'
    );
  }

  for (const name of ['LAVALINK_PORT', 'LAVALINK_PUBLIC_FALLBACK_PORT']) {
    if (!hasValue(name)) continue;
    const port = Number.parseInt(process.env[name], 10);
    ensure(Number.isInteger(port) && port >= 1 && port <= 65535, `${name} must be between 1 and 65535`);
  }
}

function assertFeatureDeploymentFiles() {
  for (const relativePath of [
    'deploy/lavalink/application.yml',
    'deploy/lavalink/compose.yml',
    'deploy/lavalink/lavalink.env.example',
    'docs/LAVALINK_SELF_HOST.md',
  ]) {
    ensure(fs.existsSync(path.join(root, relativePath)), `Missing deployment file: ${relativePath}`);
  }
  const gitignore = readText('.gitignore');
  ensure(gitignore.includes('/deploy/lavalink/lavalink.env'), 'Lavalink runtime env must be ignored');
}

function assertPm2Config() {
  ensure(fs.existsSync(path.join(root, 'ecosystem.config.cjs')), 'ecosystem.config.cjs is missing');
  ensure(fs.existsSync(path.join(root, 'logs')), 'logs directory is missing');
}

function main() {
  assertRequiredEnv();
  assertGitignore();
  assertJsonDataFiles();
  assertOptionalServiceConfiguration();
  assertFeatureDeploymentFiles();
  assertPm2Config();

  const configuredOptional = optionalEnv.filter(hasValue).length;

  console.log('Production check passed.');
  console.log(`Required environment variables: ${requiredEnv.length}/${requiredEnv.length} configured.`);
  console.log(`Optional service keys: ${configuredOptional}/${optionalEnv.length} configured.`);
  console.log('No environment variable values were printed.');
}

main();
