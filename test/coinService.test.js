const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-coin-'));
const dbPath = path.join(tempDirectory, 'xiaoji.sqlite');

process.env.COIN_DB_PATH = dbPath;
process.env.COIN_TIMEZONE = 'Asia/Taipei';

const { initializeCoinDatabase, resetCoinDatabaseForTests, withCoinDatabase, withCoinTransaction } = require('../src/services/coinDatabase');
const {
  FEATURE_KEYS,
  claimFeatureOutbox,
  enqueueFeatureOutbox,
  getGuildFeatureSetting,
  grantRewardOnce,
  listFeatureHealth,
  listGuildFeatureSettings,
  markFeatureOutboxDelivered,
  recordFeatureUsage,
  retryFeatureOutbox,
  setFeatureHealth,
  setGuildFeatureSetting,
} = require('../src/services/featurePlatformService');
const {
  REACTION_EMOJI,
  buildReactionPayload,
  acceptWordChainMessage,
  getWordChainStatus,
  handleWordChainMessage,
  processWordChainReactionOutbox,
  startWordChain,
  stopWordChain,
  validateWord,
} = require('../src/services/wordChainService');
const { assertCorpusInvariant, getSuccessors, words } = require('../src/services/wordChainLexicon');
const { createMessageFeatureRouter } = require('../src/services/messageFeatureRouter');
const {
  getNextTaipeiOccurrence,
  getTaipeiDateKey,
  getTaipeiDayRange,
  getTaipeiMinuteOfDay,
  isTaipeiTime,
} = require('../src/utils/taipeiClock');
const {
  CoinServiceError,
  ShopItemTypes,
  adjustPlayerBalance,
  createShopItem,
  dailyCheckin,
  getInventory,
  getPlayerBalance,
  purchaseItem,
} = require('../src/services/coinService');
const {
  buyChips,
  cashoutChips,
  getChipBalance,
} = require('../src/services/chipService');
const {
  createLuxuryItem,
  editLuxuryItem,
  getLuxuryInventory,
  pawnLuxuryItem,
  purchaseLuxuryItem,
  redeemPawnRecord,
} = require('../src/services/luxuryService');
const {
  createFixedDeposit,
  deposit,
  getAllBalanceSummaries,
  getBalanceSummary,
  listFixedDeposits,
  setFixedRate,
} = require('../src/services/bankService');
const {
  addPendingTask,
  deleteWorkSubmission,
  editWorkSubmission,
  getPayrollHistory,
  listWorkPenalties,
  listJobs,
  listWorkTasks,
  processDueJobs,
  processExpiredWorkTasks,
  reportWork,
  reviewWorkPenaltyAppeal,
  reviewWorkSubmission,
  createWorkPenaltyAppeal,
  startJob,
  startVenueJobs,
} = require('../src/services/workService');
const {
  VenueItemType,
  addVenueMenuItem,
  completeVenueOrderItem,
  createVenueOrder,
  getVenueRecipe,
  listVenueHistory,
  listVenueMenu,
  processExpiredVenueOrderItems,
  serveVenueOrder,
} = require('../src/services/venueService');
const {
  applyCasinoLoanRelief,
  collectCasinoDebt,
  getCasinoDebtStatus,
  getCasinoLoanStatus,
  getHandValue,
  hitBlackjack,
  listCasinoHistory,
  playBaccarat,
  playDice,
  playPoker,
  playRoulette,
  playSlots,
  borrowCasinoLoan,
  processExpiredBlackjackSessions,
  repayCasinoLoan,
  standBlackjack,
  startBlackjack,
} = require('../src/services/casinoService');
const {
  bookLodging,
  enterDuelTower,
  getDuelTowerProfile,
  listOwnedBattleWeapons,
} = require('../src/services/casinoFacilityService');

test.beforeEach(() => {
  resetCoinDatabaseForTests();

  if (fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('coin database auto-creates SQLite file and schema', async () => {
  const info = await initializeCoinDatabase();

  assert.equal(info.path, dbPath);
  assert.equal(info.createdDatabase, true);
  assert.equal(fs.existsSync(dbPath), true);
  assert.ok(info.createdTables.includes('coin_players'));
  assert.ok(info.createdTables.includes('coin_transactions'));
  assert.ok(info.createdTables.includes('coin_admin_logs'));
  assert.ok(info.createdTables.includes('chip_accounts'));
  assert.ok(info.createdTables.includes('luxury_items'));
  assert.ok(info.createdTables.includes('casino_lodging_bookings'));
  assert.ok(info.createdTables.includes('casino_duel_tower_runs'));
  assert.ok(info.createdTables.includes('coin_work_penalties'));
  assert.ok(info.createdTables.includes('coin_work_penalty_appeals'));
  assert.equal(info.schemaVersion, 12);
  assert.ok(info.createdTables.includes('feature_guild_settings'));
  assert.ok(info.createdTables.includes('feature_outbox'));
  assert.ok(info.createdTables.includes('feature_outbox_dead_letters'));
  assert.ok(info.createdTables.includes('reward_grants'));
  assert.ok(info.createdTables.includes('feature_usage_daily'));
  assert.ok(info.createdTables.includes('feature_health'));
  assert.ok(info.createdTables.includes('text_chain_sessions'));
  assert.ok(info.createdTables.includes('text_chain_entries'));

  const schema = await withCoinTransaction((api) => ({
    version: api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'").value,
    usageColumns: api.all('PRAGMA table_info(feature_usage_daily)').map((column) => column.name),
  }));

  assert.equal(schema.version, '12');
  assert.deepEqual(schema.usageColumns, ['usage_date', 'feature_key', 'metric_key', 'usage_count', 'updated_at']);
});

test('coin database migrates a v10 sentinel database to v12 without changing sentinel data', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '10', '2026-01-01T00:00:00.000Z');
    CREATE TABLE sentinel_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sentinel_records (id, value) VALUES (1, 'keep-me');
  `);
  fs.writeFileSync(dbPath, Buffer.from(fixture.export()));
  fixture.close();

  const info = await initializeCoinDatabase();
  const migrated = await withCoinTransaction((api) => ({
    version: api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'").value,
    sentinel: api.get('SELECT value FROM sentinel_records WHERE id = 1').value,
    featureTables: api
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'feature_%' ORDER BY name")
      .map((row) => row.name),
  }));

  assert.equal(info.existed, true);
  assert.equal(info.schemaVersion, 12);
  assert.equal(migrated.version, '12');
  assert.equal(migrated.sentinel, 'keep-me');
  assert.deepEqual(migrated.featureTables, [
    'feature_guild_settings',
    'feature_health',
    'feature_outbox',
    'feature_outbox_dead_letters',
    'feature_usage_daily',
  ]);
});

test('coin database reconciles legacy multi-active word-chain sessions without dropping sessions or entries', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '12', '2026-01-01T00:00:00.000Z');
    CREATE TABLE text_chain_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
      current_word TEXT NOT NULL, last_word TEXT NOT NULL, last_user_id TEXT,
      started_by TEXT NOT NULL, stopped_by TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, stopped_at TEXT, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE text_chain_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL, word TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE feature_guild_settings (
      guild_id TEXT NOT NULL, feature_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      channel_id TEXT, config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, feature_key)
    );
    INSERT INTO text_chain_sessions (id, guild_id, channel_id, status, current_word, last_word, started_by, created_at, updated_at) VALUES
      (1, 'legacy-guild', 'channel-old', 'active', '安心', '安心', 'legacy-admin', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
      (2, 'legacy-guild', 'channel-tie-loser', 'active', '心意', '心意', 'legacy-admin', '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
      (3, 'legacy-guild', 'channel-retained', 'active', '意見', '意見', 'legacy-admin', '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
      (4, 'legacy-guild', 'channel-stopped', 'stopped', '白雲', '白雲', 'legacy-admin', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      (5, 'other-guild', 'other-channel', 'active', '不安', '不安', 'legacy-admin', '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
    INSERT INTO text_chain_entries (session_id, guild_id, channel_id, message_id, user_id, word, created_at) VALUES
      (1, 'legacy-guild', 'channel-old', 'legacy-message-1', 'user-1', '安心', '2026-01-03T00:00:00.000Z'),
      (2, 'legacy-guild', 'channel-tie-loser', 'legacy-message-2', 'user-2', '心意', '2026-01-04T00:00:00.000Z'),
      (3, 'legacy-guild', 'channel-retained', 'legacy-message-3', 'user-3', '意見', '2026-01-04T00:00:00.000Z'),
      (4, 'legacy-guild', 'channel-stopped', 'legacy-message-4', 'user-4', '白雲', '2026-01-02T00:00:00.000Z'),
      (5, 'other-guild', 'other-channel', 'legacy-message-5', 'user-5', '不安', '2026-01-05T00:00:00.000Z');
    INSERT INTO feature_guild_settings (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at) VALUES
      ('legacy-guild', 'word_chain', 1, 'channel-old', '{"legacy":true}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('inactive-guild', 'word_chain', 1, 'stale-channel', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  fs.writeFileSync(dbPath, Buffer.from(fixture.export()));
  fixture.close();

  await initializeCoinDatabase();
  const migrated = await withCoinDatabase((api) => ({
    sessions: api.all('SELECT id, guild_id, channel_id, status, current_word, completed_at FROM text_chain_sessions ORDER BY id'),
    entries: api.all('SELECT session_id, message_id FROM text_chain_entries ORDER BY id'),
    settings: api.all("SELECT guild_id, enabled, channel_id FROM feature_guild_settings WHERE feature_key = 'word_chain' ORDER BY guild_id"),
    columns: api.all('PRAGMA table_info(text_chain_sessions)').map((column) => column.name),
    index: api.get("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_text_chain_one_active_guild'").sql,
  }));
  assert.deepEqual(migrated.sessions, [
    { id: 1, guild_id: 'legacy-guild', channel_id: 'channel-old', status: 'stopped', current_word: '安心', completed_at: null },
    { id: 2, guild_id: 'legacy-guild', channel_id: 'channel-tie-loser', status: 'stopped', current_word: '心意', completed_at: null },
    { id: 3, guild_id: 'legacy-guild', channel_id: 'channel-retained', status: 'active', current_word: '意見', completed_at: null },
    { id: 4, guild_id: 'legacy-guild', channel_id: 'channel-stopped', status: 'stopped', current_word: '白雲', completed_at: null },
    { id: 5, guild_id: 'other-guild', channel_id: 'other-channel', status: 'active', current_word: '不安', completed_at: null },
  ]);
  assert.deepEqual(migrated.entries, [
    { session_id: 1, message_id: 'legacy-message-1' },
    { session_id: 2, message_id: 'legacy-message-2' },
    { session_id: 3, message_id: 'legacy-message-3' },
    { session_id: 4, message_id: 'legacy-message-4' },
    { session_id: 5, message_id: 'legacy-message-5' },
  ]);
  assert.deepEqual(migrated.settings, [
    { guild_id: 'inactive-guild', enabled: 0, channel_id: null },
    { guild_id: 'legacy-guild', enabled: 1, channel_id: 'channel-retained' },
    { guild_id: 'other-guild', enabled: 1, channel_id: 'other-channel' },
  ]);
  assert.ok(migrated.columns.includes('completed_at'));
  assert.match(migrated.index, /UNIQUE INDEX idx_text_chain_one_active_guild/i);

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const reopened = await withCoinDatabase((api) => ({
    sessions: api.all('SELECT id, status FROM text_chain_sessions ORDER BY id'),
    settings: api.all("SELECT guild_id, enabled, channel_id FROM feature_guild_settings WHERE feature_key = 'word_chain' ORDER BY guild_id"),
  }));
  assert.deepEqual(reopened.sessions, migrated.sessions.map(({ id, status }) => ({ id, status })));
  assert.deepEqual(reopened.settings, migrated.settings);
});

test('coin database rejects corrupt input without overwriting it', async () => {
  const corruptBytes = Buffer.from('not-a-sqlite-database');
  fs.writeFileSync(dbPath, corruptBytes);

  await assert.rejects(() => initializeCoinDatabase(), /完整性檢查失敗/);
  assert.deepEqual(fs.readFileSync(dbPath), corruptBytes);
});

test('v12 migration fails closed when an incompatible foundation table already exists', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '10', '2026-01-01T00:00:00.000Z');
    CREATE TABLE feature_outbox (id INTEGER PRIMARY KEY);
  `);
  const originalBytes = Buffer.from(fixture.export());
  fs.writeFileSync(dbPath, originalBytes);
  fixture.close();

  await assert.rejects(() => initializeCoinDatabase(), /資料庫升級失敗/);
  assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
});

