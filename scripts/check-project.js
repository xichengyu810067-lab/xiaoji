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
  'src/events/channelDelete.js',
  'src/events/voiceStateUpdate.js',
  'src/events/ready.js',
  'src/services/aiService.js',
  'src/services/conversationHistoryService.js',
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
  'src/services/lavalinkService.js',
  'src/services/ticketService.js',
  'src/services/weatherService.js',
  'src/services/welcomeService.js',
  'src/utils/guildConfig.js',
  'src/utils/coinPresentation.js',
  'src/utils/env.js',
  'src/utils/logger.js',
  'src/utils/moderation.js',
  'src/utils/ownerOnly.js',
  'deploy/lavalink/application.yml',
  'deploy/lavalink/compose.yml',
  'deploy/lavalink/Dockerfile',
  'deploy/lavalink/.dockerignore',
  'deploy/lavalink/lavalink.env.example',
  'docs/LAVALINK_SELF_HOST.md',
  'render.yaml',
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
  'ticket',
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

function assertSafeYoutubeCredentialPolicy(applicationText) {
  const forbiddenFragments = ['oauth', 'token', 'cookie', `visitor${'data'}`];
  const keyStack = [];
  const configuredPaths = [];
  let blockScalarParentIndent = null;

  for (const line of String(applicationText).split(/\r?\n/)) {
    const lineIndent = /^(\s*)/.exec(line)[1].length;
    if (blockScalarParentIndent !== null) {
      if (!line.trim() || lineIndent > blockScalarParentIndent) continue;
      blockScalarParentIndent = null;
    }

    const match = /^(\s*)(?:"((?:\\.|[^"\\\r\n])+)"|'([^'\r\n]+)'|([A-Za-z][A-Za-z0-9_-]*))\s*:/.exec(line);
    if (!match) continue;

    const indent = match[1].length;
    while (keyStack.length && keyStack[keyStack.length - 1].indent >= indent) keyStack.pop();
    const quotedKey = match[2] || match[3];
    assert(
      !quotedKey?.includes('\\'),
      'YouTube client policy must not use escaped quoted mapping keys'
    );
    const key = (match[2] || match[3] || match[4]).toLowerCase();
    const path = [...keyStack.map((entry) => entry.key), key];
    configuredPaths.push(path);
    keyStack.push({ indent, key });

    const scalarValue = line.slice(match[0].length);
    if (/^\s*[|>][0-9+-]*\s*(?:#.*)?$/.test(scalarValue)) blockScalarParentIndent = indent;
  }

  const configuredKeys = configuredPaths.map((path) => path[path.length - 1]);
  const hasForbiddenKey = configuredKeys.some(
    (key) => key === 'pot' || forbiddenFragments.some((fragment) => key.includes(fragment))
  );
  const normalizedPaths = configuredPaths.map((path) =>
    path.map((key) => key.replace(/[-_]/g, ''))
  );
  const hasRemoteCipher = normalizedPaths.some((path) =>
    path.some((key) => key.includes('remotecipher'))
  );
  const hasIpRouting = normalizedPaths.some((path) =>
    path.some((key) =>
      key === 'ratelimit' ||
      key === 'ipblocks' ||
      key === 'excludedips' ||
      key.includes('routeplanner') ||
      key.includes('routing') ||
      key.includes('iprotation') ||
      key.includes('rotator')
    )
  );

  assert(
    !hasForbiddenKey,
    'YouTube client policy must not introduce account credentials, OAuth, proof tokens, cookies, or refresh tokens'
  );
  assert(!hasRemoteCipher, 'YouTube client policy must not introduce remote cipher configuration');
  assert(!hasIpRouting, 'YouTube client policy must not introduce IP rotation, route planner, or routing configuration');
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
  assert(
    packageJson.dependencies.typescript === '5.9.3',
    'package.json must pin typescript 5.9.3 for NyankoHost ts-node compatibility',
  );
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
    'AI_CONVERSATION_PATH',
    'AI_MEMORY_MAX_TURNS',
    'AI_MEMORY_MAX_CONVERSATIONS',
    'AI_MEMORY_MAX_BYTES',
    'AI_MEMORY_MAX_TEXT_LENGTH',
    'AI_MEMORY_RETENTION_DAYS',
    'XIAOJI_MEMORY_PATH',
    'OPENWEATHER_API_KEY',
    'LAVALINK_HOST',
    'LAVALINK_PORT',
    'LAVALINK_PASSWORD',
    'LAVALINK_SECURE',
    'LAVALINK_ALLOW_PUBLIC_FALLBACK',
    'MUSIC_STAY_IN_VOICE',
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

function checkSixFeatureContracts() {
  const gitignore = readText('.gitignore');
  const envExample = readText('.env.example');
  const ticketCommand = readText('src/commands/ticket.js');
  const ticketService = readText('src/services/ticketService.js');
  const lavalinkService = readText('src/services/lavalinkService.js');
  const musicService = readText('src/services/musicService.js');
  const conversationHistory = readText('src/services/conversationHistoryService.js');
  const readyEvent = readText('src/events/ready.js');
  const welcomeService = readText('src/services/welcomeService.js');
  const memberAddEvent = readText('src/events/guildMemberAdd.js');
  const lavalinkCompose = readText('deploy/lavalink/compose.yml');
  const lavalinkApplication = readText('deploy/lavalink/application.yml');
  const lavalinkDockerfile = readText('deploy/lavalink/Dockerfile');
  const lavalinkDockerignore = readText('deploy/lavalink/.dockerignore');
  const renderBlueprint = readText('render.yaml');

  assert(ticketCommand.includes(".setName('ticket')"), 'Ticket slash command is missing');
  assert(ticketService.includes('permissionOverwrites'), 'Ticket private channel permissions are missing');
  assert(ticketService.includes('fs.renameSync'), 'Ticket state must use atomic rename');
  assert(gitignore.includes('src/data/*.json'), 'Ticket runtime JSON must remain ignored');

  assert(envExample.includes('LAVALINK_ALLOW_PUBLIC_FALLBACK=false'), 'Public Lavalink fallback must default off');
  assert(lavalinkService.includes("source: 'self-hosted-env'"), 'Self-hosted Lavalink node mode is missing');
  assert(lavalinkService.includes('LAVALINK_PUBLIC_FALLBACK_PASSWORD'), 'Explicit public fallback credentials are missing');
  assert(lavalinkCompose.includes('ghcr.io/lavalink-devs/lavalink:4.2.2-alpine'), 'Lavalink image is not pinned');
  assert(
    lavalinkDockerfile.includes('4.2.2-alpine@sha256:96be2be7ee50d35a9bd42c8c7b99e2a4b741f09123066c1ebb9e014dd7db204d'),
    'Render Lavalink image digest is not pinned'
  );
  assert(lavalinkDockerignore.includes('lavalink.env'), 'Render Docker context must exclude Lavalink secrets');
  assert(
      renderBlueprint.includes('runtime: docker') &&
      renderBlueprint.includes('plan: free') &&
      renderBlueprint.includes('rootDir: deploy/lavalink') &&
      renderBlueprint.includes('dockerfilePath: ./Dockerfile') &&
      renderBlueprint.includes('dockerContext: .') &&
      renderBlueprint.includes('sync: false'),
    'Render Lavalink Blueprint contract is missing'
  );
  assert(lavalinkApplication.includes('port: ${PORT:2333}'), 'Lavalink must honor the hosting platform port');
  assert(
    lavalinkApplication.includes('dev.lavalink.youtube:youtube-plugin:1.18.2') &&
      /youtube:\s+false/.test(lavalinkApplication),
    'Official YouTube plugin contract is missing'
  );
  const youtubeClientsBlock = lavalinkApplication.match(/clients:\s*((?:\r?\n\s+-\s+\S+)+)/);
  assert(youtubeClientsBlock, 'YouTube client policy is missing');
  const youtubeClients = [...youtubeClientsBlock[1].matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((match) => match[1]);
  assert(
    JSON.stringify(youtubeClients) ===
      JSON.stringify(['IOS', 'MWEB', 'ANDROID_MUSIC', 'TVHTML5_SIMPLY']),
    'YouTube client policy must use only the approved credential-free fallback order'
  );
  assert(!youtubeClients.includes('TV'), 'YouTube TV client requires OAuth and must remain disabled');
  assert(!youtubeClients.includes('MUSIC'), 'Search-only MUSIC client must not enter the playback client order');
  assertSafeYoutubeCredentialPolicy(lavalinkApplication);

  for (const field of ['guildId', 'channelId', 'userId']) {
    assert(conversationHistory.includes(field), `AI conversation history is missing ${field} isolation`);
  }
  assert(conversationHistory.includes('fs.renameSync'), 'AI conversation history must use atomic rename');
  assert(conversationHistory.includes('writeQueue'), 'AI conversation writes must be serialized');
  assert(
    readyEvent.includes('clearExpiredConversationHistory') &&
      readyEvent.includes("runStartupTask('AI 對話記憶過期清理'"),
    'AI conversation retention cleanup must run on production startup'
  );
  assert(
    readyEvent.includes('startConversationHistoryCleanupScheduler') &&
      conversationHistory.includes('DEFAULT_RETENTION_CLEANUP_INTERVAL_MS') &&
      conversationHistory.includes('timer.unref?.()') &&
      conversationHistory.includes('stopConversationHistoryCleanupScheduler'),
    'AI conversation retention cleanup scheduler lifecycle is incomplete'
  );

  assert(envExample.includes('MUSIC_STAY_IN_VOICE=false'), 'Voice stay env policy is missing');
  assert(musicService.includes('getVoiceStayPolicy'), 'Voice stay policy implementation is missing');
  assert(musicService.includes('cancelLavalinkIdleDisconnect'), 'Lavalink idle cancellation is missing');

  assert(welcomeService.includes("addCandidate(member.guild.systemChannel, 'system')"), 'Welcome system-channel fallback is missing');
  assert(welcomeService.includes("channel?.type === ChannelType.GuildText"), 'Welcome text-channel fallback is missing');
  assert(
    (memberAddEvent.match(/try \{/g) || []).length >= 2,
    'Autorole and welcome handlers must remain error-isolated'
  );
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
    '/ticket',
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
    'MUSIC_STAY_IN_VOICE',
    'LAVALINK_SELF_HOST.md',
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
  checkSixFeatureContracts();
  checkDocs();
  checkTestsPass();
  console.log('Project check passed.');
}

if (require.main === module) {
  main();
}

module.exports = { assertSafeYoutubeCredentialPolicy };
