const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const logger = require('../utils/logger');

const rootPath = path.resolve(__dirname, '..', '..');
const defaultRelativeDbPath = path.join('data', 'xiaoji.sqlite');
const schemaVersion = 10;

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
  item_type TEXT NOT NULL DEFAULT 'collectible',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_bank_rates (
  guild_id TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  rate REAL NOT NULL,
  previous_rate REAL,
  is_event INTEGER NOT NULL DEFAULT 0,
  event_ends_at TEXT,
  updated_by TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, rate_key)
);

CREATE TABLE IF NOT EXISTS coin_rate_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  rate_type TEXT NOT NULL,
  term_days INTEGER,
  old_rate REAL NOT NULL,
  new_rate REAL NOT NULL,
  reason TEXT,
  is_event INTEGER NOT NULL DEFAULT 0,
  event_ends_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_fixed_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  principal INTEGER NOT NULL,
  term_days INTEGER NOT NULL,
  rate REAL NOT NULL,
  expected_interest INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'wallet',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  maturity_at TEXT NOT NULL,
  claimed_at TEXT,
  cancelled_at TEXT
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
  job_role_id TEXT,
  daily_salary INTEGER NOT NULL,
  work_days INTEGER NOT NULL,
  total_salary INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_paid INTEGER NOT NULL DEFAULT 0,
  start_at TEXT NOT NULL,
  pay_at TEXT NOT NULL,
  actual_paid_at TEXT,
  last_contribution_at TEXT,
  last_reminder_at TEXT,
  today_task_count INTEGER NOT NULL DEFAULT 0,
  today_completed_task_count INTEGER NOT NULL DEFAULT 0,
  no_work_available_today INTEGER NOT NULL DEFAULT 0,
  payroll_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_work_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  job_id INTEGER,
  job_name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  description TEXT,
  attachment_urls TEXT,
  expected_channel_id TEXT,
  expected_channel_name TEXT,
  message_id TEXT,
  external_server_count INTEGER NOT NULL DEFAULT 0,
  external_server_ids TEXT,
  reviewed_by TEXT,
  review_reason TEXT,
  is_paid INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT,
  deleted_at TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  last_reminder_at TEXT
);

CREATE TABLE IF NOT EXISTS coin_payroll_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  job_name TEXT NOT NULL,
  base_salary INTEGER NOT NULL,
  total_tasks INTEGER NOT NULL,
  completed_tasks INTEGER NOT NULL,
  pay_ratio REAL NOT NULL,
  paid_amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_work_penalties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  job_name TEXT NOT NULL,
  task_id INTEGER,
  source_type TEXT NOT NULL,
  source_id INTEGER,
  source_channel_id TEXT,
  penalty_date TEXT NOT NULL,
  daily_salary INTEGER NOT NULL DEFAULT 0,
  penalty_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  reason TEXT NOT NULL,
  announced_at TEXT,
  announcement_channel_id TEXT,
  announcement_message_id TEXT,
  appeal_deadline_at TEXT NOT NULL,
  applied_at TEXT,
  refunded_at TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  resolution_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_work_penalty_appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  penalty_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  game_type TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'chip',
  bet_amount INTEGER NOT NULL,
  payout_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'settled',
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_blackjack_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  currency TEXT NOT NULL DEFAULT 'chip',
  bet_amount INTEGER NOT NULL,
  deck_json TEXT NOT NULL,
  player_hand_json TEXT NOT NULL,
  dealer_hand_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  payout_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS casino_loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  principal_amount INTEGER NOT NULL DEFAULT 0,
  current_debt_amount INTEGER NOT NULL DEFAULT 0,
  interest_rate REAL NOT NULL DEFAULT 0.03,
  relief_count INTEGER NOT NULL DEFAULT 0,
  relief_updated_by TEXT,
  relief_updated_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_interest_date TEXT NOT NULL,
  repaid_at TEXT
);

CREATE TABLE IF NOT EXISTS casino_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'chip',
  amount INTEGER NOT NULL,
  balance_before INTEGER,
  balance_after INTEGER,
  debt_before INTEGER,
  debt_after INTEGER,
  game_id INTEGER,
  loan_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_venue_menu (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  name TEXT NOT NULL,
  steps TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_by TEXT,
  deleted_at TEXT,
  delete_reason TEXT
);

