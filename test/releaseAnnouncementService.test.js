const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const ownsDatabasePath = !process.env.COIN_DB_PATH;
const temporaryDatabaseDirectory = ownsDatabasePath
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-release-announcements-'))
  : null;
const dbPath = process.env.COIN_DB_PATH
  || path.join(temporaryDatabaseDirectory, 'coin.sqlite');
process.env.COIN_DB_PATH = dbPath;
const {
  initializeCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
} = require('../src/services/coinDatabase');
const { getGuildFeatureSetting } = require('../src/services/featurePlatformService');
const {
  DEFAULT_REPOSITORY,
  FEATURE_KEY,
  RELEASES_PER_PAGE,
  claimNextDelivery,
  fetchGithubReleases,
  normalizeRelease,
  parseRepository,
  parseStableSemver,
  persistReleasesAndDeliveries,
  processReleaseAnnouncementTick,
  readReleaseAnnouncementConfig,
  selectReleaseChannel,
  startReleaseAnnouncementScheduler,
  stopReleaseAnnouncementScheduler,
  validateReleaseUrl,
} = require('../src/services/releaseAnnouncementService');
const releaseCommand = require('../src/commands/release-announcements');

const config = readReleaseAnnouncementConfig({ GITHUB_RELEASE_REPOSITORY: DEFAULT_REPOSITORY });

test.after(async () => {
  await resetCoinDatabaseForTests();
  if (ownsDatabasePath) {
    fs.rmSync(temporaryDatabaseDirectory, { recursive: true, force: true });
    delete process.env.COIN_DB_PATH;
  }
});

function rawRelease({ id = 100, tag = 'v1.0.0', name = 'Stable', body = 'Safe notes', draft = false, prerelease = false } = {}) {
  return {
    id,
    tag_name: tag,
    name,
    body,
    draft,
    prerelease,
    html_url: `https://github.com/${DEFAULT_REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`,
    published_at: '2026-09-03T00:00:00.000Z',
  };
}

function mockResponse(url, rows, overrides = {}) {
  const text = overrides.text ?? JSON.stringify(rows);
  const headers = new Map([
    ['content-type', overrides.contentType || 'application/json; charset=utf-8'],
    ['content-length', String(overrides.contentLength ?? Buffer.byteLength(text))],
  ]);
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    url: overrides.url || url,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) || null },
    text: async () => text,
  };
}

function createChannel(id, { type = ChannelType.GuildText, guildId = 'guild-1', allowed = true, send } = {}) {
  return {
    id,
    name: `channel-${id}`,
    type,
    guildId,
    isThread: () => false,
    permissionsFor: () => ({ has: () => allowed }),
    send: send || (async () => ({ id: `message-${id}` })),
  };
}

function createGuild(id, channels, { systemChannel = null } = {}) {
  return {
    id,
    members: { me: { id: 'bot' }, fetch: async () => ({ permissions: { has: () => true } }) },
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
    systemChannel,
  };
}

function createClient(guilds) {
  return { guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) } };
}

function oneReleaseFetch(release = rawRelease()) {
  return async (url) => mockResponse(url, [release]);
}

test.beforeEach(() => {
  stopReleaseAnnouncementScheduler();
  resetCoinDatabaseForTests();
  fs.rmSync(dbPath, { force: true });
});
test.after(() => stopReleaseAnnouncementScheduler());

test('release normalization accepts only stable semver GitHub Releases from 1.0.0', () => {
  assert.deepEqual(parseStableSemver('v1.2.3'), { major: 1, minor: 2, patch: 3, normalized: '1.2.3' });
  for (const tag of ['0.9.9', 'v1.0.0-rc.1', 'latest', '1.01.0']) assert.equal(parseStableSemver(tag), null);
  assert.equal(normalizeRelease(rawRelease({ draft: true }), config), null);
  assert.equal(normalizeRelease(rawRelease({ prerelease: true }), config), null);
  assert.equal(normalizeRelease(rawRelease({ tag: 'v0.9.9' }), config), null);
  assert.equal(normalizeRelease(rawRelease({ tag: 'feature-merge' }), config), null);
  assert.equal(normalizeRelease({ tag_name: 'v2.0.0' }, config), null);
  assert.equal(normalizeRelease({ ...rawRelease(), html_url: 'https://evil.example/release' }, config), null);
  const bounded = normalizeRelease(rawRelease({ name: 'n'.repeat(400), body: '@everyone ' + 'b'.repeat(5_000) }), config);
  assert.ok(bounded.releaseName.length <= 200);
  assert.ok(bounded.bodySummary.length <= 3_500);
  assert.equal(parseRepository(DEFAULT_REPOSITORY).repository, DEFAULT_REPOSITORY);
  assert.throws(() => parseRepository('owner/repo/extra'), /invalid/);
  assert.equal(validateReleaseUrl(rawRelease().html_url, config, 'v1.0.0'), rawRelease().html_url);
});

