const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

const ownsDatabasePath = !process.env.COIN_DB_PATH;
const directory = ownsDatabasePath ? fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-games-')) : null;
const dbPath = process.env.COIN_DB_PATH || path.join(directory, 'games.sqlite');
if (ownsDatabasePath) process.env.COIN_DB_PATH = dbPath;
const secret = 'synthetic-game-session-secret-32-bytes-minimum';

const { initializeCoinDatabase, resetCoinDatabaseForTests, withCoinDatabase, withCoinTransaction } = require('../src/services/coinDatabase');
const {
  DIFFICULTIES,
  applyNumberMatchAction,
  applySudokuAction,
  buildSudoku,
  clearFullRows,
  countSudokuSolutions,
  createGameSession,
  exchangeLaunchToken,
  scoreTetrisLock,
  submitGameAction,
} = require('../src/services/gameService');
const { buildGameUrl, parseWebsitePublicUrl } = require('../src/commands/games');

test.beforeEach(() => { resetCoinDatabaseForTests(); fs.rmSync(dbPath, { force: true }); });
test.after(() => {
  resetCoinDatabaseForTests();
  if (ownsDatabasePath) fs.rmSync(directory, { recursive: true, force: true });
});

test('tetris clears only full rows and applies rounded streak scoring with reset', () => {
  const board = Array.from({ length: 20 }, () => Array(10).fill(0));
  board[18].fill(1); board[19].fill(1); board[17][0] = 1;
  const result = clearFullRows(board);
  assert.equal(result.cleared, 2);
  assert.equal(result.board.length, 20);
  assert.equal(result.board[19][0], 1);
  assert.deepEqual(scoreTetrisLock(0, 1), { points: 20, streak: 1 });
  assert.deepEqual(scoreTetrisLock(1, 2), { points: 67, streak: 3 });
  assert.deepEqual(scoreTetrisLock(8, 0), { points: 0, streak: 0 });
});

test('number match requires orthogonal eligible pairs, compacts row-major, and detects no moves', () => {
  const state = { board: [1, 9, 2, 8, 5, 5], rows: 2, columns: 3, completed: false, noMoves: false };
  assert.throws(() => applyNumberMatchAction(state, { type: 'pair', first: 0, second: 4 }), /adjacent pair/);
  const next = applyNumberMatchAction(state, { type: 'pair', first: 0, second: 1 });
  assert.deepEqual(next.board, [2, 8, 5, 5, null, null]);
  const stuck = applyNumberMatchAction({ board: [1, 9, 2, 2], rows: 2, columns: 2, completed: false, noMoves: false }, { type: 'pair', first: 0, second: 1 });
  assert.equal(stuck.noMoves, false);
  const ended = applyNumberMatchAction({ board: [1, 9, 2, 3], rows: 2, columns: 2, completed: false, noMoves: false }, { type: 'pair', first: 0, second: 1 });
  assert.equal(ended.noMoves, true);
});

test('sudoku variants have one solution and given cells are immutable', () => {
  for (const difficulty of DIFFICULTIES) {
    const state = buildSudoku(`seed-${difficulty}`, difficulty);
    assert.equal(countSudokuSolutions(state.puzzle), 1);
    const givenColumn = state.puzzle[0].findIndex(Boolean);
    assert.throws(() => applySudokuAction(state, { type: 'set', row: 0, column: givenColumn, value: 1 }), /cannot change/);
  }
});

test('launch token is single-use, expires, and action replay rejects tampering', async () => {
  await initializeCoinDatabase();
  const now = new Date('2026-09-03T00:00:00.000Z');
  const created = await createGameSession({ userId: 'user-a', guildId: 'guild-a', channelId: 'channel-a', gameType: 'tetris', difficulty: 'easy', secret, now });
  const exchanged = await exchangeLaunchToken(created.launchToken, { secret, now });
  assert.ok(exchanged.accessToken);
  await assert.rejects(() => exchangeLaunchToken(created.launchToken, { secret, now }), /already used/);
  const first = await submitGameAction({ sessionId: exchanged.sessionId, accessToken: exchanged.accessToken, expectedIndex: 0, action: { type: 'lock', column: 0, rotation: 0 }, secret, now });
  const replay = await submitGameAction({ sessionId: exchanged.sessionId, accessToken: exchanged.accessToken, expectedIndex: 0, action: { type: 'lock', column: 0, rotation: 0 }, secret, now });
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
  await assert.rejects(() => submitGameAction({ sessionId: exchanged.sessionId, accessToken: exchanged.accessToken, expectedIndex: 0, action: { type: 'lock', column: 1, rotation: 0 }, secret, now }), /does not match/);

  const expiring = await createGameSession({ userId: 'user-b', guildId: 'guild-a', channelId: 'channel-a', gameType: 'sudoku', difficulty: 'hard', secret, now });
  await assert.rejects(() => exchangeLaunchToken(expiring.launchToken, { secret, now: new Date(now.getTime() + 31 * 60 * 1000) }), /expired/);
});