CREATE TABLE IF NOT EXISTS casino_venue_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  channel_id TEXT,
  waiter_user_id TEXT,
  waiter_job_id INTEGER,
  waiter_job_name TEXT,
  waiter_assigned_at TEXT,
  waiter_due_at TEXT,
  tip_amount INTEGER NOT NULL DEFAULT 0,
  tip_status TEXT NOT NULL DEFAULT 'none',
  tip_paid_at TEXT,
  tip_refunded_at TEXT,
  served_at TEXT,
  served_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_venue_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  menu_item_id INTEGER,
  item_name TEXT NOT NULL,
  standard_steps TEXT NOT NULL,
  maker_user_id TEXT,
  maker_job_id INTEGER,
  maker_job_name TEXT,
  maker_is_npc INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  actual_steps TEXT,
  service_date TEXT,
  bonus_amount INTEGER NOT NULL DEFAULT 0,
  bonus_paid INTEGER NOT NULL DEFAULT 0,
  completion_message_id TEXT,
  created_at TEXT NOT NULL,
  assigned_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT
);

CREATE TABLE IF NOT EXISTS chip_accounts (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS chip_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_before INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  coin_amount INTEGER NOT NULL DEFAULT 0,
  fee INTEGER NOT NULL DEFAULT 0,
  operator_id TEXT,
  reason TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS luxury_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  stock INTEGER,
  purchase_limit INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS luxury_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  price INTEGER NOT NULL,
  changed_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS luxury_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guild_id, user_id, item_id)
);

CREATE TABLE IF NOT EXISTS luxury_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS luxury_pawn_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  remaining_quantity INTEGER NOT NULL,
  pawn_unit_price INTEGER NOT NULL,
  payout_amount INTEGER NOT NULL,
  redeemed_quantity INTEGER NOT NULL DEFAULT 0,
  redeemed_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  redeemed_at TEXT
);

CREATE TABLE IF NOT EXISTS luxury_pawn_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  pawn_record_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  redeem_unit_price INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_lodging_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  room_type TEXT NOT NULL,
  room_name TEXT NOT NULL,
  nights INTEGER NOT NULL,
  chip_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  check_in_at TEXT NOT NULL,
  check_out_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_duel_tower_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  weapon_item_id INTEGER NOT NULL,
  weapon_name TEXT NOT NULL,
  wager_amount INTEGER NOT NULL,
  floor INTEGER NOT NULL,
  opponent_name TEXT NOT NULL,
  player_power INTEGER NOT NULL,
  opponent_power INTEGER NOT NULL,
  status TEXT NOT NULL,
  payout_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at TEXT NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_coin_fixed_deposits_user
  ON coin_fixed_deposits (guild_id, user_id, status, maturity_at);