test('GitHub fetch uses only the bounded releases endpoint and returns oldest first', async () => {
  const requests = [];
  const rows = [
    rawRelease({ id: 3, tag: 'v2.0.0' }),
    rawRelease({ id: 1, tag: 'v1.0.0' }),
    rawRelease({ id: 2, tag: 'v1.1.0' }),
    rawRelease({ id: 4, tag: 'v3.0.0', draft: true }),
  ];
  const releases = await fetchGithubReleases(config, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return mockResponse(url, rows);
    },
  });
  assert.deepEqual(releases.map((release) => release.normalized), ['1.0.0', '1.1.0', '2.0.0']);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/api\.github\.com\/repos\/xichengyu810067-lab\/xiaoji\/releases\?per_page=50&page=1$/);
  assert.doesNotMatch(requests[0].url, /commits|branches|tags/);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Accept, 'application/vnd.github+json');
  assert.equal(requests[0].options.headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('GitHub fetch paginates within bounds and rejects timeout, redirect, oversized, and invalid responses', async () => {
  const firstPage = Array.from({ length: RELEASES_PER_PAGE }, (_value, index) => rawRelease({ id: index + 1, tag: `v1.0.${index}` }));
  const pages = [];
  const releases = await fetchGithubReleases(config, {
    fetchImpl: async (url) => {
      pages.push(url);
      return mockResponse(url, url.endsWith('page=1') ? firstPage : [rawRelease({ id: 999, tag: 'v2.0.0' })]);
    },
  });
  assert.equal(pages.length, 2);
  assert.equal(releases.length, RELEASES_PER_PAGE + 1);

  await assert.rejects(() => fetchGithubReleases(config, {
    fetchImpl: async (url) => mockResponse(url, [], { url: 'https://api.github.com/redirected' }),
  }), (error) => error.code === 'REDIRECT_REJECTED');
  await assert.rejects(() => fetchGithubReleases(config, {
    fetchImpl: async (url) => mockResponse(url, [], { contentLength: 2 * 1024 * 1024 + 1 }),
  }), (error) => error.code === 'RESPONSE_TOO_LARGE');
  await assert.rejects(() => fetchGithubReleases(config, {
    setTimeoutFn: (callback) => { callback(); return 1; },
    clearTimeoutFn() {},
    fetchImpl: async (_url, options) => {
      if (options.signal.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
      throw new Error('unexpected');
    },
  }), (error) => error.code === 'FETCH_TIMEOUT');
  await assert.rejects(() => fetchGithubReleases(config, {
    fetchImpl: async (url) => mockResponse(url, {}, {}),
  }), (error) => error.code === 'RESPONSE_INVALID');
  await assert.rejects(() => fetchGithubReleases(config, {
    fetchImpl: async (url) => mockResponse(url, firstPage),
  }), (error) => error.code === 'PAGE_LIMIT');
});

test('channel selection honors preferred, then system, then deterministic announcement/text permissions', async () => {
  const preferred = createChannel('preferred');
  const system = createChannel('system');
  const announcement = createChannel('announcement', { type: ChannelType.GuildAnnouncement });
  const text = createChannel('text');
  const guild = createGuild('guild-1', [preferred, system, announcement, text], { systemChannel: system });
  assert.equal(await selectReleaseChannel(guild, { settingReader: async () => ({ channelId: 'preferred' }) }), preferred);
  preferred.permissionsFor = () => ({ has: () => false });
  assert.equal(await selectReleaseChannel(guild, { settingReader: async () => ({ channelId: 'preferred' }) }), system);
  system.permissionsFor = () => ({ has: () => false });
  assert.equal(await selectReleaseChannel(guild, { settingReader: async () => ({ channelId: null }) }), announcement);
  announcement.isThread = () => true;
  assert.equal(await selectReleaseChannel(guild, { settingReader: async () => ({ channelId: null }) }), text);
});

test('delivery lease claim is single-owner and only an expired lease can be reclaimed', async () => {
  await initializeCoinDatabase();
  const now = new Date('2026-09-03T00:00:00.000Z');
  await persistReleasesAndDeliveries([normalizeRelease(rawRelease(), config)], ['guild-1'], now);
  const claims = await Promise.all([
    claimNextDelivery('worker-a', now),
    claimNextDelivery('worker-b', now),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await claimNextDelivery('worker-c', now), null);
  const reclaimed = await claimNextDelivery('worker-c', new Date(now.getTime() + 3 * 60 * 1000));
  assert.equal(reclaimed.lease_owner, 'worker-c');
  assert.equal(reclaimed.attempt_count, 2);
});

test('approved guild delivery is idempotent across restart and a newly approved guild receives backfill', async () => {
  await initializeCoinDatabase();
  const payloads = [];
  const channel1 = createChannel('channel-1', { guildId: 'guild-1', send: async (payload) => { payloads.push(payload); return { id: 'm1' }; } });
  const channel2 = createChannel('channel-2', { guildId: 'guild-2', send: async () => { throw new Error('denied guild must not send'); } });
  const guild1 = createGuild('guild-1', [channel1], { systemChannel: channel1 });
  const guild2 = createGuild('guild-2', [channel2], { systemChannel: channel2 });
  const client = createClient([guild1, guild2]);
  const approved = new Set(['guild-1']);
  const options = { config, fetchImpl: oneReleaseFetch(), auditChecker: (id) => approved.has(id), now: new Date('2026-09-03T01:00:00Z') };
  assert.equal((await processReleaseAnnouncementTick(client, options)).delivered, 1);
  assert.equal((await processReleaseAnnouncementTick(client, options)).delivered, 0);
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].allowedMentions, { parse: [] });
  assert.equal(payloads[0].enforceNonce, true);
  assert.equal(typeof payloads[0].nonce, 'string');
  assert.match(payloads[0].embeds[0].toJSON().title, /正式 GitHub Release/);

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const backfillPayloads = [];
  const channel3 = createChannel('channel-3', { guildId: 'guild-3', send: async (payload) => { backfillPayloads.push(payload); return { id: 'm3' }; } });
  const guild3 = createGuild('guild-3', [channel3], { systemChannel: channel3 });
  client.guilds.cache.set('guild-3', guild3);
  approved.add('guild-3');
  assert.equal((await processReleaseAnnouncementTick(client, { ...options, now: new Date('2026-09-03T01:01:00Z') })).delivered, 1);
  assert.equal(backfillPayloads.length, 1);
  const rows = await withCoinDatabase((api) => api.all('SELECT guild_id, status FROM release_announcement_deliveries ORDER BY guild_id'));
  assert.deepEqual(rows, [{ guild_id: 'guild-1', status: 'delivered' }, { guild_id: 'guild-3', status: 'delivered' }]);
});

test('a revoked guild is suppressed without sending and is safely re-enqueued after approval', async () => {
  await initializeCoinDatabase();
  const release = normalizeRelease(rawRelease(), config);
  const now = new Date('2026-09-03T01:30:00.000Z');
  await persistReleasesAndDeliveries([release], ['guild-1'], now);
  let sends = 0;
  const channel = createChannel('channel-1', { send: async () => { sends += 1; return { id: 'message' }; } });
  const client = createClient([createGuild('guild-1', [channel], { systemChannel: channel })]);
  const revoked = await processReleaseAnnouncementTick(client, {
    config,
    fetchImpl: async (url) => mockResponse(url, []),
    auditChecker: () => false,
    now,
  });
  assert.equal(revoked.suppressed, 1);
  assert.equal(sends, 0);
  assert.equal((await withCoinDatabase((api) => api.get('SELECT status FROM release_announcement_deliveries'))).status, 'suppressed');

  const approved = await processReleaseAnnouncementTick(client, {
    config,
    fetchImpl: oneReleaseFetch(),
    auditChecker: () => true,
    now: new Date('2026-09-03T01:31:00.000Z'),
  });
  assert.equal(approved.delivered, 1);
  assert.equal(sends, 1);
  assert.equal((await withCoinDatabase((api) => api.get('SELECT status FROM release_announcement_deliveries'))).status, 'delivered');
});

test('deterministic nonce closes retry/restart crash boundary at application level', async () => {
  await initializeCoinDatabase();
  const seen = new Map();
  let attempts = 0;
  const channel = createChannel('channel', { send: async (payload) => {
    attempts += 1;
    if (!seen.has(payload.nonce)) seen.set(payload.nonce, { id: 'same-message' });
    return seen.get(payload.nonce);
  } });
  const guild = createGuild('guild-1', [channel], { systemChannel: channel });
  const client = createClient([guild]);
  const base = { config, fetchImpl: oneReleaseFetch(), auditChecker: () => true, now: new Date('2026-09-03T02:00:00Z') };
  const first = await processReleaseAnnouncementTick(client, { ...base, afterSend: async () => { throw new Error('simulated ack crash'); } });
  assert.equal(first.failed, 1);
  resetCoinDatabaseForTests(); await initializeCoinDatabase();
  const second = await processReleaseAnnouncementTick(client, { ...base, now: new Date('2026-09-03T02:05:00Z') });
  assert.equal(second.delivered, 1);
  assert.equal(attempts, 2);
  assert.equal(seen.size, 1);
  const row = await withCoinDatabase((api) => api.get('SELECT status, attempt_count FROM release_announcement_deliveries'));
  assert.deepEqual(row, { status: 'delivered', attempt_count: 2 });
});

test('delivery failures retry with leases and become bounded dead letters without crashing', async () => {
  await initializeCoinDatabase();
  const guild = createGuild('guild-1', []);
  const client = createClient([guild]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await processReleaseAnnouncementTick(client, {
      config,
      fetchImpl: oneReleaseFetch(),
      auditChecker: () => true,
      now: new Date(Date.parse('2026-09-03T03:00:00Z') + attempt * 5 * 60 * 1000),
    });
    assert.equal(result.failed, 1);
  }
  const row = await withCoinDatabase((api) => api.get('SELECT status, attempt_count, last_error FROM release_announcement_deliveries'));
  assert.deepEqual(row, { status: 'dead_letter', attempt_count: 5, last_error: 'CHANNEL_UNAVAILABLE' });
});

test('temporary GitHub failure is contained and records only bounded health state', async () => {
  await initializeCoinDatabase();
  const result = await processReleaseAnnouncementTick(createClient([]), {
    config,
    fetchImpl: async () => { throw new Error('secret token data'); },
  });
  assert.equal(result.ok, false);
  const health = await withCoinDatabase((api) => api.get("SELECT status, detail FROM feature_health WHERE feature_key = 'release_announcements'"));
  assert.deepEqual(health, { status: 'broken', detail: 'github_sync_failed' });
});

test('scheduler starts catch-up once, is single-flight, unrefs, and stops cleanly', async () => {
  await initializeCoinDatabase();
  let resolveFetch;
  const pendingFetch = new Promise((resolve) => { resolveFetch = resolve; });
  let unrefCount = 0;
  let cleared = null;
  const timer = { unref: () => { unrefCount += 1; } };
  const state = startReleaseAnnouncementScheduler(createClient([]), {
    config,
    fetchImpl: async (url) => { await pendingFetch; return mockResponse(url, []); },
    healthReporter: async () => {},
    setIntervalFn: () => timer,
    clearIntervalFn: (value) => { cleared = value; },
  });
  const first = state.inFlight;
  assert.equal(state.run(), first);
  assert.equal(unrefCount, 1);
  resolveFetch();
  await first;
  assert.equal(stopReleaseAnnouncementScheduler(), true);
  assert.equal(cleared, timer);
});

test('schema v18 migrates to v19 and incompatible same-named tables preserve original bytes', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (name) => path.join(distPath, name) });
  await initializeCoinDatabase(); resetCoinDatabaseForTests();
  const legacy = new SQL.Database(fs.readFileSync(dbPath));
  legacy.exec("DROP TABLE release_announcement_deliveries; DROP TABLE github_releases; UPDATE coin_metadata SET value = '18' WHERE key = 'schema_version'; CREATE TABLE release_sentinel (value TEXT); INSERT INTO release_sentinel VALUES ('keep')");
  fs.writeFileSync(dbPath, Buffer.from(legacy.export())); legacy.close();
  const info = await initializeCoinDatabase();
  const migrated = await withCoinDatabase((api) => ({
    version: api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'").value,
    sentinel: api.get('SELECT value FROM release_sentinel').value,
    tables: api.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('github_releases','release_announcement_deliveries') ORDER BY name").map((row) => row.name),
  }));
  assert.equal(info.schemaVersion, 19);
  assert.equal(migrated.version, '19');
  assert.equal(migrated.sentinel, 'keep');
  assert.deepEqual(migrated.tables, ['github_releases', 'release_announcement_deliveries']);

  resetCoinDatabaseForTests();
  const unsafe = new SQL.Database(fs.readFileSync(dbPath));
  unsafe.exec("DROP TABLE release_announcement_deliveries; DROP TABLE github_releases; CREATE TABLE github_releases (release_id TEXT PRIMARY KEY); UPDATE coin_metadata SET value = '18' WHERE key = 'schema_version'");
  const originalBytes = Buffer.from(unsafe.export()); fs.writeFileSync(dbPath, originalBytes); unsafe.close();
  await assert.rejects(() => initializeCoinDatabase(), /升級失敗/);
  assert.deepEqual(fs.readFileSync(dbPath), originalBytes);

  resetCoinDatabaseForTests();
  const constraintUnsafe = new SQL.Database();
  constraintUnsafe.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata VALUES ('schema_version', '18', '2026-01-01T00:00:00.000Z');
    CREATE TABLE github_releases (
      release_id TEXT PRIMARY KEY NOT NULL, repository TEXT NOT NULL, tag_name TEXT NOT NULL,
      version_major INTEGER NOT NULL, version_minor INTEGER NOT NULL, version_patch INTEGER NOT NULL,
      release_name TEXT NOT NULL, body_summary TEXT NOT NULL, html_url TEXT NOT NULL,
      metadata_digest TEXT NOT NULL, published_at TEXT NOT NULL, discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE release_announcement_deliveries (
      release_id TEXT NOT NULL, guild_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, lease_owner TEXT,
      lease_until TEXT, last_error TEXT, nonce TEXT NOT NULL, delivered_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (release_id, guild_id)
    );
  `);
  const constraintUnsafeBytes = Buffer.from(constraintUnsafe.export());
  fs.writeFileSync(dbPath, constraintUnsafeBytes);
  constraintUnsafe.close();
  await assert.rejects(() => initializeCoinDatabase(), /v19 結構驗證失敗/);
  assert.deepEqual(fs.readFileSync(dbPath), constraintUnsafeBytes);
});

test('release announcement command is admin-only, saves a guild channel, and exposes no raw IDs', async () => {
  await initializeCoinDatabase();
  let deniedPayload;
  await releaseCommand.execute({
    commandName: 'release-announcements', guildId: 'guild-1', user: { id: 'user', tag: 'user' },
    inGuild: () => true,
    guild: { members: { me: {}, fetch: async () => ({ permissions: { has: () => false } }) }, channels: { cache: new Map() } },
    memberPermissions: { has: () => false },
    options: { getSubcommand: () => 'status' },
    reply: async (payload) => { deniedPayload = payload; },
  });
  assert.equal(deniedPayload.ephemeral, true);
  assert.match(deniedPayload.content, /管理員/);

  const channel = createChannel('123456789012345678');
  let adminPayload;
  await releaseCommand.execute({
    commandName: 'release-announcements', guildId: 'guild-1', user: { id: 'admin', tag: 'admin' },
    inGuild: () => true,
    guild: { members: { me: {}, fetch: async () => ({ permissions: { has: () => true } }) }, channels: { cache: new Map([[channel.id, channel]]) } },
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.Administrator },
    options: { getSubcommand: () => 'set', getChannel: () => channel },
    reply: async (payload) => { adminPayload = payload; },
  });
  assert.equal(adminPayload.ephemeral, true);
  assert.match(adminPayload.content, /#channel-/);
  assert.doesNotMatch(adminPayload.content, /123456789012345678/);
  assert.equal((await getGuildFeatureSetting('guild-1', FEATURE_KEY)).channelId, channel.id);
});
