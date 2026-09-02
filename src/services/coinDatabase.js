const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const logger = require('../utils/logger');

const rootPath = path.resolve(__dirname, '..', '..');
const defaultRelativeDbPath = path.join('data', 'xiaoji.sqlite');
const schemaVersion = 18;

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

CREATE TABLE IF NOT EXISTS feature_guild_settings (
  guild_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  channel_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, feature_key)
);

CREATE TABLE IF NOT EXISTS feature_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered')),
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
);

CREATE TABLE IF NOT EXISTS feature_outbox_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_event_id INTEGER NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  dead_letter_reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reward_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reward_kind TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  metadata TEXT,
  transaction_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (guild_id, user_id, source_type, source_id, reward_kind)
);

CREATE TABLE IF NOT EXISTS feature_usage_daily (
  usage_date TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, feature_key, metric_key)
);

CREATE TABLE IF NOT EXISTS feature_health (
  feature_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('normal', 'maintenance', 'broken')),
  detail TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_chat_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  style TEXT NOT NULL DEFAULT 'cute' CHECK (style IN ('cute', 'mature_sister', 'ceo', 'cold', 'tsundere', 'yandere')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_romance_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  started_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  launch_token_hash TEXT NOT NULL UNIQUE,
  access_token_hash TEXT UNIQUE,
  launch_consumed_at TEXT,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  game_type TEXT NOT NULL CHECK (game_type IN ('tetris', 'number-match', 'sudoku')),
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'normal', 'complex', 'hard')),
  seed TEXT NOT NULL,
  state_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'failed')),
  action_count INTEGER NOT NULL DEFAULT 0 CHECK (action_count >= 0 AND action_count <= 500),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 20000),
  reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0 AND reward_amount <= 1000),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS game_actions (
  session_id TEXT NOT NULL,
  action_index INTEGER NOT NULL CHECK (action_index >= 0 AND action_index < 500),
  action_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, action_index),
  FOREIGN KEY (session_id) REFERENCES game_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_rewards (
  session_id TEXT PRIMARY KEY NOT NULL,
  reward_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'no_reward')),
  amount INTEGER NOT NULL CHECK (amount >= 0 AND amount <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES game_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS text_chain_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
  current_word TEXT NOT NULL,
  last_word TEXT NOT NULL,
  last_user_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  started_by TEXT NOT NULL,
  stopped_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS text_chain_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  word TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (message_id)
);

CREATE TABLE IF NOT EXISTS number_chain_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
  expected_target INTEGER NOT NULL CHECK (expected_target >= 1 AND expected_target <= 9007199254740991),
  last_user_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  started_by TEXT NOT NULL,
  stopped_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS number_chain_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  expression TEXT NOT NULL,
  result INTEGER NOT NULL CHECK (result >= 1 AND result <= 9007199254740991),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('riddle', 'discussion')),
  local_date TEXT NOT NULL,
  riddle_id TEXT,
  parent_channel_id TEXT NOT NULL,
  announcement_message_id TEXT,
  thread_id TEXT,
  answer_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'published', 'published_late', 'settling', 'rewarding', 'settled', 'blocked', 'missed', 'failed')),
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  publish_marker TEXT NOT NULL,
  answer_marker TEXT NOT NULL,
  published_at TEXT,
  history_reconciled_at TEXT,
  settled_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  publish_lease_owner TEXT,
  publish_lease_until TEXT,
  settle_lease_owner TEXT,
  settle_lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guild_id, event_kind, local_date)
);

CREATE TABLE IF NOT EXISTS daily_event_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
  correct INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0, 1)),
  UNIQUE (event_id, message_id)
);