test('number match full clear grants only the server difficulty reward once', async () => {
  await initializeCoinDatabase();
  await withCoinTransaction((api) => api.run("INSERT INTO coin_guild_settings (guild_id, enabled, created_at, updated_at) VALUES ('guild-reward', 1, '2026-01-01', '2026-01-01')"));
  const created = await createGameSession({ userId: 'reward-user', guildId: 'guild-reward', channelId: 'channel', gameType: 'number-match', difficulty: 'easy', secret });
  const session = await exchangeLaunchToken(created.launchToken, { secret });
  await submitGameAction({ sessionId: session.sessionId, accessToken: session.accessToken, expectedIndex: 0, action: { type: 'pair', first: 0, second: 1 }, secret });
  const completed = await submitGameAction({ sessionId: session.sessionId, accessToken: session.accessToken, expectedIndex: 1, action: { type: 'pair', first: 0, second: 1 }, secret });
  assert.equal(completed.reward, 20); assert.equal(completed.rewardGranted, true);
  const replay = await submitGameAction({ sessionId: session.sessionId, accessToken: session.accessToken, expectedIndex: 1, action: { type: 'pair', first: 0, second: 1 }, secret });
  assert.equal(replay.replayed, true);
  const counts = await withCoinDatabase((api) => ({ grants: api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE source_type = 'game'").count, amount: api.get("SELECT amount FROM reward_grants WHERE source_type = 'game'").amount }));
  assert.deepEqual(counts, { grants: 1, amount: 20 });
});

test('completed game does not pay or remain pending when guild coins are disabled', async () => {
  await initializeCoinDatabase();
  await withCoinTransaction((api) => api.run(
    "INSERT INTO coin_guild_settings (guild_id, enabled, created_at, updated_at) VALUES ('no-coin-guild', 0, '2026-01-01', '2026-01-01')"
  ));
  const created = await createGameSession({ userId: 'no-coin-user', guildId: 'no-coin-guild', channelId: 'channel', gameType: 'number-match', difficulty: 'easy', secret });
  const session = await exchangeLaunchToken(created.launchToken, { secret });
  await submitGameAction({ sessionId: session.sessionId, accessToken: session.accessToken, expectedIndex: 0, action: { type: 'pair', first: 0, second: 1 }, secret });
  const completed = await submitGameAction({ sessionId: session.sessionId, accessToken: session.accessToken, expectedIndex: 1, action: { type: 'pair', first: 0, second: 1 }, secret });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.reward, 20);
  assert.equal(completed.rewardGranted, false);
  const result = await withCoinDatabase((api) => ({
    grants: Number(api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE source_type = 'game'").count),
    rewardStatus: api.get('SELECT status FROM game_rewards WHERE session_id = ?', [session.sessionId]).status,
  }));
  assert.deepEqual(result, { grants: 0, rewardStatus: 'no_reward' });
});

test('schema v17 migrates to v18 idempotently and incompatible bytes remain untouched', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (name) => path.join(distPath, name) });
  await initializeCoinDatabase(); resetCoinDatabaseForTests();
  const prior = new SQL.Database(fs.readFileSync(dbPath));
  prior.exec("DROP TABLE game_rewards; DROP TABLE game_actions; DROP TABLE game_sessions; CREATE TABLE game_sentinel (value TEXT); INSERT INTO game_sentinel VALUES ('keep'); UPDATE coin_metadata SET value='17' WHERE key='schema_version'");
  fs.writeFileSync(dbPath, Buffer.from(prior.export())); prior.close();
  const info = await initializeCoinDatabase(); assert.equal(info.schemaVersion, 18);
  assert.equal(await withCoinDatabase((api) => api.get('SELECT value FROM game_sentinel').value), 'keep');
  resetCoinDatabaseForTests(); await initializeCoinDatabase();
  assert.equal(await withCoinDatabase((api) => api.get("SELECT value FROM coin_metadata WHERE key='schema_version'").value), '18');

  resetCoinDatabaseForTests(); fs.rmSync(dbPath, { force: true });
  const bad = new SQL.Database(); bad.exec("CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO coin_metadata VALUES ('schema_version','17','x'); CREATE TABLE game_sessions (id TEXT PRIMARY KEY)");
  const bytes = Buffer.from(bad.export()); fs.writeFileSync(dbPath, bytes); bad.close();
  await assert.rejects(() => initializeCoinDatabase(), /v18 結構驗證失敗/);
  assert.deepEqual(fs.readFileSync(dbPath), bytes);
});

test('game URL keeps the opaque launch token only in fragment and exposes no Discord IDs', () => {
  const url = buildGameUrl('https://xiaoji.example/', { game: 'sudoku', difficulty: 'hard', launchToken: 'opaque-token' });
  assert.match(url, /^https:\/\/xiaoji\.example\/games\/sudoku\?difficulty=hard#token=opaque-token$/);
  assert.doesNotMatch(url, /user|guild|channel/i);
  assert.equal(parseWebsitePublicUrl('http://127.0.0.1:4173').origin, 'http://127.0.0.1:4173');
  assert.throws(() => parseWebsitePublicUrl('http://public.example'), /HTTPS/);
});