test('v12 schema verification rejects complete foundation tables with unsafe defaults or missing checks', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixtures = [
    {
      name: 'enabled default is on',
      definition: `
        CREATE TABLE feature_guild_settings (
          guild_id TEXT NOT NULL,
          feature_key TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          channel_id TEXT,
          config_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (guild_id, feature_key)
        );`,
    },
    {
      name: 'outbox status check is missing',
      definition: `
        CREATE TABLE feature_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          feature_key TEXT NOT NULL,
          event_type TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          available_at TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          claimed_by TEXT,
          claimed_at TEXT,
          lease_until TEXT,
          delivered_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (guild_id, feature_key, event_type, dedupe_key)
        );`,
    },
  ];

  for (const fixtureCase of fixtures) {
    resetCoinDatabaseForTests();
    fs.rmSync(dbPath, { force: true });
    const fixture = new SQL.Database();
    fixture.exec(`
      CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '10', '2026-01-01T00:00:00.000Z');
      ${fixtureCase.definition}
    `);
    const originalBytes = Buffer.from(fixture.export());
    fs.writeFileSync(dbPath, originalBytes);
    fixture.close();

    await assert.rejects(() => initializeCoinDatabase(), /v12 結構驗證失敗/);
    const finalBytes = fs.readFileSync(dbPath);
    const reopened = new SQL.Database(finalBytes);
    const version = reopened.exec("SELECT value FROM coin_metadata WHERE key = 'schema_version'")[0].values[0][0];
    reopened.close();

    assert.deepEqual(finalBytes, originalBytes, fixtureCase.name);
    assert.equal(version, '10', fixtureCase.name);
  }
});

