const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
  'package.json',
  'deploy-commands.js',
  '.env.example',
  'README.md',
  'src/index.js',
  'src/loadCommands.js',
  'src/handlers/registerEvents.js',
  'src/events/interactionCreate.js',
  'src/events/messageCreate.js',
  'src/events/guildMemberAdd.js',
  'src/events/ready.js',
  'src/services/aiService.js',
  'src/services/automodService.js',
  'src/services/autoroleService.js',
  'src/services/calendarService.js',
  'src/services/casinoFacilityService.js',
  'src/services/casinoService.js',
  'src/services/chipService.js',
  'src/services/coinDatabase.js',
  'src/services/coinService.js',
  'src/services/luxuryService.js',
  'src/services/venueService.js',
  'src/services/pollService.js',
  'src/services/quotaService.js',
  'src/services/reminderService.js',
  'src/services/statusService.js',
  'src/services/musicService.js',
  'src/services/weatherService.js',
  'src/services/welcomeService.js',
  'src/utils/guildConfig.js',
  'src/utils/coinPresentation.js',
  'src/utils/env.js',
  'src/utils/logger.js',
  'src/utils/moderation.js',
  'src/utils/ownerOnly.js',
];

const expectedCommands = [
  'about',
  'admin-guilds',
  'admin-whitelist',
  'announce',
  'automod',
  'autorole',
  'ban',
  'bank',
  'buy',
  'calendar',
  'casino',
  'casino-admin',
  'casino-lobby',
  'casino-venue',
  'clear',
  'coin-admin',
  'coin-db',
  'coins',
  'config',
  'daily',
  'duel-tower',
  'economy',
  'exchange',
  'export-config',
  'fortune',
  'help',
  'inventory',
  'kick',
  'leaderboard',
  'luxury',
  'luxury-admin',
  'music',
  'mute',
  'pawn',
  'ping',
  'poll',
  'quota',
  'quota-list',
  'quota-reset',
  'quota-set',
  'remind',
  'role-add',
  'role-remove',
  'roll',
  'servers',
  'set-log',
  'set-welcome',
  'shop',
  'shop-admin',
  'status',
  'timeout',
  'unban',
  'weather',
  'work',
];

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function checkRequiredFiles() {
  for (const file of requiredFiles) {
    assert(fs.existsSync(path.join(root, file)), `Missing required file: ${file}`);
  }
}

function checkPackageJson() {
  const packageJson = JSON.parse(readText('package.json'));

  assert(packageJson.type === 'commonjs', 'package.json type must remain commonjs');
  assert(packageJson.scripts.start === 'node src/index.js', 'package.json scripts.start is incorrect');
  assert(packageJson.scripts.deploy === 'node deploy-commands.js', 'package.json scripts.deploy is incorrect');
  assert(packageJson.scripts.check === 'node scripts/check-project.js', 'package.json scripts.check is incorrect');
  assert(packageJson.scripts.test === 'node scripts/run-tests.js', 'package.json scripts.test is incorrect');
  assert(packageJson.dependencies['discord.js'], 'package.json is missing discord.js');
  assert(packageJson.dependencies['@discordjs/voice'], 'package.json is missing @discordjs/voice');
  assert(packageJson.dependencies['ffmpeg-static'], 'package.json is missing ffmpeg-static');
  assert(packageJson.dependencies.kazagumo, 'package.json is missing kazagumo');
  assert(packageJson.dependencies.shoukaku, 'package.json is missing shoukaku');
  assert(packageJson.dependencies.dotenv, 'package.json is missing dotenv');
  assert(packageJson.dependencies.openai, 'package.json is missing openai');
  assert(packageJson.dependencies['sql.js'], 'package.json is missing sql.js');
}

function checkEnvExample() {
  const envExample = readText('.env.example');

  for (const name of [
    'DISCORD_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'BOT_OWNER_ID',
    'OWNER_ID',
    'GROQ_API_KEY',
    'GROQ_MODEL',
    'GROQ_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OPENWEATHER_API_KEY',
    'LAVALINK_HOST',
    'LAVALINK_PORT',
    'LAVALINK_PASSWORD',
    'LAVALINK_SECURE',
    'COIN_DB_PATH',
    'COIN_TIMEZONE',
  ]) {
    assert(envExample.includes(`${name}=`), `.env.example is missing ${name}`);
  }
}