CREATE INDEX IF NOT EXISTS idx_coin_rate_history_guild
  ON coin_rate_history (guild_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_coin_work_tasks_user
  ON coin_work_tasks (guild_id, user_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_coin_payroll_history_guild
  ON coin_payroll_history (guild_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_coin_work_penalties_user
  ON coin_work_penalties (guild_id, user_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_coin_work_penalties_daily
  ON coin_work_penalties (guild_id, user_id, job_id, penalty_date, status);

CREATE INDEX IF NOT EXISTS idx_coin_work_penalty_appeals_penalty
  ON coin_work_penalty_appeals (guild_id, penalty_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_casino_games_user
  ON casino_games (guild_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_blackjack_sessions_user
  ON casino_blackjack_sessions (guild_id, user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_casino_loans_user
  ON casino_loans (guild_id, user_id, status);

CREATE INDEX IF NOT EXISTS idx_casino_ledger_user
  ON casino_ledger (guild_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_venue_menu_guild
  ON casino_venue_menu (guild_id, item_type, deleted, id);

CREATE INDEX IF NOT EXISTS idx_casino_venue_orders_customer
  ON casino_venue_orders (guild_id, customer_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_venue_order_items_status
  ON casino_venue_order_items (guild_id, status, completed_at, id);

CREATE INDEX IF NOT EXISTS idx_casino_venue_order_items_maker
  ON casino_venue_order_items (guild_id, maker_user_id, item_type, service_date, id);

CREATE INDEX IF NOT EXISTS idx_chip_ledger_user
  ON chip_ledger (guild_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_luxury_items_guild
  ON luxury_items (guild_id, enabled, deleted, id);

CREATE INDEX IF NOT EXISTS idx_luxury_inventory_user
  ON luxury_inventory (guild_id, user_id, item_id);

CREATE INDEX IF NOT EXISTS idx_luxury_price_history_item
  ON luxury_price_history (guild_id, item_id, price DESC);

CREATE INDEX IF NOT EXISTS idx_luxury_pawn_records_user
  ON luxury_pawn_records (guild_id, user_id, status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_lodging_bookings_user
  ON casino_lodging_bookings (guild_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_casino_duel_tower_runs_user
  ON casino_duel_tower_runs (guild_id, user_id, created_at DESC, id DESC);
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

function getColumnNames(db, tableName) {
  return getRows(db, `PRAGMA table_info(${tableName})`).map((column) => column.name);
}

function addColumnIfMissing(db, tableName, columnName, columnDefinition) {
  const columns = getColumnNames(db, tableName);

  if (!columns.includes(columnName)) {
    runSql(db, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
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

  if (currentVersion < 3) {
    logger.info('Migrating coin database schema to version 3 (fixed deposits, rates, work tasks).');
    try {
      addColumnIfMissing(db, 'coin_purchases', 'item_type', "TEXT NOT NULL DEFAULT 'collectible'");
      addColumnIfMissing(db, 'coin_purchases', 'status', "TEXT NOT NULL DEFAULT 'active'");
      addColumnIfMissing(db, 'coin_purchases', 'expires_at', 'TEXT');

      addColumnIfMissing(db, 'coin_jobs', 'job_role_id', 'TEXT');
      addColumnIfMissing(db, 'coin_jobs', 'last_contribution_at', 'TEXT');
      addColumnIfMissing(db, 'coin_jobs', 'last_reminder_at', 'TEXT');
      addColumnIfMissing(db, 'coin_jobs', 'today_task_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_jobs', 'today_completed_task_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_jobs', 'no_work_available_today', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_jobs', 'payroll_status', "TEXT NOT NULL DEFAULT 'pending'");
    } catch (error) {
      logger.error('Coin database schema v3 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 4) {
    logger.info('Migrating coin database schema to version 4 (editable work submissions and payroll safety).');
    try {
      addColumnIfMissing(db, 'coin_work_tasks', 'attachment_urls', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'expected_channel_id', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'expected_channel_name', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'message_id', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'external_server_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_work_tasks', 'external_server_ids', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'reviewed_by', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'review_reason', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'is_paid', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_work_tasks', 'paid_at', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'paid_amount', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_work_tasks', 'updated_at', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'deleted_at', 'TEXT');
    } catch (error) {
      logger.error('Coin database schema v4 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 5) {
    logger.info('Migrating coin database schema to version 5 (casino games and loans).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v5 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 6) {
    logger.info('Migrating coin database schema to version 6 (casino debt controls).');
    try {
      addColumnIfMissing(db, 'casino_loans', 'relief_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'casino_loans', 'relief_updated_by', 'TEXT');
      addColumnIfMissing(db, 'casino_loans', 'relief_updated_at', 'TEXT');
    } catch (error) {
      logger.error('Coin database schema v6 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 7) {
    logger.info('Migrating coin database schema to version 7 (casino venue services).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v7 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 8) {
    logger.info('Migrating coin database schema to version 8 (chips, luxury shop, pawn shop).');
    try {
      db.exec(schemaSql);
      addColumnIfMissing(db, 'casino_games', 'currency', "TEXT NOT NULL DEFAULT 'coin'");
      addColumnIfMissing(db, 'casino_blackjack_sessions', 'currency', "TEXT NOT NULL DEFAULT 'coin'");
      addColumnIfMissing(db, 'casino_ledger', 'currency', "TEXT NOT NULL DEFAULT 'coin'");

      const itemsWithoutHistory = getRows(
        db,
        `SELECT id, guild_id, price, created_by, created_at
         FROM luxury_items
         WHERE NOT EXISTS (
           SELECT 1
           FROM luxury_price_history
           WHERE luxury_price_history.guild_id = luxury_items.guild_id
             AND luxury_price_history.item_id = luxury_items.id
         )`
      );

      for (const item of itemsWithoutHistory) {
        runSql(
          db,
          `INSERT INTO luxury_price_history (guild_id, item_id, price, changed_by, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [item.guild_id, item.id, item.price, item.created_by || null, 'initial price migration', item.created_at || new Date().toISOString()]
        );
      }
    } catch (error) {
      logger.error('Coin database schema v8 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 9) {
    logger.info('Migrating coin database schema to version 9 (venue waiters and work penalties).');
    try {
      db.exec(schemaSql);
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_user_id', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_job_id', 'INTEGER');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_job_name', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_assigned_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_due_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_amount', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_status', "TEXT NOT NULL DEFAULT 'none'");
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_paid_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_refunded_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'served_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'served_by', 'TEXT');
    } catch (error) {
      logger.error('Coin database schema v9 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 10) {
    logger.info('Migrating coin database schema to version 10 (casino lodging and duel tower).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v10 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
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
