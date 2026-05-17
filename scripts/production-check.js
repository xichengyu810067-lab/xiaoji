const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({ quiet: true });

const root = path.resolve(__dirname, '..');
const requiredEnv = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'BOT_OWNER_ID'];
const optionalEnv = ['GROQ_API_KEY', 'OPENAI_API_KEY', 'OPENWEATHER_API_KEY', 'COIN_DB_PATH', 'COIN_TIMEZONE'];
const dataFiles = [
  'calendarEvents.json',
  'guildAudit.json',
  'guildConfig.json',
  'guildQuotas.json',
  'inviterWhitelist.json',
  'polls.json',
  'reminders.json',
];

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
  const missing = requiredEnv.filter((name) => !hasValue(name));

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
}

function assertPm2Config() {
  ensure(fs.existsSync(path.join(root, 'ecosystem.config.cjs')), 'ecosystem.config.cjs is missing');
  ensure(fs.existsSync(path.join(root, 'logs')), 'logs directory is missing');
}

function main() {
  assertRequiredEnv();
  assertGitignore();
  assertJsonDataFiles();
  assertPm2Config();

  const configuredOptional = optionalEnv.filter(hasValue).length;

  console.log('Production check passed.');
  console.log(`Required environment variables: ${requiredEnv.length}/${requiredEnv.length} configured.`);
  console.log(`Optional service keys: ${configuredOptional}/${optionalEnv.length} configured.`);
  console.log('No environment variable values were printed.');
}

main();
