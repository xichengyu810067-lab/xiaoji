const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const logger = require('../utils/logger');

const rootPath = path.resolve(__dirname, '..', '..');
const defaultRelativeDbPath = path.join('data', 'xiaoji.sqlite');
const schemaVersion = 2;

const schemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS coin_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_guild_settings (
  guild_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  daily_base_reward INTEGER NOT NULL DEFAULT 50,
  streak_three_bonus INTEGER NOT NULL DEFAULT 20,
  streak_seven_bonus INTEGER NOT NULL DEFAULT 100,
  allow_transfer INTEGER NOT NULL DEFAULT 0,
  shop_enabled INTEGER NOT NULL DEFAULT 1,
  admin_log_channel_id TEXT,
  announcement_channel_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_players (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  bank_balance INTEGER NOT NULL DEFAULT 0,
  bank_interest_accrued REAL NOT NULL DEFAULT 0,
  last_interest_date TEXT,
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  last_daily_date TEXT,
  daily_streak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS coin_daily_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  checkin_date TEXT NOT NULL,
  earned_amount INTEGER NOT NULL,
  bonus_amount INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (guild_id, user_id, checkin_date)
);

CREATE TABLE IF NOT EXISTS coin_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  balance_before INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  operator_id TEXT,
  reason TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'collectible',
  role_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  stock INTEGER,
  purchase_limit INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  last_used_at TEXT,
  is_used INTEGER NOT NULL DEFAULT 0,
  is_expired INTEGER NOT NULL DEFAULT 0,
  UNIQUE (guild_id, user_id, item_id)
);

CREATE TABLE IF NOT EXISTS coin_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  target_user_id TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  daily_salary INTEGER NOT NULL,
  work_days INTEGER NOT NULL,
  total_salary INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_paid INTEGER NOT NULL DEFAULT 0,
  start_at TEXT NOT NULL,
  pay_at TEXT NOT NULL,
  actual_paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coin_players_guild_balance
  ON coin_players (guild_id, balance DESC, total_earned DESC);

