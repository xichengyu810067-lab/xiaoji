const fs = require('node:fs');
const { createHash } = require('node:crypto');
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
  'scripts/bootstrap-ytdlp-pot-provider.js',
  'deploy/ytdlp-pot-provider/package.json',
  'deploy/ytdlp-pot-provider/package-lock.json',
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
  const packageLock = JSON.parse(readText('package-lock.json'));

  assert(packageJson.version === '1.0.0', 'package.json release version must be 1.0.0');
  assert(packageLock.version === '1.0.0', 'package-lock.json release version must be 1.0.0');
  assert(packageLock.packages?.['']?.version === '1.0.0', 'package-lock root release version must be 1.0.0');
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

  assert(envExample.includes('GROQ_MODEL=openai/gpt-oss-120b'), 'Groq model example must use GPT OSS 120B');
  assert(!envExample.includes('GROQ_BASE_URL='), 'Groq base URL must not be deployment-overridable');
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
  assert(!globalCommandData.some((commandJson) => commandJson.name === 'music'), 'Private music must not be global');
  assert(guildCommandData.some((commandJson) => commandJson.name === 'music'), 'Private music must remain guild-scoped');
  assert(OWNER_ONLY_COMMANDS.has('music'), 'Private music must be owner-only');

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
  const youtubeYtdlpSource = readText('src/services/youtubeYtdlpSource.js');
  const potBootstrap = readText('scripts/bootstrap-ytdlp-pot-provider.js');
  const conversationHistory = readText('src/services/conversationHistoryService.js');
  const aiService = readText('src/services/aiService.js');
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
  assert(gitignore.includes('/.runtime/'), 'Verified provider binaries and token cache must remain ignored');
  assert(
    gitignore.includes('cookies.txt') &&
      gitignore.includes('*.cookies.txt') &&
      gitignore.includes('youtube-cookies*.txt') &&
      gitignore.includes('.cookies/'),
    'Private YouTube cookie files must remain ignored'
  );

  const potLock = fs.readFileSync(path.join(root, 'deploy/ytdlp-pot-provider/package-lock.json'));
  assert(
    createHash('sha256').update(potLock).digest('hex') === 'da454a9d6454168048093706d7cab9cd087dfffcfa3494ebc0b4821f4b261c39',
    'bgutil provider audit-fixed production lock changed without review'
  );
  assert(
    potBootstrap.includes("providerCommit = '7608dd51ee813b48cf9a6d68c6e42cb197ce10e0'") &&
      potBootstrap.includes("providerSourceSha256 = '5d4c54f9c5e75f3dcb48c906a5f8b860f57ee125b83f025e43362ab332695c3e'") &&
      potBootstrap.includes("providerPluginSha256 = 'b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38'") &&
      potBootstrap.includes('providerCriticalFileSha256 = Object.freeze') &&
      potBootstrap.includes("'server/src/session_manager.ts': '1bbfed69439dea6031203029cc2cc1312191c7e8a9a840d12d2a27fc2d3f2b0c'") &&
      potBootstrap.includes('JSON.stringify(receiptPaths) !== JSON.stringify(expectedPaths)') &&
      potBootstrap.includes('receipt.files[relativePath] !== expectedHash') &&
      potBootstrap.includes("['ci', ...npmContext.args, '--ignore-scripts']") &&
      potBootstrap.includes("'exec', ...npmContext.args, '--ignore-scripts'") &&
      potBootstrap.includes('NPM_CONFIG_USERCONFIG = userConfig') &&
      potBootstrap.includes('NPM_CONFIG_GLOBALCONFIG = globalConfig') &&
      potBootstrap.includes("writeFile(npmContext.userConfig, '', { flag: 'wx' })") &&
      potBootstrap.includes("writeFile(npmContext.globalConfig, '', { flag: 'wx' })") &&
      !potBootstrap.includes('server/src/main.ts') &&
      !potBootstrap.includes('getpot_bgutil_http.py'),
    'Automatic bgutil provider must remain pinned, hook-free, and script-only'
  );
  assert(
    potBootstrap.includes("normalized.includes('PROXY')") &&
      potBootstrap.includes("normalized.startsWith('NPM_CONFIG_')") &&
      potBootstrap.includes("normalized !== 'NODE_OPTIONS'") &&
      potBootstrap.includes("normalized !== 'YT_DLP_PLUGIN_DIRS'"),
    'Automatic provider subprocess environment must remain allowlisted and injection-free'
  );
  assert(
    youtubeYtdlpSource.includes("'--no-plugin-dirs'") &&
      youtubeYtdlpSource.includes("'--plugin-dirs'") &&
      youtubeYtdlpSource.includes('providerPaths.pluginDir') &&
      youtubeYtdlpSource.includes('youtube:player_client=mweb;youtubepot-bgutilscript:server_home=') &&
      youtubeYtdlpSource.includes("'--no-remote-components'") &&
      youtubeYtdlpSource.includes("'--proxy'") &&
      youtubeYtdlpSource.includes("''"),
    'yt-dlp may load only the exact local automatic provider with mweb and empty proxy'
  );
  assert(
    envExample.includes('YOUTUBE_COOKIES_PATH=') &&
      youtubeYtdlpSource.includes("args.push('--cookies', cookiePath)") &&
      youtubeYtdlpSource.includes('allowCookies !== true') &&
      youtubeYtdlpSource.includes('stat.isSymbolicLink()') &&
      youtubeYtdlpSource.includes('ytdlpMaxCookieBytes = 1024 * 1024') &&
      musicService.includes('env?.BOT_OWNER_ID') &&
      musicService.includes('env?.DISCORD_GUILD_ID') &&
      musicService.includes('allowCookies: isPrivateYouTubeCookieAccess') &&
      musicService.includes('if (isYtdlpCookieConfigurationError(localError)) throw localError;') &&
      !youtubeYtdlpSource.includes('--cookies-from-browser'),
    'Private yt-dlp cookies must remain explicit, bounded, owner/guild isolated, and browser-independent'
  );

  assert(envExample.includes('LAVALINK_ALLOW_PUBLIC_FALLBACK=false'), 'Public Lavalink fallback must default off');
  assert(lavalinkService.includes("source: 'self-hosted-env'"), 'Self-hosted Lavalink node mode is missing');
  assert(lavalinkService.includes('LAVALINK_PUBLIC_FALLBACK_PASSWORD'), 'Explicit public fallback credentials are missing');
  assert(
    lavalinkCompose.includes('build:') &&
      lavalinkCompose.includes('dockerfile: Dockerfile') &&
      lavalinkCompose.includes('xiaoji-lavalink:4.2.2-lavasrc4.8.3-ytdlp2026.07.04'),
    'Lavalink Compose must build the pinned local runtime image'
  );
  assert(
    lavalinkCompose.includes('curl --fail --silent --show-error') &&
      !lavalinkCompose.includes('wget '),
    'Lavalink healthcheck must use the explicitly installed curl binary'
  );
  assert(
    lavalinkDockerfile.includes('4.2.2@sha256:87ae53e60dc147c9dddb28e126ce503a26bc8d1477ed8d99543614677882afff'),
    'Render Lavalink image digest is not pinned'
  );
  assert(
    lavalinkDockerfile.includes('YTDLP_VERSION=2026.07.04') &&
      lavalinkDockerfile.includes('YTDLP_SHA256=495be29ff4d9d4e9be7eabdfef225221e5d5282e77f2f505abc6dca80349f3fd') &&
      lavalinkDockerfile.includes('DENO_VERSION=2.9.5') &&
      lavalinkDockerfile.includes('DENO_SHA256=8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530') &&
      lavalinkDockerfile.includes('sha256sum --check --strict') &&
      !lavalinkDockerfile.includes('releases/latest'),
    'yt-dlp and Deno must be immutable and SHA-256 verified'
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
    lavalinkApplication.includes('com.github.topi314.lavasrc:lavasrc-plugin:4.8.3') &&
      lavalinkApplication.includes('repository: "https://maven.lavalink.dev/releases"') &&
      !lavalinkApplication.includes('dev.lavalink.youtube:youtube-plugin'),
    'Pinned LavaSrc-only YouTube loader contract is missing'
  );
  const lavalinkSourcesBlock = lavalinkApplication.match(/^\s{4}sources:[ \t]*\r?\n((?:^\s{6}[A-Za-z]+:[ \t]+(?:true|false)[ \t]*\r?\n?)+)/m);
  assert(lavalinkSourcesBlock, 'Lavalink built-in sources block is missing');
  const lavalinkSources = Object.fromEntries(
    [...lavalinkSourcesBlock[1].matchAll(/^\s{6}([A-Za-z]+):[ \t]+(true|false)[ \t]*$/gm)]
      .map((match) => [match[1], match[2] === 'true'])
  );
  assert(
    lavalinkSources.youtube === false &&
      lavalinkSources.soundcloud === true &&
      ['bandcamp', 'twitch', 'vimeo', 'nico', 'http', 'local'].every((source) => lavalinkSources[source] === false),
    'Only the built-in SoundCloud source may be enabled for cross-source fallback'
  );
  assert(
    /^\s{6}ytdlp:\s+true\s*$/m.test(lavalinkApplication) &&
      /^\s{6}path:\s+"\/usr\/local\/bin\/yt-dlp"\s*$/m.test(lavalinkApplication) &&
      /^\s{6}searchLimit:\s+1\s*$/m.test(lavalinkApplication),
    'LavaSrc yt-dlp source must be the only YouTube loader'
  );
  assert(!/^\s{2}youtube:\s*$/m.test(lavalinkApplication), 'youtube-source client configuration must remain absent');
  assertSafeYoutubeCredentialPolicy(lavalinkApplication);
  assert(
    musicService.includes('scsearch:') &&
      musicService.includes('soundcloud-same-track') &&
      musicService.includes('SoundCloud 同曲備援'),
    'SoundCloud same-track fallback contract is missing'
  );

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
  assert(
    aiService.includes("const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b'") &&
      aiService.includes("const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1'") &&
      aiService.includes('max_completion_tokens: 500') &&
      !aiService.includes('process.env.GROQ_MODEL ||') &&
      !aiService.includes('process.env.GROQ_BASE_URL ||'),
    'Groq GPT OSS 120B model, fixed official endpoint, and Chat Completions parameters must remain pinned'
  );
  assert(!aiService.includes('/music,'), 'AI public command list must not advertise private music');

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
    'LAVALINK_SELF_HOST.md',
    'npm run deploy',
    'npm start',
    'npm test',
  ]) {
    assert(readme.includes(text), `README.md is missing ${text}`);
  }

  assert(readme.includes('not a supported public feature in 1.0.0'), 'README must disclose the private music boundary');
  assert(!readme.includes('the only music-playback entry point'), 'README must not advertise public music playback');
  assert(!readme.includes('ordinary public single-video YouTube URLs'), 'README must not claim public YouTube support');
  assert(readme.includes('openai/gpt-oss-120b'), 'README must document the Groq production model');
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