test('v11 to v12 migration adds text-chain tables and fails closed for an unsafe same-named table', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  await initializeCoinDatabase();
  resetCoinDatabaseForTests();
  const priorV12 = new SQL.Database(fs.readFileSync(dbPath));
  priorV12.exec(`
    DROP TABLE text_chain_entries;
    DROP TABLE text_chain_sessions;
    UPDATE coin_metadata SET value = '11' WHERE key = 'schema_version';
  `);
  fs.writeFileSync(dbPath, Buffer.from(priorV12.export()));
  priorV12.close();

  const migrated = await initializeCoinDatabase();
  assert.equal(migrated.schemaVersion, 12);
  assert.deepEqual(
    await withCoinDatabase((api) =>
      api.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'text_chain_%' ORDER BY name").map((row) => row.name)
    ),
    ['text_chain_entries', 'text_chain_sessions']
  );

  resetCoinDatabaseForTests();
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '11', '2026-01-01T00:00:00.000Z');
    CREATE TABLE text_chain_entries (id INTEGER PRIMARY KEY);
  `);
  const originalBytes = Buffer.from(fixture.export());
  fs.writeFileSync(dbPath, originalBytes);
  fixture.close();

  await assert.rejects(() => initializeCoinDatabase(), /資料庫升級失敗/);
  assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
});

test('word-chain validator normalizes input and rejects invalid length, characters, and unknown words', () => {
  assert.deepEqual(validateWord('  安心  '), { ok: true, word: '安心', graphemes: ['安', '心'] });
  assert.equal(validateWord('一二三四五六七').code, 'INVALID_LENGTH');
  assert.equal(validateWord('安1心').code, 'INVALID_CHARACTERS');
  assert.equal(validateWord('火星語').code, 'UNKNOWN_WORD');
});

test('word-chain corpus graph has deterministic successors and explicitly terminal words', () => {
  assert.doesNotThrow(() => assertCorpusInvariant());
  assert.ok(words.length >= 150);
  for (const word of words) {
    for (const successor of getSuccessors(word)) {
      assert.equal(successor[0], word.at(-1));
    }
  }
  assert.deepEqual(getSuccessors('白雲'), []);
  assert.ok(getSuccessors('明白').includes('白雲'));
});

test('word-chain accepts only valid alternating entries and de-duplicates Discord delivery', async () => {
  await startWordChain({ guildId: 'guild-word', channelId: 'channel-word', actorId: 'admin-word', seed: '不安' });

  const accepted = await acceptWordChainMessage({
    guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-1', userId: 'user-a', content: '安心',
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.completed, false);
  assert.equal(accepted.session.currentWord, '安心');
  assert.equal(accepted.session.revision, 1);

  const duplicate = await acceptWordChainMessage({
    guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-1', userId: 'user-a', content: '安心',
  });
  assert.deepEqual(duplicate, { ok: true, duplicate: true, sessionId: accepted.session.id });

  const sameUser = await acceptWordChainMessage({
    guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-2', userId: 'user-a', content: '心情',
  });
  assert.equal(sameUser.code, 'SAME_USER');

  await acceptWordChainMessage({ guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-3', userId: 'user-b', content: '心意' });
  await acceptWordChainMessage({ guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-4', userId: 'user-c', content: '意見' });
  await acceptWordChainMessage({ guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-5', userId: 'user-a', content: '見面' });
  await acceptWordChainMessage({ guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-6', userId: 'user-b', content: '面前' });
  await acceptWordChainMessage({ guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-7', userId: 'user-c', content: '前面' });

  const repeated = await acceptWordChainMessage({
    guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-8', userId: 'user-a', content: '面前',
  });
  assert.equal(repeated.code, 'REPEATED_WORD');

  const wrongChannel = await acceptWordChainMessage({
    guildId: 'guild-word', channelId: 'channel-other', expectedChannelId: 'channel-word', messageId: 'message-9', userId: 'user-b', content: '哥哥',
  });
  assert.equal(wrongChannel.code, 'WRONG_CHANNEL');
  assert.equal((await getWordChainStatus('guild-word', 'channel-word')).revision, 6);
  assert.equal((await stopWordChain({ guildId: 'guild-word', channelId: 'channel-word', actorId: 'admin-word' })).stopped, true);
});

test('word-chain reaction delivery confirms accepted messages and retries a bounded outbox reaction', async () => {
  await startWordChain({ guildId: 'guild-react', channelId: 'channel-react', actorId: 'admin-react', seed: '不安' });
  const replies = [];
  const acceptedMessage = {
    id: 'reaction-ok', guildId: 'guild-react', channelId: 'channel-react', content: '安心', author: { id: 'user-a' },
    react: async (emoji) => { assert.equal(emoji, REACTION_EMOJI); }, reply: async (payload) => replies.push(payload),
  };
  assert.equal(await handleWordChainMessage(acceptedMessage, { channelId: 'channel-react' }), true);
  assert.deepEqual(replies, []);

  await stopWordChain({ guildId: 'guild-react', channelId: 'channel-react', actorId: 'admin-react' });
  await startWordChain({ guildId: 'guild-react', channelId: 'channel-react', actorId: 'admin-react', seed: '不安' });

  const failedMessage = {
    id: 'reaction-retry', guildId: 'guild-react', channelId: 'channel-react', content: '安心', author: { id: 'user-b' },
    react: async () => { throw new Error('missing reaction permission'); }, reply: async (payload) => replies.push(payload),
  };
  assert.equal(await handleWordChainMessage(failedMessage, { channelId: 'channel-react' }), true);
  const beforeRetry = await withCoinDatabase((api) => api.get("SELECT status, payload_json FROM feature_outbox WHERE dedupe_key = 'reaction:reaction-retry'"));
  assert.equal(beforeRetry.status, 'pending');
  assert.doesNotMatch(beforeRetry.payload_json, /哥哥/);

  const retryChannel = {
    messages: { fetch: async () => ({ react: async () => { throw new Error('temporary Discord failure'); } }) },
  };
  const retryGuild = { channels: { cache: new Map([['channel-react', retryChannel]]) } };
  const retryClient = { guilds: { cache: new Map([['guild-react', retryGuild]]) } };
  const firstAttempt = await processWordChainReactionOutbox(retryClient, { workerId: 'test-word-retry' });
  assert.deepEqual(firstAttempt, { claimed: 1, delivered: 0, retried: 1 });
  const afterFailure = await withCoinDatabase((api) => api.get("SELECT status, attempt_count FROM feature_outbox WHERE dedupe_key = 'reaction:reaction-retry'"));
  assert.equal(afterFailure.status, 'pending');
  assert.equal(Number(afterFailure.attempt_count), 1);

  await withCoinTransaction((api) => api.run("UPDATE feature_outbox SET available_at = '2000-01-01T00:00:00.000Z' WHERE dedupe_key = 'reaction:reaction-retry'"));
  let reacted = false;
  const successChannel = {
    messages: { fetch: async () => ({ react: async (emoji) => { reacted = emoji === REACTION_EMOJI; } }) },
  };
  const successGuild = { channels: { cache: new Map([['channel-react', successChannel]]) } };
  const successClient = { guilds: { cache: new Map([['guild-react', successGuild]]) } };
  const secondAttempt = await processWordChainReactionOutbox(successClient, { workerId: 'test-word-retry-two' });
  assert.deepEqual(secondAttempt, { claimed: 1, delivered: 1, retried: 0 });
  assert.equal(reacted, true);
});

test('terminal word completes the session atomically and tells players how to start another round', async () => {
  await startWordChain({ guildId: 'guild-terminal', channelId: 'channel-terminal', actorId: 'admin-terminal' });
  const replies = [];
  const message = {
    id: 'terminal-message', guildId: 'guild-terminal', channelId: 'channel-terminal', content: '白雲', author: { id: 'user-terminal' },
    react: async (emoji) => assert.equal(emoji, REACTION_EMOJI), reply: async (payload) => replies.push(payload),
  };
  await handleWordChainMessage(message, { channelId: 'channel-terminal' });
  const session = await withCoinDatabase((api) => api.get('SELECT status, completed_at FROM text_chain_sessions WHERE guild_id = ?', ['guild-terminal']));
  assert.equal(session.status, 'completed');
  assert.ok(session.completed_at);
  assert.equal(await getWordChainStatus('guild-terminal', 'channel-terminal'), null);
  assert.match(replies[0].content, /完成/);
  assert.match(replies[0].content, /\/word-chain start/);
  assert.equal((await getGuildFeatureSetting('guild-terminal', 'word_chain')).enabled, false);
});

test('word-chain start switches the only active guild session and feature setting in one transaction', async () => {
  await startWordChain({ guildId: 'guild-switch', channelId: 'channel-a', actorId: 'admin-switch', seed: '不安' });
  const switched = await startWordChain({ guildId: 'guild-switch', channelId: 'channel-b', actorId: 'admin-switch', seed: '明白' });
  assert.equal(switched.alreadyActive, false);
  assert.equal(switched.stoppedSession.status, 'stopped');
  const state = await withCoinDatabase((api) => ({
    sessions: api.all('SELECT channel_id, status FROM text_chain_sessions WHERE guild_id = ? ORDER BY id', ['guild-switch']),
  }));
  assert.deepEqual(state.sessions, [
    { channel_id: 'channel-a', status: 'stopped' },
    { channel_id: 'channel-b', status: 'active' },
  ]);
  assert.deepEqual(
    { enabled: (await getGuildFeatureSetting('guild-switch', 'word_chain')).enabled, channelId: (await getGuildFeatureSetting('guild-switch', 'word_chain')).channelId },
    { enabled: true, channelId: 'channel-b' }
  );
  assert.equal((await stopWordChain({ guildId: 'guild-switch', channelId: 'channel-b', actorId: 'admin-switch' })).stopped, true);
  assert.equal((await getGuildFeatureSetting('guild-switch', 'word_chain')).enabled, false);
});

test('word-chain start rolls back session switch and feature setting when its transaction fails', async () => {
  await startWordChain({ guildId: 'guild-rollback', channelId: 'channel-a', actorId: 'admin-rollback', seed: '不安' });
  await assert.rejects(
    () => startWordChain({
      guildId: 'guild-rollback', channelId: 'channel-b', actorId: 'admin-rollback', seed: '明白',
      beforeCommit: () => { throw new Error('synthetic persistence failure'); },
    }),
    /synthetic persistence failure/
  );
  assert.equal((await getWordChainStatus('guild-rollback', 'channel-a')).status, 'active');
  assert.equal(await getWordChainStatus('guild-rollback', 'channel-b'), null);
  const setting = await getGuildFeatureSetting('guild-rollback', 'word_chain');
  assert.deepEqual({ enabled: setting.enabled, channelId: setting.channelId }, { enabled: true, channelId: 'channel-a' });
});

test('word-chain outbox dead-letters permanent Discord errors and bounded retry exhaustion', async () => {
  const queue = async (dedupeKey, channelId = 'channel-dead') => enqueueFeatureOutbox({
    guildId: 'guild-dead', featureKey: 'word_chain', eventType: 'discord_reaction', dedupeKey,
    payload: buildReactionPayload({ guildId: 'guild-dead', channelId, messageId: dedupeKey }),
  });
  await queue('permanent');
  const permanentChannel = {
    messages: { fetch: async () => ({ react: async () => { const error = new Error('missing permissions'); error.code = 50013; throw error; } }) },
  };
  const permanentGuild = {
    channels: {
      cache: new Map([['channel-dead', permanentChannel]]),
      fetch: async () => { const error = new Error('unknown channel'); error.code = 10003; throw error; },
    },
  };
  const permanentClient = { guilds: { cache: new Map([['guild-dead', permanentGuild]]) } };
  await processWordChainReactionOutbox(permanentClient, { workerId: 'dead-permanent' });
  const permanent = await withCoinDatabase((api) => ({
    outbox: api.get("SELECT id FROM feature_outbox WHERE dedupe_key = 'permanent'"),
    dead: api.get("SELECT dead_letter_reason FROM feature_outbox_dead_letters WHERE dedupe_key = 'permanent'"),
    health: api.get("SELECT status FROM feature_health WHERE feature_key = 'word_chain'"),
  }));
  assert.equal(permanent.outbox, null);
  assert.equal(permanent.dead.dead_letter_reason, 'discord_permanent_50013');
  assert.equal(permanent.health.status, 'broken');

  await queue('deleted-channel', 'channel-deleted');
  await processWordChainReactionOutbox(permanentClient, { workerId: 'dead-deleted-channel' });
  assert.equal(
    (await withCoinDatabase((api) => api.get("SELECT dead_letter_reason FROM feature_outbox_dead_letters WHERE dedupe_key = 'deleted-channel'"))).dead_letter_reason,
    'discord_permanent_10003'
  );

  await queue('max-attempts');
  await withCoinTransaction((api) => api.run("UPDATE feature_outbox SET attempt_count = 4 WHERE dedupe_key = 'max-attempts'"));
  const temporaryChannel = { messages: { fetch: async () => ({ react: async () => { throw new Error('temporary'); } }) } };
  const temporaryGuild = { channels: { cache: new Map([['channel-dead', temporaryChannel]]) } };
  const temporaryClient = { guilds: { cache: new Map([['guild-dead', temporaryGuild]]) } };
  await processWordChainReactionOutbox(temporaryClient, { workerId: 'dead-max' });
  assert.equal(
    (await withCoinDatabase((api) => api.get("SELECT dead_letter_reason FROM feature_outbox_dead_letters WHERE dedupe_key = 'max-attempts'"))).dead_letter_reason,
    'max_attempts'
  );
});

test('word-chain outbox does not report delivery or retry after a lost lease and bounds reaction payloads', async () => {
  const event = {
    id: 99, guildId: 'guild-lease', featureKey: 'word_chain', eventType: 'discord_reaction', attemptCount: 1,
    payload: buildReactionPayload({ guildId: 'guild-lease', channelId: 'channel-lease', messageId: 'message-lease' }),
  };
  const leaseChannel = { messages: { fetch: async () => ({ react: async () => {} }) } };
  const leaseGuild = { channels: { cache: new Map([['channel-lease', leaseChannel]]) } };
  const client = { guilds: { cache: new Map([['guild-lease', leaseGuild]]) } };
  const lostDelivery = await processWordChainReactionOutbox(client, {
    workerId: 'lost-delivery', claim: async () => [event], markDelivered: async () => ({ updated: false }), retry: async () => { throw new Error('must not retry'); },
  });
  assert.deepEqual(lostDelivery, { claimed: 1, delivered: 0, retried: 0 });
  const lostFailure = await processWordChainReactionOutbox({ guilds: { cache: new Map() } }, {
    workerId: 'lost-failure', claim: async () => [{ ...event, id: 100 }], retry: async () => ({ updated: false }), deadLetter: async () => ({ updated: false }),
  });
  assert.deepEqual(lostFailure, { claimed: 1, delivered: 0, retried: 0 });
  assert.throws(
    () => buildReactionPayload({ guildId: 'g'.repeat(81), channelId: 'channel', messageId: 'message' }),
    /guildId is required/
  );
});

test('message feature router gives word chain first chance and message event keeps it between automod and mention/memory', async () => {
  const order = [];
  const router = createMessageFeatureRouter({
    handlers: {
      word_chain: async () => { order.push('word_chain'); return true; },
      number_chain: async () => { order.push('number_chain'); return true; },
    },
    loadSetting: async () => ({ enabled: true, channelId: 'channel-router' }),
  });
  assert.equal((await router({ guildId: 'guild-router', channelId: 'channel-router', author: { bot: false } })).featureKey, 'word_chain');
  assert.deepEqual(order, ['word_chain']);

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'events', 'messageCreate.js'), 'utf8');
  assert.ok(source.indexOf('await handleAutomodMessage') < source.indexOf('await routeMessageFeatures'));
  assert.ok(source.indexOf('await routeMessageFeatures') < source.indexOf('await handleMentionMessage'));
  assert.ok(source.indexOf('await routeMessageFeatures') < source.indexOf('recordPublicMessage(message)'));
});

test('feature rewards are atomic and idempotent across concurrent calls and restart', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 12 }, () =>
      grantRewardOnce('guild-foundation', 'user-foundation', 'daily_riddle', '2026-09-03', 'participation', 30, {
        synthetic: true,
      })
    )
  );

  assert.equal(attempts.filter((result) => !result.alreadyGranted).length, 1);
  assert.equal(attempts.filter((result) => result.alreadyGranted).length, 11);

  const beforeRestart = await withCoinTransaction((api) => ({
    player: api.get(
      'SELECT balance, total_earned FROM coin_players WHERE guild_id = ? AND user_id = ?',
      ['guild-foundation', 'user-foundation']
    ),
    grants: api.get('SELECT COUNT(*) AS count FROM reward_grants').count,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE type = 'system_reward'").count,
    integrity: api.get('PRAGMA integrity_check').integrity_check,
  }));

  assert.equal(Number(beforeRestart.player.balance), 30);
  assert.equal(Number(beforeRestart.player.total_earned), 30);
  assert.equal(Number(beforeRestart.grants), 1);
  assert.equal(Number(beforeRestart.transactions), 1);
  assert.equal(beforeRestart.integrity, 'ok');

  resetCoinDatabaseForTests();
  const duplicate = await grantRewardOnce(
    'guild-foundation',
    'user-foundation',
    'daily_riddle',
    '2026-09-03',
    'participation',
    30,
    { synthetic: true }
  );

  assert.equal(duplicate.alreadyGranted, true);
  assert.equal(duplicate.balance, 30);
  assert.equal(duplicate.totalEarned, 30);
});

test('feature rewards reject disabled guild economies before creating grants, players, or transactions', async () => {
  await withCoinTransaction((api) => {
    api.run(
      `INSERT INTO coin_guild_settings (guild_id, enabled, created_at, updated_at)
       VALUES (?, 0, ?, ?)`,
      ['guild-disabled', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z']
    );
  });

  await assert.rejects(
    () => grantRewardOnce('guild-disabled', 'user-disabled', 'daily_riddle', '2026-09-03', 'participation', 30),
    (error) => error.code === 'COIN_DISABLED'
  );

  const counts = await withCoinTransaction((api) => ({
    players: api.get("SELECT COUNT(*) AS count FROM coin_players WHERE guild_id = 'guild-disabled'").count,
    grants: api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'guild-disabled'").count,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE guild_id = 'guild-disabled'").count,
  }));

  assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])), {
    players: 0,
    grants: 0,
    transactions: 0,
  });
});

test('feature reward retries preserve existing grants after the guild economy is disabled', async () => {
  const first = await grantRewardOnce(
    'guild-retry-disabled',
    'user-retry-disabled',
    'daily_riddle',
    '2026-09-03',
    'participation',
    30
  );
  await withCoinTransaction((api) => {
    api.run('UPDATE coin_guild_settings SET enabled = 0 WHERE guild_id = ?', ['guild-retry-disabled']);
  });
  const beforeRetry = await withCoinTransaction((api) => ({
    player: api.get('SELECT balance, total_earned FROM coin_players WHERE guild_id = ? AND user_id = ?', [
      'guild-retry-disabled',
      'user-retry-disabled',
    ]),
    grants: api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'guild-retry-disabled'").count,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE guild_id = 'guild-retry-disabled'").count,
  }));

  const retry = await grantRewardOnce(
    'guild-retry-disabled',
    'user-retry-disabled',
    'daily_riddle',
    '2026-09-03',
    'participation',
    30
  );
  const afterRetry = await withCoinTransaction((api) => ({
    player: api.get('SELECT balance, total_earned FROM coin_players WHERE guild_id = ? AND user_id = ?', [
      'guild-retry-disabled',
      'user-retry-disabled',
    ]),
    grants: api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'guild-retry-disabled'").count,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE guild_id = 'guild-retry-disabled'").count,
  }));

  assert.equal(first.alreadyGranted, false);
  assert.equal(retry.alreadyGranted, true);
  assert.equal(retry.grant.id, first.grant.id);
  assert.equal(retry.balance, 30);
  assert.equal(retry.totalEarned, 30);
  assert.deepEqual(afterRetry, beforeRetry);
});

test('feature rewards roll back grants when safe balance or total-earned limits would overflow', async () => {
  const timestamp = '2026-09-03T00:00:00.000Z';
  await withCoinTransaction((api) => {
    api.run(
      `INSERT INTO coin_players (guild_id, user_id, balance, total_earned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['guild-limit', 'balance-limit', Number.MAX_SAFE_INTEGER, 0, timestamp, timestamp]
    );
    api.run(
      `INSERT INTO coin_players (guild_id, user_id, balance, total_earned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['guild-limit', 'earned-limit', 0, Number.MAX_SAFE_INTEGER, timestamp, timestamp]
    );
  });

  await assert.rejects(
    () => grantRewardOnce('guild-limit', 'balance-limit', 'daily_riddle', 'balance-limit', 'participation', 1),
    (error) => error.code === 'REWARD_BALANCE_LIMIT'
  );
  await assert.rejects(
    () => grantRewardOnce('guild-limit', 'earned-limit', 'daily_riddle', 'earned-limit', 'participation', 1),
    (error) => error.code === 'REWARD_TOTAL_EARNED_LIMIT'
  );

  const state = await withCoinTransaction((api) => ({
    players: api.all(
      `SELECT user_id, balance, total_earned
       FROM coin_players
       WHERE guild_id = 'guild-limit'
       ORDER BY user_id`
    ),
    grants: api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'guild-limit'").count,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE guild_id = 'guild-limit'").count,
  }));

  assert.deepEqual(state.players, [
    { user_id: 'balance-limit', balance: Number.MAX_SAFE_INTEGER, total_earned: 0 },
    { user_id: 'earned-limit', balance: 0, total_earned: Number.MAX_SAFE_INTEGER },
  ]);
  assert.equal(Number(state.grants), 0);
  assert.equal(Number(state.transactions), 0);
});

test('feature outbox survives restart, retries with a lease, and delivers once', async () => {
  const base = new Date('2026-09-03T02:00:00.000Z');
  const queued = await enqueueFeatureOutbox({
    guildId: 'guild-outbox',
    featureKey: 'daily_riddle',
    eventType: 'publish',
    dedupeKey: '2026-09-03',
    payload: { promptId: 'synthetic-riddle' },
    now: base,
    availableAt: base,
  });
  const duplicate = await enqueueFeatureOutbox({
    guildId: 'guild-outbox',
    featureKey: 'daily_riddle',
    eventType: 'publish',
    dedupeKey: '2026-09-03',
    payload: { promptId: 'ignored-duplicate' },
    now: base,
    availableAt: base,
  });

  assert.equal(queued.alreadyEnqueued, false);
  assert.equal(duplicate.alreadyEnqueued, true);
  assert.deepEqual(duplicate.event.payload, { promptId: 'synthetic-riddle' });

  resetCoinDatabaseForTests();
  const firstClaim = await claimFeatureOutbox({ workerId: 'worker-a', now: base, leaseMs: 60_000 });
  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0].attemptCount, 1);

  const retried = await retryFeatureOutbox(firstClaim[0].id, {
    workerId: 'worker-a',
    error: new Error('synthetic failure'),
    delayMs: 1_000,
    now: base,
  });
  assert.equal(retried.updated, true);
  assert.equal(retried.event.status, 'pending');
  assert.equal(retried.event.lastError, 'synthetic failure');

  resetCoinDatabaseForTests();
  assert.deepEqual(
    await claimFeatureOutbox({ workerId: 'worker-b', now: new Date(base.getTime() + 999), leaseMs: 60_000 }),
    []
  );
  const secondClaim = await claimFeatureOutbox({
    workerId: 'worker-b',
    now: new Date(base.getTime() + 1_000),
    leaseMs: 60_000,
  });
  assert.equal(secondClaim.length, 1);
  assert.equal(secondClaim[0].attemptCount, 2);

  const delivered = await markFeatureOutboxDelivered(secondClaim[0].id, {
    workerId: 'worker-b',
    now: new Date(base.getTime() + 1_100),
  });
  assert.equal(delivered.updated, true);
  assert.equal(delivered.event.status, 'delivered');

  resetCoinDatabaseForTests();
  assert.deepEqual(
    await claimFeatureOutbox({ workerId: 'worker-c', now: new Date(base.getTime() + 120_000), leaseMs: 60_000 }),
    []
  );
});

test('feature outbox reclaims expired leases, rejects wrong workers, and rolls back malformed claims', async () => {
  const base = new Date('2026-09-03T02:00:00.000Z');
  const queued = await enqueueFeatureOutbox({
    guildId: 'guild-outbox-negative',
    featureKey: 'daily_riddle',
    eventType: 'publish',
    dedupeKey: 'lease',
    payload: { promptId: 'lease-fixture' },
    now: base,
    availableAt: base,
  });
  const [firstClaim] = await claimFeatureOutbox({ workerId: 'worker-a', now: base, leaseMs: 1_000 });

  const wrongWorker = await markFeatureOutboxDelivered(queued.event.id, {
    workerId: 'worker-b',
    now: new Date(base.getTime() + 100),
  });
  assert.equal(wrongWorker.updated, false);

  const [reclaimed] = await claimFeatureOutbox({
    workerId: 'worker-b',
    now: new Date(base.getTime() + 1_000),
    leaseMs: 1_000,
  });
  assert.equal(reclaimed.id, firstClaim.id);
  assert.equal(reclaimed.attemptCount, 2);

  const staleWorker = await retryFeatureOutbox(firstClaim.id, {
    workerId: 'worker-a',
    error: 'late worker',
    now: new Date(base.getTime() + 1_001),
  });
  assert.equal(staleWorker.updated, false);

  const malformed = await enqueueFeatureOutbox({
    guildId: 'guild-outbox-negative',
    featureKey: 'daily_riddle',
    eventType: 'publish',
    dedupeKey: 'malformed',
    payload: { promptId: 'will-be-corrupted' },
    now: base,
    availableAt: base,
  });
  await withCoinTransaction((api) => {
    api.run("UPDATE feature_outbox SET payload_json = '{' WHERE id = ?", [malformed.event.id]);
  });

  await assert.rejects(
    () => claimFeatureOutbox({ workerId: 'worker-c', now: new Date(base.getTime() + 1_001), leaseMs: 1_000 }),
    (error) => error.code === 'CORRUPT_DATA'
  );
  const malformedAfterFailure = await withCoinTransaction((api) =>
    api.get('SELECT status, attempt_count FROM feature_outbox WHERE id = ?', [malformed.event.id])
  );
  assert.deepEqual(malformedAfterFailure, { status: 'pending', attempt_count: 0 });
});

test('feature transactions restore the in-memory snapshot when their database write fails', async () => {
  await initializeCoinDatabase();
  const originalBytes = fs.readFileSync(dbPath);
  const originalRename = fs.renameSync;
  fs.renameSync = (sourcePath, targetPath) => {
    if (sourcePath === `${dbPath}.tmp` && targetPath === dbPath) {
      throw new Error('synthetic persistence failure');
    }
    return originalRename(sourcePath, targetPath);
  };

  try {
    await assert.rejects(
      () =>
        setGuildFeatureSetting('guild-persist-failure', 'word_chain', {
          enabled: true,
          now: new Date('2026-09-03T00:00:00.000Z'),
        }),
      /落盤失敗/
    );
  } finally {
    fs.renameSync = originalRename;
  }

  assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
  assert.equal(fs.existsSync(`${dbPath}.tmp`), false);
  const setting = await getGuildFeatureSetting('guild-persist-failure', 'word_chain');
  const foreignKeys = await withCoinDatabase((api) => api.get('PRAGMA foreign_keys').foreign_keys);
  assert.equal(setting.persisted, false);
  assert.equal(Number(foreignKeys), 1);
});

test('feature flags default off and the router does not invoke disabled handlers', async () => {
  const setting = await getGuildFeatureSetting('guild-defaults', 'word_chain');
  const settings = await listGuildFeatureSettings('guild-defaults');
  let handlerCalls = 0;
  const router = createMessageFeatureRouter({
    handlers: {
      word_chain: async () => {
        handlerCalls += 1;
        return true;
      },
    },
  });
  const routeResult = await router({
    guildId: 'guild-defaults',
    channelId: 'channel-1',
    author: { id: 'synthetic-user', bot: false },
  });
  const storedRows = await withCoinTransaction((api) => api.get('SELECT COUNT(*) AS count FROM feature_guild_settings').count);

  assert.equal(setting.enabled, false);
  assert.equal(setting.guildId, 'guild-defaults');
  assert.equal(setting.persisted, false);
  assert.equal(settings.length, FEATURE_KEYS.length);
  assert.ok(settings.every((item) => item.enabled === false));
  assert.equal(routeResult.handled, false);
  assert.equal(handlerCalls, 0);
  assert.equal(Number(storedRows), 0);

  const enabled = await setGuildFeatureSetting('guild-defaults', 'word_chain', {
    enabled: true,
    channelId: 'channel-1',
    config: { locale: 'zh-TW' },
    now: new Date('2026-09-03T00:00:00.000Z'),
  });
  assert.equal(enabled.enabled, true);
  assert.deepEqual(enabled.config, { locale: 'zh-TW' });
});

test('feature usage is de-identified and feature health uses the constrained registry', async () => {
  const first = await recordFeatureUsage('daily_riddle', 'message', 2, new Date('2026-09-03T15:59:00.000Z'));
  const second = await recordFeatureUsage('daily_riddle', 'message', 3, new Date('2026-09-03T15:59:30.000Z'));
  await setFeatureHealth('daily_riddle', 'maintenance', {
    detail: 'synthetic maintenance',
    now: new Date('2026-09-03T16:00:00.000Z'),
  });
  const health = await listFeatureHealth();

  assert.equal(first.usageDate, '2026-09-03');
  assert.equal(second.usageCount, 5);
  assert.deepEqual(health, [
    {
      featureKey: 'daily_riddle',
      status: 'maintenance',
      detail: 'synthetic maintenance',
      updatedAt: '2026-09-03T16:00:00.000Z',
    },
  ]);
  await assert.rejects(
    () => recordFeatureUsage('daily_riddle', '123456789012345678', 1, new Date('2026-09-03T16:01:00.000Z')),
    (error) => error.code === 'INVALID_USAGE_METRIC'
  );
  await assert.rejects(
    () => recordFeatureUsage('daily_riddle', 'free-form-note', 1, new Date('2026-09-03T16:01:00.000Z')),
    (error) => error.code === 'INVALID_USAGE_METRIC'
  );
});

test('Taipei clock helpers handle midnight and daily schedule boundaries', () => {
  const beforeMidnight = new Date('2026-09-03T15:59:59.999Z');
  const midnight = new Date('2026-09-03T16:00:00.000Z');
  const beforeTen = new Date('2026-09-04T01:59:00.000Z');

  assert.equal(getTaipeiDateKey(beforeMidnight), '2026-09-03');
  assert.equal(getTaipeiMinuteOfDay(beforeMidnight), 23 * 60 + 59);
  assert.equal(getTaipeiDateKey(midnight), '2026-09-04');
  assert.equal(isTaipeiTime(midnight, 0, 0), true);
  assert.deepEqual(getTaipeiDayRange(midnight), {
    dateKey: '2026-09-04',
    start: midnight,
    endExclusive: new Date('2026-09-04T16:00:00.000Z'),
  });
  assert.equal(getNextTaipeiOccurrence(10, 0, beforeTen).toISOString(), '2026-09-04T02:00:00.000Z');
  assert.equal(
    getNextTaipeiOccurrence(21, 30, new Date('2026-09-04T13:30:00.000Z')).toISOString(),
    '2026-09-05T13:30:00.000Z'
  );
});

test('daily checkin grants coins once and survives service restart', async () => {
  const first = await dailyCheckin('guild-1', 'user-1', new Date('2026-05-17T03:00:00.000Z'));

  assert.equal(first.earned, 50);
  assert.equal(first.player.balance, 50);
  assert.equal(first.streak, 1);

  await assert.rejects(
    () => dailyCheckin('guild-1', 'user-1', new Date('2026-05-17T08:00:00.000Z')),
    (error) => error instanceof CoinServiceError && error.code === 'ALREADY_CHECKED_IN'
  );

  resetCoinDatabaseForTests();
  const balance = await getPlayerBalance('guild-1', 'user-1');

  assert.equal(balance.balance, 50);
  assert.equal(balance.lastDailyDate, '2026-05-17');
});

test('shop purchase deducts balance, writes inventory, and enforces purchase limit', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 200,
    operatorId: 'admin-1',
    reason: 'test funds',
  });
  const item = await createShopItem('guild-1', {
    name: '測試徽章',
    description: '測試用收藏道具',
    price: 75,
    type: 'collectible',
    stock: 2,
    purchaseLimit: 1,
    createdBy: 'admin-1',
  });
  const purchase = await purchaseItem('guild-1', 'user-1', item.id, 1);
  const balance = await getPlayerBalance('guild-1', 'user-1');
  const inventory = await getInventory('guild-1', 'user-1');

  assert.equal(purchase.totalPrice, 75);
  assert.equal(balance.balance, 125);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].itemName, '測試徽章');
  assert.equal(inventory[0].quantity, 1);

  await assert.rejects(
    () => purchaseItem('guild-1', 'user-1', item.id, 1),
    (error) => error instanceof CoinServiceError && error.code === 'PURCHASE_LIMIT'
  );
});

test('fixed deposits lock rates and appear in balance summaries', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 5000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });
  await setFixedRate('guild-1', 7, 1, { operatorId: 'admin-1', reason: 'test rate' });
  const fixed = await createFixedDeposit('guild-1', 'user-1', { amount: 1000, termDays: 7 });
  const summary = await getBalanceSummary('guild-1', 'user-1');
  const allSummaries = await getAllBalanceSummaries('guild-1');
  const deposits = await listFixedDeposits('guild-1', { userId: 'user-1' });

  assert.equal(fixed.rate, 0.01);
  assert.equal(fixed.expectedInterest, 10);
  assert.equal(summary.walletBalance, 4000);
  assert.equal(summary.fixedPrincipal, 1000);
  assert.equal(summary.fixedExpectedInterest, 10);
  assert.equal(summary.totalAssets, 5010);
  assert.equal(allSummaries[0].totalAssets, 5010);
  assert.equal(deposits.length, 1);
});

test('chip exchange buys at 1:1 and cashes out with tiered fees', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 700_500,
    operatorId: 'admin-1',
    reason: 'test funds',
  });

  const bought = await buyChips('guild-1', 'user-1', 600_500);
  const lowCashout = await cashoutChips('guild-1', 'user-1', 500_000);
  const highCashout = await cashoutChips('guild-1', 'user-1', 100_500);
  const balance = await getPlayerBalance('guild-1', 'user-1');
  const chips = await getChipBalance('guild-1', 'user-1');

  assert.equal(bought.balanceAfter, 600_500);
  assert.equal(lowCashout.fee, 100);
  assert.equal(lowCashout.coinAmount, 499_900);
  assert.equal(highCashout.fee, 100);
  assert.equal(highCashout.coinAmount, 100_400);
  assert.equal(chips.balance, 0);
  assert.equal(balance.balance, 700_300);

  await buyChips('guild-1', 'user-1', 500_001);
  const thresholdCashout = await cashoutChips('guild-1', 'user-1', 500_001);

  assert.equal(thresholdCashout.fee, 200);
  assert.equal(thresholdCashout.coinAmount, 499_801);
});

test('casino loans borrow chips, accrue coin-denominated debt, and repay with chips', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 5000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });

  const borrowed = await borrowCasinoLoan('guild-1', 'user-1', {
    amount: 1000,
    date: new Date('2026-05-20T04:00:00.000Z'),
  });
  const dayOne = await getCasinoLoanStatus('guild-1', 'user-1', {
    date: new Date('2026-05-21T04:00:00.000Z'),
  });
  const dayTwo = await getCasinoLoanStatus('guild-1', 'user-1', {
    date: new Date('2026-05-22T04:00:00.000Z'),
  });
  const partial = await repayCasinoLoan('guild-1', 'user-1', {
    amount: 61,
    date: new Date('2026-05-22T05:00:00.000Z'),
  });
  const final = await repayCasinoLoan('guild-1', 'user-1', {
    amount: 2000,
    date: new Date('2026-05-22T06:00:00.000Z'),
  });
  const balance = await getPlayerBalance('guild-1', 'user-1');
  const chips = await getChipBalance('guild-1', 'user-1');

  assert.equal(borrowed.borrowedAmount, 1000);
  assert.equal(borrowed.balanceAfter, 1000);
  assert.equal(dayOne.loan.currentDebtAmount, 1030);
  assert.equal(dayOne.interestApplied, 30);
  assert.equal(dayTwo.loan.currentDebtAmount, 1061);
  assert.equal(dayTwo.interestApplied, 31);
  assert.equal(partial.repaymentAmount, 61);
  assert.equal(partial.loan.currentDebtAmount, 1000);
  assert.equal(final.repaymentAmount, 1000);
  assert.equal(final.loan.status, 'repaid');
  assert.equal(final.loan.currentDebtAmount, 0);
  assert.equal(final.autoTopUpAmount, 61);
  assert.equal(balance.balance, 4939);
  assert.equal(chips.balance, 0);
});

test('casino loan relief reduces interest gradually and floors at half rate', async () => {
  await borrowCasinoLoan('guild-1', 'user-1', {
    amount: 1000,
    date: new Date('2026-05-20T04:00:00.000Z'),
  });

  let lastRelief;
  for (let index = 0; index < 10; index += 1) {
    lastRelief = await applyCasinoLoanRelief('guild-1', 'user-1', {
      operatorId: 'owner-1',
      reason: `relief ${index + 1}`,
      date: new Date('2026-05-20T05:00:00.000Z'),
    });
  }

  assert.equal(lastRelief.reliefCount, 10);
  assert.equal(lastRelief.newRate, 0.015);

  await assert.rejects(
    () =>
      applyCasinoLoanRelief('guild-1', 'user-1', {
        operatorId: 'owner-1',
        reason: 'over limit',
        date: new Date('2026-05-20T06:00:00.000Z'),
      }),
    (error) => error instanceof CoinServiceError && error.code === 'CASINO_LOAN_RELIEF_LIMIT'
  );

  const status = await getCasinoDebtStatus('guild-1', 'user-1', {
    date: new Date('2026-05-21T04:00:00.000Z'),
  });
  const publicHistory = await listCasinoHistory('guild-1', 'user-1', { limit: 25 });

  assert.equal(status.loan.interestRate, 0.015);
  assert.equal(status.loan.currentDebtAmount, 1015);
  assert.equal(status.interestApplied, 15);
  assert.equal(publicHistory.some((row) => row.entryType === 'loan_relief'), false);
});

test('casino forced collection uses wallet then demand deposit and never touches fixed deposits', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 9000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });
  const fixed = await createFixedDeposit('guild-1', 'user-1', { amount: 1000, termDays: 7 });
  await borrowCasinoLoan('guild-1', 'user-1', {
    amount: 4000,
    date: new Date('2026-05-20T04:00:00.000Z'),
  });
  await deposit('guild-1', 'user-1', 7500);

  const collected = await collectCasinoDebt('guild-1', 'user-1', {
    amount: 3000,
    operatorId: 'owner-1',
    reason: 'internal collection',
    date: new Date('2026-05-20T05:00:00.000Z'),
  });
  const summary = await getBalanceSummary('guild-1', 'user-1');
  const fixedDeposits = await listFixedDeposits('guild-1', { userId: 'user-1' });
  const publicHistory = await listCasinoHistory('guild-1', 'user-1', { limit: 25 });

  assert.equal(collected.collectionAmount, 3000);
  assert.equal(collected.walletCollected, 500);
  assert.equal(collected.bankCollected, 2500);
  assert.equal(collected.debtAfter, 1000);
  assert.equal(summary.walletBalance, 0);
  assert.equal(summary.bankBalance, 5000);
  assert.equal(summary.fixedPrincipal, 1000);
  assert.equal(fixedDeposits[0].id, fixed.id);
  assert.equal(fixedDeposits[0].status, 'active');
  assert.equal(fixedDeposits[0].principal, 1000);
  assert.equal(publicHistory.some((row) => row.entryType === 'loan_forced_collection'), false);
});

test('casino dice and slots settle against chips and auto top up from wallet', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 1000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });

  const dice = await playDice('guild-1', 'user-1', {
    amount: 100,
    choice: 'big',
    rng: () => 3,
  });
  const slotValues = [4, 4, 4];
  const slots = await playSlots('guild-1', 'user-1', {
    amount: 100,
    rng: () => slotValues.shift(),
  });
  const balance = await getPlayerBalance('guild-1', 'user-1');
  const chips = await getChipBalance('guild-1', 'user-1');

  assert.deepEqual(dice.game.result.dice, [4, 4]);
  assert.equal(dice.payoutAmount, 200);
  assert.equal(dice.netAmount, 100);
  assert.equal(dice.autoTopUpAmount, 100);
  assert.deepEqual(slots.game.result.reels, ['七', '七', '七']);
  assert.equal(slots.payoutAmount, 1000);
  assert.equal(slots.netAmount, 900);
  assert.equal(balance.balance, 900);
  assert.equal(chips.balance, 1100);
});

test('casino roulette, baccarat, and poker settle as chip games', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 10_000,
    operatorId: 'admin-1',
    reason: 'casino funds',
  });

  const roulette = await playRoulette('guild-1', 'user-1', {
    amount: 100,
    choice: 'red',
    rng: () => 1,
  });
  const baccarat = await playBaccarat('guild-1', 'user-1', {
    amount: 100,
    choice: 'player',
    rng: () => 0,
  });
  const poker = await playPoker('guild-1', 'user-1', {
    amount: 100,
    rng: () => 0,
  });

  assert.equal(roulette.game.gameType, 'roulette');
  assert.equal(roulette.game.result.number, 1);
  assert.equal(roulette.game.result.color, 'red');
  assert.equal(baccarat.game.gameType, 'baccarat');
  assert.ok(['player', 'banker', 'tie'].includes(baccarat.game.result.outcome));
  assert.equal(poker.game.gameType, 'poker');
  assert.ok(['win', 'lose', 'push'].includes(poker.game.result.outcome));
});

test('casino blackjack settles natural, hit bust, and stand outcomes', async () => {
  assert.equal(getHandValue(['AS', 'AH', '9C']), 21);

  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 1000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });
  const natural = await startBlackjack('guild-1', 'user-1', {
    amount: 100,
    deck: ['AS', 'KH', '9C', '7D'],
  });

  assert.equal(natural.session.status, 'settled');
  assert.equal(natural.session.payoutAmount, 250);
  assert.equal(natural.session.netAmount, 150);
  assert.equal(natural.autoTopUpAmount, 100);
  assert.equal((await getPlayerBalance('guild-1', 'user-1')).balance, 900);
  assert.equal((await getChipBalance('guild-1', 'user-1')).balance, 250);

  const hitStart = await startBlackjack('guild-1', 'user-1', {
    amount: 100,
    deck: ['10S', '7H', '9C', '7D', '8S'],
  });
  const hitResult = await hitBlackjack('guild-1', 'user-1', hitStart.session.id);

  assert.equal(hitResult.session.status, 'settled');
  assert.equal(hitResult.session.result.outcome, 'lose');
  assert.equal(hitResult.session.netAmount, -100);
  assert.equal((await getChipBalance('guild-1', 'user-1')).balance, 150);

  const standStart = await startBlackjack('guild-1', 'user-1', {
    amount: 100,
    deck: ['10S', '8H', '9C', '7D', '10D'],
  });
  const standResult = await standBlackjack('guild-1', 'user-1', standStart.session.id);

  assert.equal(standResult.session.status, 'settled');
  assert.equal(standResult.session.result.outcome, 'win');
  assert.equal(standResult.session.payoutAmount, 200);
  assert.equal((await getChipBalance('guild-1', 'user-1')).balance, 250);
  assert.equal((await getPlayerBalance('guild-1', 'user-1')).balance, 900);
});

test('casino blackjack timeout refunds the escrowed bet', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 1000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });

  const started = await startBlackjack('guild-1', 'user-1', {
    amount: 100,
    deck: ['10S', '7H', '9C', '7D', '8S'],
    date: new Date('2026-05-20T00:00:00.000Z'),
  });
  const afterStart = await getPlayerBalance('guild-1', 'user-1');
  const expired = await processExpiredBlackjackSessions({
    date: new Date('2026-05-20T00:11:00.000Z'),
  });
  const afterRefund = await getPlayerBalance('guild-1', 'user-1');
  const chips = await getChipBalance('guild-1', 'user-1');

  assert.equal(started.session.status, 'active');
  assert.equal(started.autoTopUpAmount, 100);
  assert.equal(afterStart.balance, 900);
  assert.equal(expired.refunded, 1);
  assert.equal(afterRefund.balance, 900);
  assert.equal(chips.balance, 100);
});

test('work job list uses updated rank, salary, and report channel data', async () => {
  const info = await listJobs();
  const byName = new Map(info.jobs.map((job) => [job.name, job]));

  assert.equal(byName.get('會計師').salary, 500);
  assert.equal(byName.get('會計師').rank, '正一品官員');
  assert.equal(byName.get('會計師').reportChannelName, '會計師');
  assert.equal(byName.get('老師').salary, 400);
  assert.equal(byName.get('翻譯官').salary, 300);
  assert.equal(byName.get('翻譯官').externalServerBonus, 200);
  assert.equal(byName.get('小幫手').salary, 200);
  assert.equal(byName.get('清潔工').salary, 100);
  assert.equal(byName.get('迎賓員').salary, 50);
  assert.equal(byName.get('廚師').salary, 70);
  assert.equal(byName.get('調酒師').salary, 60);
  assert.equal(byName.get('服務生').salary, 0);
  assert.equal(byName.get('制服服務生').salary, 0);
});

test('casino venue menu seeds defaults and accepts user-added items', async () => {
  const meals = await listVenueMenu('guild-1', { itemType: VenueItemType.MEAL });
  const created = await addVenueMenuItem('guild-1', {
    itemType: VenueItemType.DRINK,
    name: '測試蜂蜜茶',
    steps: '加入蜂蜜\n倒入熱茶\n攪拌後上桌',
    createdBy: 'user-1',
  });
  const drinks = await listVenueMenu('guild-1', { itemType: VenueItemType.DRINK });

  assert.ok(meals.some((item) => item.name === '小吉炒飯'));
  assert.equal(created.itemType, VenueItemType.DRINK);
  assert.ok(drinks.some((item) => item.id === created.id && item.name === '測試蜂蜜茶'));
});

test('venue job bundle starts multiple jobs on one shared cycle and prevents waiter conflicts', async () => {
  const result = await startVenueJobs('guild-1', 'staff-1', {
    days: 10,
    chef: true,
    bartender: true,
    waiter: '制服服務生',
  });

  assert.equal(result.jobs.length, 3);
  assert.equal(new Set(result.jobs.map((job) => job.payAt)).size, 1);
  assert.equal(result.jobs.every((job) => job.workDays === 10), true);

  await assert.rejects(
    () => startJob('guild-1', 'staff-1', '服務生', 10),
    (error) => error instanceof CoinServiceError && error.code === 'WAITER_JOB_CONFLICT'
  );
  await assert.rejects(
    () => startJob('guild-1', 'staff-1', '廚師', 5),
    (error) => error instanceof CoinServiceError && error.code === 'HAS_ACTIVE_JOB'
  );
});

test('casino venue orders assign active staff and require assigned makers to complete items', async () => {
  await startJob('guild-1', 'chef-1', '廚師', 1);
  await startJob('guild-1', 'bartender-1', '調酒師', 1);
  await startJob('guild-1', 'waiter-1', '服務生', 1);
  await adjustPlayerBalance('guild-1', 'customer-1', {
    action: 'add',
    amount: 100,
    operatorId: 'admin-1',
    reason: 'tip funds',
  });
  const meal = (await listVenueMenu('guild-1', { itemType: VenueItemType.MEAL }))[0];
  const drink = (await listVenueMenu('guild-1', { itemType: VenueItemType.DRINK }))[0];

  const result = await createVenueOrder('guild-1', 'customer-1', {
    mealId: meal.id,
    drinkId: drink.id,
    chefId: 'chef-1',
    bartenderId: 'bartender-1',
    waiterId: 'waiter-1',
    tipAmount: 50,
    date: new Date('2026-05-20T04:00:00.000Z'),
  });
  const mealItem = result.items.find((item) => item.itemType === VenueItemType.MEAL);
  const drinkItem = result.items.find((item) => item.itemType === VenueItemType.DRINK);

  assert.equal(result.items.length, 2);
  assert.equal(mealItem.makerUserId, 'chef-1');
  assert.equal(drinkItem.makerUserId, 'bartender-1');
  assert.equal(result.order.waiterUserId, 'waiter-1');
  assert.equal(result.order.tipAmount, 50);
  assert.equal(mealItem.status, 'pending');

  const recipe = await getVenueRecipe('guild-1', 'chef-1', mealItem.id);
  assert.equal(recipe.id, mealItem.id);
  await assert.rejects(
    () => getVenueRecipe('guild-1', 'customer-1', mealItem.id),
    (error) => error instanceof CoinServiceError && error.code === 'VENUE_RECIPE_OWNER_ONLY'
  );

  const completedMeal = await completeVenueOrderItem('guild-1', 'chef-1', mealItem.id, {
    steps: '熱鍋\n下飯\n調味\n盛盤',
    date: new Date('2026-05-20T04:05:00.000Z'),
  });
  await completeVenueOrderItem('guild-1', 'bartender-1', drinkItem.id, {
    steps: '加冰\n倒入飲料\n攪拌\n裝飾',
    date: new Date('2026-05-20T04:06:00.000Z'),
  });
  const served = await serveVenueOrder('guild-1', 'waiter-1', result.order.id, {
    date: new Date('2026-05-20T04:08:00.000Z'),
  });
  const chefTasks = await listWorkTasks('guild-1', { userId: 'chef-1', limit: 10 });
  const waiterChips = await getChipBalance('guild-1', 'waiter-1');
  const customerBalance = await getPlayerBalance('guild-1', 'customer-1');

  assert.equal(completedMeal.item.status, 'completed');
  assert.equal(completedMeal.item.actualSteps, '熱鍋\n下飯\n調味\n盛盤');
  assert.equal(served.order.tipStatus, 'paid');
  assert.equal(waiterChips.balance, 50);
  assert.equal(customerBalance.balance, 50);
  assert.ok(chefTasks.some((task) => task.taskType === 'casino_venue_meal' && task.status === 'completed'));
});

test('casino venue chef bonus is paid through regular payroll after the tenth completed meal', async () => {
  const job = await startJob('guild-1', 'chef-1', '廚師', 1);
  await startJob('guild-1', 'waiter-1', '服務生', 1);
  const meal = (await listVenueMenu('guild-1', { itemType: VenueItemType.MEAL }))[0];
  const baseDate = new Date('2026-05-20T04:00:00.000Z');

  for (let index = 0; index < 11; index += 1) {
    const date = new Date(baseDate.getTime() + index * 1000);
    await adjustPlayerBalance('guild-1', `customer-${index}`, {
      action: 'add',
      amount: 50,
      operatorId: 'admin-1',
      reason: 'tip funds',
    });
    const order = await createVenueOrder('guild-1', `customer-${index}`, {
      mealId: meal.id,
      chefId: 'chef-1',
      waiterId: 'waiter-1',
      tipAmount: 50,
      date,
    });
    await completeVenueOrderItem('guild-1', 'chef-1', order.items[0].id, {
      steps: `備料 ${index}\n加熱\n調味\n出餐`,
      date: new Date(date.getTime() + 500),
    });
  }

  await withCoinTransaction((api) => {
    api.run("UPDATE coin_jobs SET pay_at = ? WHERE id = ?", ['2000-01-01T00:00:00.000Z', job.id]);
  });

  const result = await processDueJobs();
  const payroll = await getPayrollHistory('guild-1', { userId: 'chef-1' });
  const player = await getPlayerBalance('guild-1', 'chef-1');
  const bonusRows = await withCoinTransaction((api) =>
    api.all('SELECT bonus_amount, bonus_paid FROM casino_venue_order_items WHERE guild_id = ? ORDER BY id ASC', [
      'guild-1',
    ])
  );

  assert.equal(result.success, 1);
  assert.equal(payroll[0].baseSalary, 70);
  assert.equal(payroll[0].totalTasks, 11);
  assert.equal(payroll[0].paidAmount, 90);
  assert.match(payroll[0].reason, /場館訂單獎金 1 筆/);
  assert.equal(player.balance, 90);
  assert.equal(bonusRows.filter((row) => Number(row.bonus_amount) === 20).length, 1);
  assert.equal(bonusRows.filter((row) => Number(row.bonus_paid) === 1).length, 1);
});

test('casino venue enforces per-user order rate limit', async () => {
  await startJob('guild-1', 'waiter-1', '服務生', 1);
  await adjustPlayerBalance('guild-1', 'customer-1', {
    action: 'add',
    amount: 600,
    operatorId: 'admin-1',
    reason: 'tip funds',
  });
  const meal = (await listVenueMenu('guild-1', { itemType: VenueItemType.MEAL }))[0];
  const baseDate = new Date('2026-05-20T04:00:00.000Z');

  for (let index = 0; index < 10; index += 1) {
    await createVenueOrder('guild-1', 'customer-1', {
      mealId: meal.id,
      waiterId: 'waiter-1',
      tipAmount: 50,
      date: new Date(baseDate.getTime() + index * 1000),
    });
  }

  await assert.rejects(
    () =>
      createVenueOrder('guild-1', 'customer-1', {
        mealId: meal.id,
        waiterId: 'waiter-1',
        tipAmount: 50,
        date: new Date(baseDate.getTime() + 10 * 1000),
      }),
    (error) => error instanceof CoinServiceError && error.code === 'VENUE_ORDER_RATE_LIMIT'
  );
});

test('luxury shop uses independent inventory and pawn redemption uses historical high price', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 10_000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });
  const luxury = await createLuxuryItem('guild-1', {
    name: '限量名錶',
    description: '奢侈品測試商品',
    price: 1000,
    stock: 3,
    purchaseLimit: 3,
    createdBy: 'admin-1',
  });
  await purchaseLuxuryItem('guild-1', 'user-1', luxury.id, 2);
  const regularInventory = await getInventory('guild-1', 'user-1');
  const luxuryInventory = await getLuxuryInventory('guild-1', 'user-1');

  assert.equal(regularInventory.length, 0);
  assert.equal(luxuryInventory.items.length, 1);
  assert.equal(luxuryInventory.items[0].itemName, '限量名錶');
  assert.equal(luxuryInventory.items[0].quantity, 2);

  const pawned = await pawnLuxuryItem('guild-1', 'user-1', luxury.id, 1);
  await editLuxuryItem('guild-1', luxury.id, {
    price: 1500,
    operatorId: 'admin-1',
  });
  await editLuxuryItem('guild-1', luxury.id, {
    price: 900,
    operatorId: 'admin-1',
  });
  const redeemed = await redeemPawnRecord('guild-1', 'user-1', pawned.record.id, 1);
  const balance = await getPlayerBalance('guild-1', 'user-1');
  const finalLuxuryInventory = await getLuxuryInventory('guild-1', 'user-1');

  assert.equal(pawned.payoutAmount, 800);
  assert.equal(redeemed.redeemUnitPrice, 1500);
  assert.equal(redeemed.totalPrice, 1500);
  assert.equal(balance.balance, 7300);
  assert.equal(finalLuxuryInventory.items[0].quantity, 2);
});

test('casino lodging and duel tower use chips and shop battle items', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 20_000,
    operatorId: 'admin-1',
    reason: 'casino facility funds',
  });
  const booking = await bookLodging('guild-1', 'user-1', {
    roomType: 'deluxe',
    nights: 2,
    date: new Date('2026-05-20T04:00:00.000Z'),
  });

  assert.equal(booking.booking.roomName, '豪華套房');
  assert.equal(booking.booking.chipAmount, 600);
  assert.equal(booking.autoTopUpAmount, 600);

  const weapon = await createShopItem('guild-1', {
    name: '塔台訓練劍',
    description: '決鬥塔台測試武器',
    price: 1000,
    type: ShopItemTypes.BATTLE_ITEM,
    stock: null,
    purchaseLimit: null,
    createdBy: 'admin-1',
  });
  await purchaseItem('guild-1', 'user-1', weapon.id, 1);

  const weapons = await listOwnedBattleWeapons('guild-1', 'user-1');
  const duel = await enterDuelTower('guild-1', 'user-1', {
    weaponItemId: weapon.id,
    wager: 100,
    rng: () => 10,
  });
  const profile = await getDuelTowerProfile('guild-1', 'user-1');

  assert.equal(weapons.length, 1);
  assert.equal(duel.run.weaponName, '塔台訓練劍');
  assert.equal(duel.run.status, 'win');
  assert.equal(duel.run.netAmount, 100);
  assert.equal(profile.wins, 1);
  assert.equal(profile.nextFloor, 2);
});

test('casino venue expired pending items are completed by npc, penalized, and waiter tips refund', async () => {
  await startJob('guild-1', 'chef-1', '廚師', 1);
  await startJob('guild-1', 'waiter-1', '服務生', 1);
  await adjustPlayerBalance('guild-1', 'customer-1', {
    action: 'add',
    amount: 50,
    operatorId: 'admin-1',
    reason: 'tip funds',
  });
  const meal = (await listVenueMenu('guild-1', { itemType: VenueItemType.MEAL }))[0];
  const order = await createVenueOrder('guild-1', 'customer-1', {
    mealId: meal.id,
    chefId: 'chef-1',
    waiterId: 'waiter-1',
    tipAmount: 50,
    date: new Date('2026-05-20T00:00:00.000Z'),
  });

  assert.equal(order.items[0].status, 'pending');

  const expired = await processExpiredVenueOrderItems({
    date: new Date('2026-05-21T01:00:00.000Z'),
  });
  const history = await listVenueHistory('guild-1', { limit: 1 });
  const tasks = await listWorkTasks('guild-1', { userId: 'chef-1', limit: 10 });
  const penalties = await listWorkPenalties('guild-1', { userId: 'chef-1' });
  const customerChips = await getChipBalance('guild-1', 'customer-1');

  assert.equal(expired.completedByNpc, 1);
  assert.equal(expired.waiterRefunded, 1);
  assert.equal(history[0].status, 'completed');
  assert.equal(history[0].makerIsNpc, true);
  assert.ok(tasks.some((task) => task.status === 'system_completed'));
  assert.equal(penalties[0].penaltyAmount, 70);
  assert.equal(customerChips.balance, 50);
});

test('work payroll requires a valid submission and pays the full updated salary', async () => {
  const job = await startJob('guild-1', 'user-1', '會計師', 1);
  await addPendingTask('guild-1', 'user-1', {
    taskType: 'test_task',
    description: '待完成測試任務',
    dueHours: 1,
  });
  await reportWork('guild-1', 'user-1', {
    taskType: 'test_report',
    description: '完成一筆測試工作',
  });
  await withCoinTransaction((api) => {
    api.run("UPDATE coin_jobs SET pay_at = ? WHERE id = ?", ['2000-01-01T00:00:00.000Z', job.id]);
  });

  const result = await processDueJobs();
  const payroll = await getPayrollHistory('guild-1', { userId: 'user-1' });
  const player = await getPlayerBalance('guild-1', 'user-1');
  const tasks = await listWorkTasks('guild-1', { userId: 'user-1', limit: 10 });

  assert.equal(result.success, 1);
  assert.equal(payroll.length, 1);
  assert.equal(payroll[0].baseSalary, 500);
  assert.equal(payroll[0].totalTasks, 1);
  assert.equal(payroll[0].completedTasks, 1);
  assert.equal(payroll[0].paidAmount, 500);
  assert.equal(player.balance, 500);
  assert.ok(tasks.some((task) => task.status === 'paid'));
  assert.ok(tasks.some((task) => task.status === 'expired'));
});

test('work payroll skips payment when no valid submission exists', async () => {
  const job = await startJob('guild-1', 'user-1', '迎賓員', 1);
  await withCoinTransaction((api) => {
    api.run("UPDATE coin_jobs SET pay_at = ? WHERE id = ?", ['2000-01-01T00:00:00.000Z', job.id]);
  });

  const result = await processDueJobs();
  const payroll = await getPayrollHistory('guild-1', { userId: 'user-1' });
  const player = await getPlayerBalance('guild-1', 'user-1');

  assert.equal(result.success, 1);
  assert.equal(payroll[0].totalTasks, 0);
  assert.equal(payroll[0].payRatio, 0);
  assert.equal(payroll[0].paidAmount, 0);
  assert.equal(player.balance, 0);
});

test('work payroll pays 75 percent basic salary when no work is available', async () => {
  const job = await startJob('guild-1', 'user-1', '迎賓員', 1);
  const report = await reportWork('guild-1', 'user-1', {
    noWorkAvailable: true,
    channelName: '迎賓員',
  });
  await withCoinTransaction((api) => {
    api.run("UPDATE coin_jobs SET pay_at = ? WHERE id = ?", ['2000-01-01T00:00:00.000Z', job.id]);
  });

  const result = await processDueJobs();
  const payroll = await getPayrollHistory('guild-1', { userId: 'user-1' });
  const player = await getPlayerBalance('guild-1', 'user-1');
  const tasks = await listWorkTasks('guild-1', { userId: 'user-1', limit: 10 });
  const paidTask = tasks.find((task) => task.id === report.task.id);

  assert.equal(result.success, 1);
  assert.equal(payroll[0].baseSalary, 50);
  assert.equal(payroll[0].payRatio, 0.75);
  assert.equal(payroll[0].paidAmount, 38);
  assert.match(payroll[0].reason, /75% 基本薪資/);
  assert.equal(player.balance, 38);
  assert.equal(paidTask.status, 'paid');
});

test('expired assigned work is system-completed, penalized once per day, and appeal can refund', async () => {
  const job = await startJob('guild-1', 'user-1', '老師', 1);
  await addPendingTask('guild-1', 'user-1', {
    taskType: 'lesson-plan',
    description: '準備課程',
    dueHours: 1,
  });
  await addPendingTask('guild-1', 'user-1', {
    taskType: 'lesson-review',
    description: '整理課後重點',
    dueHours: 1,
  });

  const expired = await processExpiredWorkTasks(null, {
    date: new Date(Date.now() + 25 * 60 * 60 * 1000),
  });
  const penalties = await listWorkPenalties('guild-1', { userId: 'user-1' });
  const tasks = await listWorkTasks('guild-1', { userId: 'user-1', limit: 10 });

  assert.equal(expired.completedBySystem, 2);
  assert.equal(penalties.length, 1);
  assert.equal(penalties[0].penaltyAmount, 400);
  assert.equal(tasks.filter((task) => task.status === 'system_completed').length, 2);

  await withCoinTransaction((api) => {
    api.run("UPDATE coin_jobs SET pay_at = ? WHERE id = ?", ['2000-01-01T00:00:00.000Z', job.id]);
  });
  await reportWork('guild-1', 'user-1', {
    taskType: 'lesson',
    description: '仍有完成一筆有效工作',
    channelName: '老師',
  });
  await processDueJobs();
  const payroll = await getPayrollHistory('guild-1', { userId: 'user-1' });
  const afterPenalty = await getPlayerBalance('guild-1', 'user-1');

  assert.equal(payroll[0].paidAmount, 0);
  assert.match(payroll[0].reason, /逾期扣薪 1 筆/);
  assert.equal(afterPenalty.balance, 0);

  const appeal = await createWorkPenaltyAppeal('guild-1', 'user-1', penalties[0].id, {
    reason: '當日已補交證明，請審核。',
  });
  const reviewed = await reviewWorkPenaltyAppeal('guild-1', 'owner-1', appeal.appeal.id, {
    action: 'approved',
    reason: '申訴通過',
  });
  const afterRefund = await getPlayerBalance('guild-1', 'user-1');

  assert.equal(reviewed.appeal.status, 'approved');
  assert.equal(reviewed.refund.amount, 400);
  assert.equal(afterRefund.balance, 400);
});

test('translator payroll adds external server bonus and de-duplicates server ids per Taiwan date', async () => {
  const job = await startJob('guild-1', 'user-1', '翻譯官', 1);
  await reportWork('guild-1', 'user-1', {
    taskType: 'translation',
    description: '完成外交翻譯與宣傳',
    externalServerIds: 'server-a, server-b, server-a',
  });
  await withCoinTransaction((api) => {
    api.run("UPDATE coin_jobs SET pay_at = ? WHERE id = ?", ['2000-01-01T00:00:00.000Z', job.id]);
  });

  await processDueJobs();
  const payroll = await getPayrollHistory('guild-1', { userId: 'user-1' });
  const player = await getPlayerBalance('guild-1', 'user-1');

  assert.equal(payroll[0].baseSalary, 300);
  assert.equal(payroll[0].paidAmount, 700);
  assert.match(payroll[0].reason, /外部伺服器任務 2 個/);
  assert.equal(player.balance, 700);
});

test('work submissions can be edited, reviewed back to pending, and soft-deleted', async () => {
  await startJob('guild-1', 'user-1', '老師', 1);
  const submitted = await reportWork('guild-1', 'user-1', {
    taskType: 'teaching',
    description: '三個知識點初稿',
    channelName: '老師',
  });
  const approved = await reviewWorkSubmission('guild-1', 'admin-1', submitted.task.id, {
    action: 'approved',
    reason: '內容完整',
  });
  const edited = await editWorkSubmission('guild-1', 'user-1', submitted.task.id, {
    description: '修正後的三個知識點',
  });
  const deleted = await deleteWorkSubmission('guild-1', 'user-1', submitted.task.id);

  assert.equal(submitted.task.status, 'pending');
  assert.equal(approved.status, 'approved');
  assert.equal(edited.status, 'pending');
  assert.equal(edited.description, '修正後的三個知識點');
  assert.equal(deleted.status, 'deleted');
  assert.ok(deleted.deletedAt);
});

test('users cannot edit or delete other users submissions', async () => {
  await startJob('guild-1', 'user-1', '清潔工', 1);
  const submitted = await reportWork('guild-1', 'user-1', {
    description: '回報錯頻整理',
    channelName: '清潔工',
  });

  await assert.rejects(
    () =>
      editWorkSubmission('guild-1', 'user-2', submitted.task.id, {
        description: '不是本人的修改',
      }),
    (error) => error instanceof CoinServiceError && error.code === 'NOT_OWN_SUBMISSION'
  );
  await assert.rejects(
    () => deleteWorkSubmission('guild-1', 'user-2', submitted.task.id),
    (error) => error instanceof CoinServiceError && error.code === 'NOT_OWN_SUBMISSION'
  );
});

test('deleted submissions are excluded from payroll and paid submissions are locked', async () => {
  const job = await startJob('guild-1', 'user-1', '小幫手', 1);
  const deleted = await reportWork('guild-1', 'user-1', {
    description: '錯誤提交',
    channelName: '小幫手',
  });
  await deleteWorkSubmission('guild-1', 'user-1', deleted.task.id);
  const valid = await reportWork('guild-1', 'user-1', {
    description: '完成三件以內雜務',
    channelName: '小幫手',
  });
  await withCoinTransaction((api) => {
    api.run("UPDATE coin_jobs SET pay_at = ? WHERE id = ?", ['2000-01-01T00:00:00.000Z', job.id]);
  });

  await processDueJobs();
  const payroll = await getPayrollHistory('guild-1', { userId: 'user-1' });
  const tasks = await listWorkTasks('guild-1', { userId: 'user-1', limit: 10 });
  const paidTask = tasks.find((task) => task.id === valid.task.id);

  assert.equal(payroll[0].totalTasks, 1);
  assert.equal(payroll[0].paidAmount, 200);
  assert.equal(paidTask.status, 'paid');

  await assert.rejects(
    () => editWorkSubmission('guild-1', 'user-1', valid.task.id, { description: '發薪後修改' }),
    (error) => error instanceof CoinServiceError && error.code === 'SUBMISSION_ALREADY_PAID'
  );
  await assert.rejects(
    () => deleteWorkSubmission('guild-1', 'user-1', valid.task.id),
    (error) => error instanceof CoinServiceError && error.code === 'SUBMISSION_ALREADY_PAID'
  );
});