CREATE INDEX IF NOT EXISTS idx_coin_transactions_user
  ON coin_transactions (guild_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_coin_shop_items_guild
  ON coin_shop_items (guild_id, enabled, deleted, id);

CREATE INDEX IF NOT EXISTS idx_coin_inventory_user
  ON coin_inventory (guild_id, user_id, acquired_at DESC);

CREATE INDEX IF NOT EXISTS idx_coin_admin_logs_guild
  ON coin_admin_logs (guild_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_coin_jobs_pay_at
  ON coin_jobs (pay_at, status, is_paid);

CREATE INDEX IF NOT EXISTS idx_coin_jobs_user
  ON coin_jobs (guild_id, user_id, status);
`;

let sqlModulePromise = null;
let initializationPromise = null;
let state = null;
let operationQueue = Promise.resolve();

class CoinDatabaseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'CoinDatabaseError';
    this.cause = cause;
  }
}

function getCoinDatabasePath() {
  const configuredPath = String(process.env.COIN_DB_PATH || '').trim();
  const databasePath = configuredPath || defaultRelativeDbPath;

  if (path.isAbsolute(databasePath)) {
    return path.normalize(databasePath);
  }

  return path.resolve(rootPath, databasePath);
}

async function getSqlModule() {
  if (!sqlModulePromise) {
    const distPath = path.dirname(require.resolve('sql.js'));
    sqlModulePromise = initSqlJs({
      locateFile: (fileName) => path.join(distPath, fileName),
    });
  }

  return sqlModulePromise;
}

function getRows(db, sql, params = []) {
  const statement = db.prepare(sql);
  const rows = [];

  try {
    statement.bind(params);

    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }

  return rows;
}

function getRow(db, sql, params = []) {
  return getRows(db, sql, params)[0] || null;
}

function runSql(db, sql, params = []) {
  if (params.length === 0) {
    db.run(sql);
    return;
  }

  db.run(sql, params);
}

function getTableNames(db) {
  return new Set(
    getRows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).map((row) => row.name)
  );
}

function writeDatabaseFile(dbPath, db) {
  const directory = path.dirname(dbPath);
  const tempPath = `${dbPath}.tmp`;
  const exported = Buffer.from(db.export());

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(tempPath, exported);
  fs.renameSync(tempPath, dbPath);
}

function verifyIntegrity(db) {
  const result = getRow(db, 'PRAGMA integrity_check');
  const value = result?.integrity_check;

  if (value !== 'ok') {
    throw new Error(`SQLite integrity check failed: ${value || 'unknown result'}`);
  }
}

function buildApi(db) {
  return {
    db,
    all: (sql, params) => getRows(db, sql, params),
    get: (sql, params) => getRow(db, sql, params),
    run: (sql, params) => runSql(db, sql, params),
  };
}

async function createOrOpenDatabase() {
  const SQL = await getSqlModule();
  const dbPath = getCoinDatabasePath();
  const existed = fs.existsSync(dbPath);
  let db;

  try {
    if (existed) {
      db = new SQL.Database(fs.readFileSync(dbPath));
    } else {
      db = new SQL.Database();
    }
  } catch (error) {
    logger.error(`吉幣資料庫讀取失敗，已停止載入：${dbPath}`, error);
    throw new CoinDatabaseError('吉幣資料庫讀取失敗，不會自動重建空資料庫。', error);
  }

  runSql(db, 'PRAGMA foreign_keys = ON');
  verifyIntegrity(db);

  const beforeTables = getTableNames(db);
  db.exec(schemaSql);

  // Simple migration for version 2 (Bank System)
  const currentVersionRow = getRow(db, "SELECT value FROM coin_metadata WHERE key = 'schema_version'");
  const currentVersion = currentVersionRow ? Number(currentVersionRow.value) : 0;

  if (currentVersion < 2) {
    logger.info('正在執行資料庫遷移至版本 2 (銀行系統)...');
    try {
      // SQLite doesn't support multiple columns in one ALTER TABLE, and might fail if columns already exist.
      // We check if the column exists by trying to select it or using pragma table_info.
      const columns = getRows(db, "PRAGMA table_info(coin_players)").map(c => c.name);
      
      if (!columns.includes('bank_balance')) {
        runSql(db, "ALTER TABLE coin_players ADD COLUMN bank_balance INTEGER NOT NULL DEFAULT 0");
      }
      if (!columns.includes('bank_interest_accrued')) {
        runSql(db, "ALTER TABLE coin_players ADD COLUMN bank_interest_accrued REAL NOT NULL DEFAULT 0");
      }
      if (!columns.includes('last_interest_date')) {
        runSql(db, "ALTER TABLE coin_players ADD COLUMN last_interest_date TEXT");
      }
      logger.info('資料庫遷移至版本 2 完成。');
    } catch (error) {
      logger.error('資料庫遷移至版本 2 失敗。', error);
      // We continue because maybe the user manually added them or something else happened.
    }
  }

  const afterTables = getTableNames(db);
  const createdTables = [...afterTables].filter((name) => !beforeTables.has(name));
  const now = new Date().toISOString();

  runSql(
    db,
    `INSERT INTO coin_metadata (key, value, updated_at)
     VALUES ('schema_version', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [String(schemaVersion), now]
  );

  writeDatabaseFile(dbPath, db);

  const info = {
    path: dbPath,
    existed,
    createdDatabase: !existed,
    createdTables,
    schemaVersion,
    initializedAt: now,
  };

  state = {
    db,
    info,
    lastSavedAt: now,
  };

  logger.info(`吉幣資料庫路徑：${dbPath}`);
  logger.info(`吉幣資料庫已存在：${existed ? '是' : '否'}`);
  logger.info(`吉幣資料庫新建：${!existed ? '是' : '否'}`);
  logger.info(`吉幣資料表建立：${createdTables.length ? createdTables.join(', ') : '沒有缺少的資料表'}`);
  logger.info('吉幣系統資料庫載入成功。');

  return info;
}

async function initializeCoinDatabase() {
  if (state) {
    return state.info;
  }

  if (!initializationPromise) {
    initializationPromise = createOrOpenDatabase().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  return initializationPromise;
}

async function withCoinDatabase(work, { persist = false } = {}) {
  const runOperation = async () => {
    await initializeCoinDatabase();

    try {
      const result = await work(buildApi(state.db));

      if (persist) {
        writeDatabaseFile(state.info.path, state.db);
        state.lastSavedAt = new Date().toISOString();
      }

      return result;
    } catch (error) {
      throw error;
    }
  };

  const queuedOperation = operationQueue.then(runOperation, runOperation);
  operationQueue = queuedOperation.catch(() => {});
  return queuedOperation;
}

async function withCoinTransaction(work) {
  return withCoinDatabase(
    async (api) => {
      let transactionStarted = false;

      try {
        api.run('BEGIN IMMEDIATE');
        transactionStarted = true;
        const result = await work(api);
        api.run('COMMIT');
        transactionStarted = false;
        return result;
      } catch (error) {
        if (transactionStarted) {
          try {
            api.run('ROLLBACK');
          } catch (rollbackError) {
            logger.error('吉幣資料庫交易 rollback 失敗。', rollbackError);
          }
        }

        throw error;
      }
    },
    { persist: true }
  );
}

async function getCoinDatabaseInfo() {
  await initializeCoinDatabase();

  return {
    ...state.info,
    lastSavedAt: state.lastSavedAt,
    exists: fs.existsSync(state.info.path),
  };
}

function resetCoinDatabaseForTests() {
  if (state?.db) {
    state.db.close();
  }

  state = null;
  initializationPromise = null;
  operationQueue = Promise.resolve();
}

module.exports = {
  CoinDatabaseError,
  getCoinDatabaseInfo,
  getCoinDatabasePath,
  initializeCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
};