CREATE TABLE IF NOT EXISTS daily_event_participants (
  event_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
  correct INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0, 1)),
  participation_reward_status TEXT NOT NULL DEFAULT 'pending' CHECK (participation_reward_status IN ('pending', 'granted')),
  correct_reward_status TEXT NOT NULL DEFAULT 'pending' CHECK (correct_reward_status IN ('pending', 'granted', 'not_earned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
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

CREATE INDEX IF NOT EXISTS idx_feature_outbox_claim
  ON feature_outbox (status, available_at, lease_until, id);

CREATE INDEX IF NOT EXISTS idx_text_chain_sessions_active
  ON text_chain_sessions (guild_id, channel_id, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_text_chain_entries_session_word
  ON text_chain_entries (session_id, word);

CREATE INDEX IF NOT EXISTS idx_number_chain_sessions_active
  ON number_chain_sessions (guild_id, channel_id, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_number_chain_entries_session_result
  ON number_chain_entries (session_id, result);

CREATE INDEX IF NOT EXISTS idx_daily_events_due
  ON daily_events (status, window_end_at, guild_id, id);

CREATE INDEX IF NOT EXISTS idx_daily_event_messages_window
  ON daily_event_messages (event_id, created_at, message_id);

CREATE INDEX IF NOT EXISTS idx_daily_event_participants_reward
  ON daily_event_participants (event_id, eligible, correct, user_id);

CREATE INDEX IF NOT EXISTS idx_reward_grants_source
  ON reward_grants (guild_id, source_type, source_id, reward_kind);

CREATE INDEX IF NOT EXISTS idx_feature_usage_daily_feature
  ON feature_usage_daily (feature_key, usage_date DESC, metric_key);
`;

const wordChainActiveSessionIndexSql = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_text_chain_one_active_guild
  ON text_chain_sessions (guild_id)
  WHERE status = 'active';
`;

const numberChainActiveSessionIndexSql = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_number_chain_one_active_guild
  ON number_chain_sessions (guild_id)
  WHERE status = 'active';
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

function getTableColumns(db, tableName) {
  return getRows(db, `PRAGMA table_info(${tableName})`).map((column) => ({
    name: column.name,
    type: String(column.type || '').trim().toUpperCase(),
    notNull: Number(column.notnull) === 1,
    defaultValue: column.dflt_value == null ? null : String(column.dflt_value).trim(),
    primaryKeyPosition: Number(column.pk),
  }));
}

function addColumnIfMissing(db, tableName, columnName, columnDefinition) {
  const columns = getColumnNames(db, tableName);

  if (!columns.includes(columnName)) {
    runSql(db, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

function hasUniqueIndex(db, tableName, expectedColumns) {
  const indexes = getRows(db, `PRAGMA index_list(${tableName})`).filter((index) => Number(index.unique) === 1);

  return indexes.some((index) => {
    const quotedIndexName = `"${String(index.name).replaceAll('"', '""')}"`;
    const columns = getRows(db, `PRAGMA index_info(${quotedIndexName})`).map((column) => column.name);
    return columns.length === expectedColumns.length && columns.every((column, index) => column === expectedColumns[index]);
  });
}

function getTableDefinition(db, tableName) {
  const row = getRow(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);

  if (!row?.sql) {
    throw new Error(`${tableName} is missing its table definition`);
  }

  return String(row.sql)
    .toLowerCase()
    .replace(/[\s\"`\[\]]+/g, '');
}

function verifyTableContract(db, tableName, requiredColumns, requiredChecks) {
  const actualColumns = new Map(getTableColumns(db, tableName).map((column) => [column.name, column]));

  for (const [columnName, expected] of Object.entries(requiredColumns)) {
    const actual = actualColumns.get(columnName);

    if (!actual) {
      throw new Error(`${tableName} is missing required column: ${columnName}`);
    }

    if (
      actual.type !== expected.type ||
      actual.notNull !== expected.notNull ||
      actual.defaultValue !== expected.defaultValue ||
      actual.primaryKeyPosition !== expected.primaryKeyPosition
    ) {
      throw new Error(`${tableName}.${columnName} does not match its required schema contract`);
    }
  }

  const definition = getTableDefinition(db, tableName);
  for (const check of requiredChecks) {
    if (!definition.includes(check)) {
      throw new Error(`${tableName} is missing required CHECK constraint: ${check}`);
    }
  }
}

function verifyFeaturePlatformSchema(db) {
  const text = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'TEXT',
    notNull,
    defaultValue,
    primaryKeyPosition,
  });
  const integer = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'INTEGER',
    notNull,
    defaultValue,
    primaryKeyPosition,
  });
  const tableContracts = {
    feature_guild_settings: {
      columns: {
        guild_id: text(true, null, 1),
        feature_key: text(true, null, 2),
        enabled: integer(true, '0'),
        channel_id: text(),
        config_json: text(true, "'{}'"),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: ['check(enabledin(0,1))'],
    },
    feature_outbox: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        feature_key: text(true),
        event_type: text(true),
        dedupe_key: text(true),
        payload_json: text(true),
        status: text(true, "'pending'"),
        available_at: text(true),
        attempt_count: integer(true, '0'),
        claimed_by: text(),
        claimed_at: text(),
        lease_until: text(),
        delivered_at: text(),
        last_error: text(),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: ["check(statusin('pending','processing','delivered'))"],
    },
    feature_outbox_dead_letters: {
      columns: {
        id: integer(false, null, 1),
        original_event_id: integer(true),
        guild_id: text(true),
        feature_key: text(true),
        event_type: text(true),
        dedupe_key: text(true),
        payload_json: text(true),
        attempt_count: integer(true),
        last_error: text(true),
        dead_letter_reason: text(true),
        created_at: text(true),
      },
      checks: [],
    },
    reward_grants: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        user_id: text(true),
        source_type: text(true),
        source_id: text(true),
        reward_kind: text(true),
        amount: integer(true),
        metadata: text(),
        transaction_id: integer(),
        created_at: text(true),
      },
      checks: ['check(amount>0)'],
    },
    feature_usage_daily: {
      columns: {
        usage_date: text(true, null, 1),
        feature_key: text(true, null, 2),
        metric_key: text(true, null, 3),
        usage_count: integer(true, '0'),
        updated_at: text(true),
      },
      checks: ['check(usage_count>=0)'],
    },
    feature_health: {
      columns: {
        feature_key: text(false, null, 1),
        status: text(true),
        detail: text(),
        updated_at: text(true),
      },
      checks: ["check(statusin('normal','maintenance','broken'))"],
    },
    user_chat_preferences: {
      columns: {
        user_id: text(true, null, 1),
        style: text(true, "'cute'"),
        updated_at: text(true),
      },
      checks: ["check(stylein('cute','mature_sister','ceo','cold','tsundere','yandere'))"],
    },
    user_romance_preferences: {
      columns: {
        user_id: text(true, null, 1),
        enabled: integer(true, '0'),
        started_at: text(),
        updated_at: text(true),
      },
      checks: ['check(enabledin(0,1))'],
    },
    game_sessions: {
      columns: {
        id: text(true, null, 1), launch_token_hash: text(true), access_token_hash: text(), launch_consumed_at: text(),
        user_id: text(true), guild_id: text(true), channel_id: text(true), game_type: text(true), difficulty: text(true),
        seed: text(true), state_json: text(true), status: text(true, "'active'"), action_count: integer(true, '0'),
        score: integer(true, '0'), reward_amount: integer(true, '0'), expires_at: text(true), created_at: text(true),
        updated_at: text(true), completed_at: text(),
      },
      checks: ["check(game_typein('tetris','number-match','sudoku'))", "check(difficultyin('easy','normal','complex','hard'))", "check(statusin('active','completed','expired','failed'))", 'check(action_count>=0andaction_count<=500)', 'check(score>=0andscore<=20000)', 'check(reward_amount>=0andreward_amount<=1000)'],
    },
    game_actions: {
      columns: { session_id: text(true, null, 1), action_index: integer(true, null, 2), action_hash: text(true), state_json: text(true), created_at: text(true) },
      checks: ['check(action_index>=0andaction_index<500)'],
    },
    game_rewards: {
      columns: { session_id: text(true, null, 1), reward_key: text(true), status: text(true, "'pending'"), amount: integer(true), created_at: text(true), updated_at: text(true) },
      checks: ["check(statusin('pending','granted','no_reward'))", 'check(amount>=0andamount<=1000)'],
    },
    text_chain_sessions: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        channel_id: text(true),
        status: text(true, "'active'"),
        current_word: text(true),
        last_word: text(true),
        last_user_id: text(),
        revision: integer(true, '0'),
        started_by: text(true),
        stopped_by: text(),
        created_at: text(true),
        updated_at: text(true),
        stopped_at: text(),
        completed_at: text(),
      },
      checks: ["check(statusin('active','stopped','completed'))", 'check(revision>=0)'],
    },
    text_chain_entries: {
      columns: {
        id: integer(false, null, 1),
        session_id: integer(true),
        guild_id: text(true),
        channel_id: text(true),
        message_id: text(true),
        user_id: text(true),
        word: text(true),
        created_at: text(true),
      },
      checks: [],
    },
    number_chain_sessions: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        channel_id: text(true),
        status: text(true, "'active'"),
        expected_target: integer(true),
        last_user_id: text(),
        revision: integer(true, '0'),
        started_by: text(true),
        stopped_by: text(),
        created_at: text(true),
        updated_at: text(true),
        stopped_at: text(),
        completed_at: text(),
      },
      checks: ["check(statusin('active','stopped','completed'))", 'check(expected_target>=1andexpected_target<=9007199254740991)', 'check(revision>=0)'],
    },
    number_chain_entries: {
      columns: {
        id: integer(false, null, 1),
        session_id: integer(true),
        guild_id: text(true),
        channel_id: text(true),
        message_id: text(true),
        user_id: text(true),
        expression: text(true),
        result: integer(true),
        created_at: text(true),
      },
      checks: ['check(result>=1andresult<=9007199254740991)'],
    },
    daily_events: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        event_kind: text(true),
        local_date: text(true),
        riddle_id: text(),
        parent_channel_id: text(true),
        announcement_message_id: text(),
        thread_id: text(),
        answer_message_id: text(),
        status: text(true, "'claimed'"),
        window_start_at: text(true),
        window_end_at: text(true),
        publish_marker: text(true),
        answer_marker: text(true),
        published_at: text(),
        history_reconciled_at: text(),
        settled_at: text(),
        attempt_count: integer(true, '0'),
        publish_lease_owner: text(),
        publish_lease_until: text(),
        settle_lease_owner: text(),
        settle_lease_until: text(),
        last_error: text(),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: [
        "check(event_kindin('riddle','discussion'))",
        "check(statusin('claimed','published','published_late','settling','rewarding','settled','blocked','missed','failed'))",
        'check(attempt_count>=0)',
      ],
    },
    daily_event_messages: {
      columns: {
        id: integer(false, null, 1),
        event_id: integer(true),
        guild_id: text(true),
        thread_id: text(true),
        message_id: text(true),
        user_id: text(true),
        created_at: text(true),
        eligible: integer(true, '0'),
        correct: integer(true, '0'),
      },
      checks: ['check(eligiblein(0,1))', 'check(correctin(0,1))'],
    },
    daily_event_participants: {
      columns: {
        event_id: integer(true, null, 1),
        guild_id: text(true),
        user_id: text(true, null, 2),
        eligible: integer(true, '0'),
        correct: integer(true, '0'),
        participation_reward_status: text(true, "'pending'"),
        correct_reward_status: text(true, "'pending'"),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: [
        'check(eligiblein(0,1))',
        'check(correctin(0,1))',
        "check(participation_reward_statusin('pending','granted'))",
        "check(correct_reward_statusin('pending','granted','not_earned'))",
      ],
    },
  };

  for (const [tableName, contract] of Object.entries(tableContracts)) {
    verifyTableContract(db, tableName, contract.columns, contract.checks);
  }

  const preferenceColumns = getColumnNames(db, 'user_chat_preferences');
  if (JSON.stringify(preferenceColumns) !== JSON.stringify(['user_id', 'style', 'updated_at'])) {
    throw new Error('user_chat_preferences must contain only its global, non-message preference fields');
  }

  const romancePreferenceColumns = getColumnNames(db, 'user_romance_preferences');
  if (JSON.stringify(romancePreferenceColumns) !== JSON.stringify(['user_id', 'enabled', 'started_at', 'updated_at'])) {
    throw new Error('user_romance_preferences must contain only its global, non-message preference fields');
  }

  for (const [tableName, expected] of [
    ['game_sessions', ['id','launch_token_hash','access_token_hash','launch_consumed_at','user_id','guild_id','channel_id','game_type','difficulty','seed','state_json','status','action_count','score','reward_amount','expires_at','created_at','updated_at','completed_at']],
    ['game_actions', ['session_id','action_index','action_hash','state_json','created_at']],
    ['game_rewards', ['session_id','reward_key','status','amount','created_at','updated_at']],
  ]) {
    if (JSON.stringify(getColumnNames(db, tableName)) !== JSON.stringify(expected)) throw new Error(`${tableName} has an unsafe schema shape`);
  }
  for (const tableName of ['game_actions', 'game_rewards']) {
    const foreignKey = getRows(db, `PRAGMA foreign_key_list(${tableName})`).find((row) => row.table === 'game_sessions' && row.from === 'session_id' && row.to === 'id' && String(row.on_delete).toUpperCase() === 'CASCADE');
    if (!foreignKey) throw new Error(`${tableName} is missing its session foreign key`);
  }

  for (const [tableName, columns] of [
    ['feature_guild_settings', ['guild_id', 'feature_key']],
    ['feature_outbox', ['guild_id', 'feature_key', 'event_type', 'dedupe_key']],
    ['feature_outbox_dead_letters', ['original_event_id']],
    ['reward_grants', ['guild_id', 'user_id', 'source_type', 'source_id', 'reward_kind']],
    ['feature_usage_daily', ['usage_date', 'feature_key', 'metric_key']],
    ['text_chain_entries', ['message_id']],
    ['number_chain_entries', ['message_id']],
    ['daily_events', ['guild_id', 'event_kind', 'local_date']],
    ['daily_event_messages', ['event_id', 'message_id']],
    ['daily_event_participants', ['event_id', 'user_id']],
    ['game_sessions', ['launch_token_hash']],
    ['game_sessions', ['access_token_hash']],
    ['game_actions', ['session_id', 'action_index']],
    ['game_rewards', ['reward_key']],
  ]) {
    if (!hasUniqueIndex(db, tableName, columns)) {
      throw new Error(`${tableName} is missing its required unique key`);
    }
  }

  const activeSessionIndex = getRow(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_text_chain_one_active_guild'"
  )?.sql;
  const normalizedActiveSessionIndex = String(activeSessionIndex || '')
    .toLowerCase()
    .replace(/[\s\"`\[\]]+/g, '');
  if (!normalizedActiveSessionIndex.includes("uniqueindexidx_text_chain_one_active_guildontext_chain_sessions(guild_id)wherestatus='active'")) {
    throw new Error('text_chain_sessions is missing the one-active-session-per-guild unique index');
  }
  const activeNumberSessionIndex = getRow(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_number_chain_one_active_guild'"
  )?.sql;
  const normalizedActiveNumberSessionIndex = String(activeNumberSessionIndex || '')
    .toLowerCase()
    .replace(/[\s\"`\[\]]+/g, '');
  if (!normalizedActiveNumberSessionIndex.includes("uniqueindexidx_number_chain_one_active_guildonnumber_chain_sessions(guild_id)wherestatus='active'")) {
    throw new Error('number_chain_sessions is missing the one-active-session-per-guild unique index');
  }
}

function writeDatabaseFile(dbPath, db) {
  const directory = path.dirname(dbPath);
  const tempPath = `${dbPath}.tmp`;
  const exported = Buffer.from(db.export());

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(tempPath, exported);
    fs.renameSync(tempPath, dbPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (cleanupError) {
      logger.error(`吉幣資料庫暫存檔清理失敗：${tempPath}`, cleanupError);
    }
    throw error;
  }
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

function reconcileWordChainActiveSessions(db) {
  const timestamp = new Date().toISOString();
  const retainedByGuild = new Map();
  const activeSessions = getRows(
    db,
    `SELECT id, guild_id, channel_id
     FROM text_chain_sessions
     WHERE status = 'active'
     ORDER BY guild_id ASC, updated_at DESC, id DESC`
  );

  for (const session of activeSessions) {
    if (!retainedByGuild.has(session.guild_id)) {
      retainedByGuild.set(session.guild_id, session);
      continue;
    }
    runSql(
      db,
      `UPDATE text_chain_sessions
       SET status = 'stopped', stopped_at = COALESCE(stopped_at, updated_at), revision = revision + 1
       WHERE id = ? AND status = 'active'`,
      [session.id]
    );
  }

  const guildIds = new Set([
    ...getRows(db, 'SELECT DISTINCT guild_id FROM text_chain_sessions').map((row) => row.guild_id),
    ...getRows(db, "SELECT guild_id FROM feature_guild_settings WHERE feature_key = 'word_chain'").map((row) => row.guild_id),
  ]);
  const existingSettings = new Map(
    getRows(
      db,
      "SELECT guild_id, enabled, channel_id FROM feature_guild_settings WHERE feature_key = 'word_chain'"
    ).map((setting) => [setting.guild_id, setting])
  );

  for (const guildId of guildIds) {
    const retained = retainedByGuild.get(guildId);
    const enabled = retained ? 1 : 0;
    const channelId = retained?.channel_id || null;
    const existing = existingSettings.get(guildId);
    if (existing && Number(existing.enabled) === enabled && (existing.channel_id || null) === channelId) {
      continue;
    }
    runSql(
      db,
      `INSERT INTO feature_guild_settings
        (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
       VALUES (?, 'word_chain', ?, ?, '{}', ?, ?)
       ON CONFLICT(guild_id, feature_key) DO UPDATE SET
         enabled = excluded.enabled, channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
      [guildId, enabled, channelId, timestamp, timestamp]
    );
  }
}

function migrateWordChainV12Contract(db) {
  if (!getTableNames(db).has('text_chain_sessions')) {
    return;
  }

  const columns = new Set(getColumnNames(db, 'text_chain_sessions'));
  const definition = getTableDefinition(db, 'text_chain_sessions');
  const hasCompletedStatus = definition.includes("check(statusin('active','stopped','completed'))");

  if (columns.has('completed_at') && hasCompletedStatus) {
    return;
  }

  db.exec(`
    CREATE TABLE text_chain_sessions_rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
      current_word TEXT NOT NULL,
      last_word TEXT NOT NULL,
      last_user_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      started_by TEXT NOT NULL,
      stopped_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      stopped_at TEXT,
      completed_at TEXT
    );
    INSERT INTO text_chain_sessions_rebuild
      (id, guild_id, channel_id, status, current_word, last_word, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, completed_at)
    SELECT id, guild_id, channel_id,
      CASE WHEN status = 'active' THEN 'active' ELSE 'stopped' END,
      current_word, last_word, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, NULL
    FROM text_chain_sessions;
    DROP TABLE text_chain_sessions;
    ALTER TABLE text_chain_sessions_rebuild RENAME TO text_chain_sessions;
  `);
}

function reconcileNumberChainActiveSessions(db) {
  const timestamp = new Date().toISOString();
  const retainedByGuild = new Map();
  const activeSessions = getRows(
    db,
    `SELECT id, guild_id, channel_id
     FROM number_chain_sessions
     WHERE status = 'active'
     ORDER BY guild_id ASC, updated_at DESC, id DESC`
  );
  for (const session of activeSessions) {
    if (!retainedByGuild.has(session.guild_id)) {
      retainedByGuild.set(session.guild_id, session);
      continue;
    }
    runSql(
      db,
      `UPDATE number_chain_sessions
       SET status = 'stopped', stopped_at = COALESCE(stopped_at, updated_at), revision = revision + 1
       WHERE id = ? AND status = 'active'`,
      [session.id]
    );
  }

  const guildIds = new Set([
    ...getRows(db, 'SELECT DISTINCT guild_id FROM number_chain_sessions').map((row) => row.guild_id),
    ...getRows(db, "SELECT guild_id FROM feature_guild_settings WHERE feature_key = 'number_chain'").map((row) => row.guild_id),
  ]);
  const existingSettings = new Map(
    getRows(db, "SELECT guild_id, enabled, channel_id FROM feature_guild_settings WHERE feature_key = 'number_chain'")
      .map((setting) => [setting.guild_id, setting])
  );
  for (const guildId of guildIds) {
    const retained = retainedByGuild.get(guildId);
    const enabled = retained ? 1 : 0;
    const channelId = retained?.channel_id || null;
    const existing = existingSettings.get(guildId);
    if (existing && Number(existing.enabled) === enabled && (existing.channel_id || null) === channelId) continue;
    runSql(
      db,
      `INSERT INTO feature_guild_settings
        (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
       VALUES (?, 'number_chain', ?, ?, '{}', ?, ?)
       ON CONFLICT(guild_id, feature_key) DO UPDATE SET
         enabled = excluded.enabled, channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
      [guildId, enabled, channelId, timestamp, timestamp]
    );
  }
}

function migrateNumberChainV13Contract(db) {
  if (!getTableNames(db).has('number_chain_sessions')) return;

  const columns = new Set(getColumnNames(db, 'number_chain_sessions'));
  const definition = getTableDefinition(db, 'number_chain_sessions');
  const currentColumns = [
    'id', 'guild_id', 'channel_id', 'status', 'expected_target', 'last_user_id', 'revision', 'started_by', 'stopped_by',
    'created_at', 'updated_at', 'stopped_at', 'completed_at',
  ];
  const legacyColumns = currentColumns.filter((column) => column !== 'completed_at');
  const hasCurrentStatus = definition.includes("check(statusin('active','stopped','completed'))");
  const hasLegacyStatus = definition.includes("check(statusin('active','stopped'))");
  const hasAll = (required) => required.every((column) => columns.has(column));
  if (hasAll(currentColumns) && hasCurrentStatus) return;
  if (!hasAll(legacyColumns) || !hasLegacyStatus) {
    throw new Error('number_chain_sessions has an incompatible legacy schema');
  }

  db.exec(`
    CREATE TABLE number_chain_sessions_rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
      expected_target INTEGER NOT NULL CHECK (expected_target >= 1 AND expected_target <= 9007199254740991),
      last_user_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      started_by TEXT NOT NULL,
      stopped_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      stopped_at TEXT,
      completed_at TEXT
    );
    INSERT INTO number_chain_sessions_rebuild
      (id, guild_id, channel_id, status, expected_target, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, completed_at)
    SELECT id, guild_id, channel_id,
      CASE WHEN status = 'active' THEN 'active' ELSE 'stopped' END,
      expected_target, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, NULL
    FROM number_chain_sessions;
    DROP TABLE number_chain_sessions;
    ALTER TABLE number_chain_sessions_rebuild RENAME TO number_chain_sessions;
  `);
}

function assertDailyEventLinks(db) {
  const orphanMessage = getRow(
    db,
    `SELECT message.id
     FROM daily_event_messages AS message
     LEFT JOIN daily_events AS event ON event.id = message.event_id
     WHERE event.id IS NULL LIMIT 1`
  );
  const orphanParticipant = getRow(
    db,
    `SELECT participant.event_id
     FROM daily_event_participants AS participant
     LEFT JOIN daily_events AS event ON event.id = participant.event_id
     WHERE event.id IS NULL LIMIT 1`
  );
  if (orphanMessage || orphanParticipant) {
    throw new Error('daily riddle records contain an orphaned event reference');
  }
  const foreignKeyFailure = getRow(db, 'PRAGMA foreign_key_check');
  if (foreignKeyFailure) throw new Error('daily riddle records fail foreign key validation');
}

function migrateDailyRiddleV15Contract(db) {
  const eventColumnsV14 = [
    'id', 'guild_id', 'event_kind', 'local_date', 'riddle_id', 'parent_channel_id', 'announcement_message_id',
    'thread_id', 'answer_message_id', 'status', 'window_start_at', 'window_end_at', 'publish_marker', 'answer_marker',
    'published_at', 'history_reconciled_at', 'settled_at', 'attempt_count', 'last_error', 'created_at', 'updated_at',
  ];
  const eventColumnsV15 = [
    ...eventColumnsV14.slice(0, 18),
    'publish_lease_owner', 'publish_lease_until', 'settle_lease_owner', 'settle_lease_until',
    ...eventColumnsV14.slice(18),
  ];
  const messageColumnsV14 = [
    'id', 'event_id', 'guild_id', 'thread_id', 'message_id', 'user_id', 'created_at', 'content_hash', 'eligible', 'correct',
  ];
  const messageColumnsV15 = messageColumnsV14.filter((column) => column !== 'content_hash');
  const participantColumns = [
    'event_id', 'guild_id', 'user_id', 'eligible', 'correct', 'participation_reward_status', 'correct_reward_status',
    'created_at', 'updated_at',
  ];
  const exactColumns = (tableName, expected) => {
    const actual = getColumnNames(db, tableName);
    return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
  };
  if (!exactColumns('daily_event_participants', participantColumns)) {
    throw new Error('daily_event_participants has an incompatible schema');
  }

  const eventDefinition = getTableDefinition(db, 'daily_events');
  const messageDefinition = getTableDefinition(db, 'daily_event_messages');
  const currentShape =
    exactColumns('daily_events', eventColumnsV15) &&
    exactColumns('daily_event_messages', messageColumnsV15) &&
    eventDefinition.includes("check(statusin('claimed','published','published_late','settling','rewarding','settled','blocked','missed','failed'))") &&
    !messageDefinition.includes('content_hash');
  if (currentShape) {
    assertDailyEventLinks(db);
    return false;
  }

  const legacyShape =
    exactColumns('daily_events', eventColumnsV14) &&
    exactColumns('daily_event_messages', messageColumnsV14) &&
    eventDefinition.includes("check(statusin('claimed','published','published_late','settling','settled','blocked','missed','failed'))") &&
    messageDefinition.includes('content_hashtextnotnull') &&
    messageDefinition.includes('check(length(content_hash)=64');
  if (!legacyShape) throw new Error('daily riddle tables have an incompatible v14 schema');
  assertDailyEventLinks(db);
  for (const tableName of ['daily_events_v15_rebuild', 'daily_event_messages_v15_rebuild']) {
    if (getTableNames(db).has(tableName)) throw new Error(`unexpected migration table already exists: ${tableName}`);
  }

  const before = {
    events: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_events').count),
    messages: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_messages').count),
    participants: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_participants').count),
  };
  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    db.exec(`
      CREATE TABLE daily_events_v15_rebuild (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        event_kind TEXT NOT NULL CHECK (event_kind IN ('riddle', 'discussion')),
        local_date TEXT NOT NULL,
        riddle_id TEXT,
        parent_channel_id TEXT NOT NULL,
        announcement_message_id TEXT,
        thread_id TEXT,
        answer_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'published', 'published_late', 'settling', 'rewarding', 'settled', 'blocked', 'missed', 'failed')),
        window_start_at TEXT NOT NULL,
        window_end_at TEXT NOT NULL,
        publish_marker TEXT NOT NULL,
        answer_marker TEXT NOT NULL,
        published_at TEXT,
        history_reconciled_at TEXT,
        settled_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        publish_lease_owner TEXT,
        publish_lease_until TEXT,
        settle_lease_owner TEXT,
        settle_lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (guild_id, event_kind, local_date)
      );
      CREATE TABLE daily_event_messages_v15_rebuild (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        guild_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
        correct INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0, 1)),
        UNIQUE (event_id, message_id)
      );
      INSERT INTO daily_events_v15_rebuild
        (id, guild_id, event_kind, local_date, riddle_id, parent_channel_id, announcement_message_id, thread_id,
         answer_message_id, status, window_start_at, window_end_at, publish_marker, answer_marker, published_at,
         history_reconciled_at, settled_at, attempt_count, publish_lease_owner, publish_lease_until,
         settle_lease_owner, settle_lease_until, last_error, created_at, updated_at)
      SELECT id, guild_id, event_kind, local_date, riddle_id, parent_channel_id, announcement_message_id, thread_id,
         answer_message_id, status, window_start_at, window_end_at, publish_marker, answer_marker, published_at,
         history_reconciled_at, settled_at, attempt_count, NULL, NULL, NULL, NULL, last_error, created_at, updated_at
      FROM daily_events;
      INSERT INTO daily_event_messages_v15_rebuild
        (id, event_id, guild_id, thread_id, message_id, user_id, created_at, eligible, correct)
      SELECT id, event_id, guild_id, thread_id, message_id, user_id, created_at, eligible, correct
      FROM daily_event_messages;
      DROP TABLE daily_event_messages;
      DROP TABLE daily_events;
      ALTER TABLE daily_events_v15_rebuild RENAME TO daily_events;
      ALTER TABLE daily_event_messages_v15_rebuild RENAME TO daily_event_messages;
    `);
    const after = {
      events: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_events').count),
      messages: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_messages').count),
      participants: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_participants').count),
    };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('daily riddle migration row counts changed');
    assertDailyEventLinks(db);
    verifyIntegrity(db);
    db.exec('COMMIT');
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        logger.error('Daily riddle v15 migration rollback failed', rollbackError);
      }
    }
    throw error;
  }
}

function migrateGameSessionsV18Bounds(db) {
  if (!getTableNames(db).has('game_sessions')) return false;
  const sessionColumns = [
    'id', 'launch_token_hash', 'access_token_hash', 'launch_consumed_at', 'user_id', 'guild_id', 'channel_id',
    'game_type', 'difficulty', 'seed', 'state_json', 'status', 'action_count', 'score', 'reward_amount', 'expires_at',
    'created_at', 'updated_at', 'completed_at',
  ];
  const actionColumns = ['session_id', 'action_index', 'action_hash', 'state_json', 'created_at'];
  const rewardColumns = ['session_id', 'reward_key', 'status', 'amount', 'created_at', 'updated_at'];
  const exactColumns = (tableName, expected) => {
    const actual = getColumnNames(db, tableName);
    return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
  };
  if (!exactColumns('game_sessions', sessionColumns) || !exactColumns('game_actions', actionColumns) || !exactColumns('game_rewards', rewardColumns)) {
    throw new Error('game tables have an incompatible v18 schema');
  }
  const definition = getTableDefinition(db, 'game_sessions');
  const rewardDefinition = getTableDefinition(db, 'game_rewards');
  const hasCurrentSessionBounds = definition.includes('check(score>=0andscore<=20000)') &&
    definition.includes('check(reward_amount>=0andreward_amount<=1000)');
  const hasLegacySessionBounds = definition.includes('check(score>=0)') && definition.includes('check(reward_amount>=0)');
  const hasCurrentRewardBounds = rewardDefinition.includes('check(amount>=0andamount<=1000)');
  const hasLegacyRewardBounds = rewardDefinition.includes('check(amount>=0)');
  if (!hasCurrentSessionBounds && !hasLegacySessionBounds) {
    throw new Error('game_sessions has incompatible score constraints');
  }
  if (!hasCurrentRewardBounds && !hasLegacyRewardBounds) {
    throw new Error('game_rewards has incompatible amount constraints');
  }
  const invalid = getRow(db, `SELECT id FROM game_sessions
    WHERE typeof(score) <> 'integer' OR score < 0 OR score > 20000
       OR typeof(reward_amount) <> 'integer' OR reward_amount < 0 OR reward_amount > 1000
    LIMIT 1`);
  if (invalid) throw new Error('game_sessions contains values outside the safe score contract');
  const invalidReward = getRow(db, `SELECT session_id FROM game_rewards
    WHERE typeof(amount) <> 'integer' OR amount < 0 OR amount > 1000
    LIMIT 1`);
  if (invalidReward) throw new Error('game_rewards contains values outside the safe reward contract');
  if (hasCurrentSessionBounds && hasCurrentRewardBounds) return false;
  for (const tableName of ['game_sessions_v18_rebuild', 'game_actions_v18_rebuild', 'game_rewards_v18_rebuild']) {
    if (getTableNames(db).has(tableName)) throw new Error(`unexpected migration table already exists: ${tableName}`);
  }
  const before = {
    sessions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_sessions').count),
    actions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_actions').count),
    rewards: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_rewards').count),
  };
  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    db.exec(`
      CREATE TABLE game_sessions_v18_rebuild (
        id TEXT PRIMARY KEY NOT NULL,
        launch_token_hash TEXT NOT NULL UNIQUE,
        access_token_hash TEXT UNIQUE,
        launch_consumed_at TEXT,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        game_type TEXT NOT NULL CHECK (game_type IN ('tetris', 'number-match', 'sudoku')),
        difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'normal', 'complex', 'hard')),
        seed TEXT NOT NULL,
        state_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'failed')),
        action_count INTEGER NOT NULL DEFAULT 0 CHECK (action_count >= 0 AND action_count <= 500),
        score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 20000),
        reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0 AND reward_amount <= 1000),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE game_actions_v18_rebuild (
        session_id TEXT NOT NULL,
        action_index INTEGER NOT NULL CHECK (action_index >= 0 AND action_index < 500),
        action_hash TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, action_index),
        FOREIGN KEY (session_id) REFERENCES game_sessions_v18_rebuild(id) ON DELETE CASCADE
      );
      CREATE TABLE game_rewards_v18_rebuild (
        session_id TEXT PRIMARY KEY NOT NULL,
        reward_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'no_reward')),
        amount INTEGER NOT NULL CHECK (amount >= 0 AND amount <= 1000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES game_sessions_v18_rebuild(id) ON DELETE CASCADE
      );
      INSERT INTO game_sessions_v18_rebuild SELECT * FROM game_sessions;
      INSERT INTO game_actions_v18_rebuild SELECT * FROM game_actions;
      INSERT INTO game_rewards_v18_rebuild SELECT * FROM game_rewards;
      DROP TABLE game_actions;
      DROP TABLE game_rewards;
      DROP TABLE game_sessions;
      ALTER TABLE game_sessions_v18_rebuild RENAME TO game_sessions;
      ALTER TABLE game_actions_v18_rebuild RENAME TO game_actions;
      ALTER TABLE game_rewards_v18_rebuild RENAME TO game_rewards;
    `);
    const after = {
      sessions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_sessions').count),
      actions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_actions').count),
      rewards: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_rewards').count),
    };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('game migration row counts changed');
    verifyIntegrity(db);
    db.exec('COMMIT');
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { logger.error('Game v18 bounds migration rollback failed', rollbackError); }
    }
    throw error;
  }
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

  try {
    verifyIntegrity(db);
  } catch (error) {
    db.close();
    logger.error(`吉幣資料庫完整性檢查失敗，已停止載入：${dbPath}`, error);
    throw new CoinDatabaseError('吉幣資料庫完整性檢查失敗，不會覆寫原始檔案。', error);
  }

  const beforeTables = getTableNames(db);

  try {
    db.exec(schemaSql);
  } catch (error) {
    db.close();
    logger.error('Coin database schema bootstrap failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  // Simple migration for version 2 (Bank System)
  const currentVersionRow = getRow(db, "SELECT value FROM coin_metadata WHERE key = 'schema_version'");
  const currentVersion = currentVersionRow ? Number(currentVersionRow.value) : 0;

  if (!Number.isInteger(currentVersion) || currentVersion < 0 || currentVersion > schemaVersion) {
    db.close();
    throw new CoinDatabaseError(`不支援的吉幣資料庫 schema 版本：${currentVersionRow?.value ?? 'unknown'}`);
  }

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
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
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

  if (currentVersion < 11) {
    logger.info('Migrating coin database schema to version 11 (community feature platform foundation).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v11 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 12) {
    logger.info('Migrating coin database schema to version 12 (validated word chain).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v12 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 13) {
    logger.info('Migrating coin database schema to version 13 (safe number chain).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v13 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 14) {
    logger.info('Migrating coin database schema to version 14 (daily riddle events).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v14 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 15) {
    logger.info('Migrating coin database schema to version 15 (daily riddle leases and private message records).');
    try {
      migrateDailyRiddleV15Contract(db);
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v15 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 16) {
    logger.info('Migrating coin database schema to version 16 (global user chat preferences).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v16 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 17) {
    logger.info('Migrating coin database schema to version 17 (global romance preferences).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v17 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 18) {
    logger.info('Migrating coin database schema to version 18 (server-authoritative games).');
    try { db.exec(schemaSql); }
    catch (error) {
      logger.error('Coin database schema v18 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  try {
    migrateGameSessionsV18Bounds(db);
    db.exec(schemaSql);
  } catch (error) {
    logger.error('Coin database schema v18 game bounds migration failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  try {
    migrateWordChainV12Contract(db);
    reconcileWordChainActiveSessions(db);
    // Recreate v12 indexes after a legacy session-table rebuild only after
    // multiple legacy active sessions have been deterministically reconciled.
    db.exec(schemaSql);
    db.exec(wordChainActiveSessionIndexSql);
  } catch (error) {
    logger.error('Coin database schema v12 word-chain contract migration failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  try {
    migrateNumberChainV13Contract(db);
    reconcileNumberChainActiveSessions(db);
    // The partial index is deliberately last so legacy multi-active rows can
    // be retained and reconciled before SQLite enforces the invariant.
    db.exec(schemaSql);
    db.exec(numberChainActiveSessionIndexSql);
  } catch (error) {
    logger.error('Coin database schema v13 number-chain contract migration failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  try {
    verifyFeaturePlatformSchema(db);
  } catch (error) {
    db.close();
    logger.error('Coin database schema v18 verification failed', error);
    throw new CoinDatabaseError('吉幣資料庫 v18 結構驗證失敗，已停止啟動避免破壞資料。', error);
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
  return withCoinDatabase(async (api) => {
    let transactionStarted = false;
    const snapshot = Buffer.from(state.db.export());

    try {
      api.run('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = await work(api);
      api.run('COMMIT');
      transactionStarted = false;

      try {
        writeDatabaseFile(state.info.path, state.db);
        state.lastSavedAt = new Date().toISOString();
      } catch (writeError) {
        const Database = state.db.constructor;
        state.db.close();
        state.db = new Database(snapshot);
        runSql(state.db, 'PRAGMA foreign_keys = ON');
        throw new CoinDatabaseError('吉幣資料庫落盤失敗，交易已復原。', writeError);
      }

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
  });
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