function checkRuntimeConfigurationHints() {
  const envExample = readText('.env.example');
  const necessary = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'BOT_OWNER_ID'];
  const recommended = ['OPENWEATHER_API_KEY', 'COIN_DB_PATH', 'COIN_TIMEZONE'];
  const externalServices = ['LAVALINK_HOST', 'LAVALINK_PORT', 'LAVALINK_PASSWORD', 'LAVALINK_SECURE'];

  console.log(`Necessary env examples: ${necessary.filter((name) => envExample.includes(`${name}=`)).length}/${necessary.length}`);
  console.log(`Recommended env examples: ${recommended.filter((name) => envExample.includes(`${name}=`)).length}/${recommended.length}`);
  console.log(
    `External service env examples: ${
      externalServices.filter((name) => envExample.includes(`${name}=`)).length
    }/${externalServices.length}`
  );
}

function collectJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return collectJavaScriptFiles(fullPath);
    }

    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

function checkJavaScriptSyntax() {
  const files = [
    path.join(root, 'deploy-commands.js'),
    ...collectJavaScriptFiles(path.join(root, 'src')),
    ...collectJavaScriptFiles(path.join(root, 'scripts')),
    ...collectJavaScriptFiles(path.join(root, 'test')),
  ];

  for (const file of files) {
    const relativePath = path.relative(root, file);
    const source = readText(relativePath);
    new vm.Script(source, { filename: relativePath });
  }
}

function checkCommands() {
  const { loadCommands, loadCommandData } = require('../src/loadCommands');
  const { ADMIN_ONLY_COMMANDS, GUILD_ONLY_COMMANDS, OWNER_ONLY_COMMANDS } = require('../src/loadCommands');
  const { PermissionFlagsBits } = require('discord.js');
  const commands = loadCommands();
  const commandData = loadCommandData();
  const globalCommandData = loadCommandData(undefined, { scope: 'global' });
  const guildCommandData = loadCommandData(undefined, { scope: 'guild' });
  const commandNames = [...commands.keys()].sort();

  assert(commands.size === expectedCommands.length, `Expected ${expectedCommands.length} commands, got ${commands.size}`);
  assert(JSON.stringify(commandNames) === JSON.stringify(expectedCommands), 'Loaded command list does not match');
  assert(commandData.length === commands.size, 'Loaded command count does not match command data count');
  assert(
    globalCommandData.every((commandJson) => !GUILD_ONLY_COMMANDS.has(commandJson.name)),
    'Global command data should not include guild-only management commands'
  );
  assert(
    guildCommandData.every((commandJson) => GUILD_ONLY_COMMANDS.has(commandJson.name)),
    'Guild command data should only include guild-only management commands'
  );

  for (const commandJson of commandData) {
    if (ADMIN_ONLY_COMMANDS.has(commandJson.name)) {
      const expectedPermission =
        commandJson.name === 'announce' ? PermissionFlagsBits.ManageGuild : PermissionFlagsBits.Administrator;

      assert(
        commandJson.default_member_permissions === String(expectedPermission),
        `${commandJson.name} should require ${commandJson.name === 'announce' ? 'ManageGuild' : 'Administrator'}`
      );
      assert(commandJson.dm_permission === false, `${commandJson.name} should be guild-only`);
    } else if (OWNER_ONLY_COMMANDS.has(commandJson.name)) {
      assert(commandJson.dm_permission === false, `${commandJson.name} should be guild-only`);
      assert(!commandJson.default_member_permissions, `${commandJson.name} should rely on BOT_OWNER_ID`);
    } else {
      assert(!commandJson.default_member_permissions, `${commandJson.name} should remain available`);
    }
  }
}

function checkDocs() {
  const readme = readText('README.md');

  for (const text of [
    '/weather',
    '/poll',
    '/quota',
    '/announce',
    '/autorole',
    '/automod',
    '/set-welcome',
    '/export-config',
    '/status',
    '/remind',
    '/config',
    '/calendar',
    '/music',
    '/coins',
    '/daily',
    '/leaderboard',
    '/bank',
    '/exchange',
    '/work',
    '/casino-lobby',
    '/duel-tower',
    '/casino',
    '/casino-venue',
    '/luxury',
    '/pawn',
    '/shop',
    '/buy',
    '/inventory',
    '/economy',
    '/coin-admin',
    '/shop-admin',
    '/coin-db',
    'OPENWEATHER_API_KEY',
    'COIN_DB_PATH',
    'npm run deploy',
    'npm start',
    'npm test',
  ]) {
    assert(readme.includes(text), `README.md is missing ${text}`);
  }
}

function checkTestsPass() {
  const result = spawnSync(process.execPath, ['scripts/run-tests.js'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });

  assert(result.status === 0, 'node --test failed');
}

function main() {
  checkRequiredFiles();
  checkPackageJson();
  checkEnvExample();
  checkRuntimeConfigurationHints();
  checkJavaScriptSyntax();
  checkCommands();
  checkDocs();
  checkTestsPass();
  console.log('Project check passed.');
}

main();
