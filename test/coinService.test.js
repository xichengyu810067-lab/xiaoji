const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-coin-'));
const dbPath = path.join(tempDirectory, 'xiaoji.sqlite');

process.env.COIN_DB_PATH = dbPath;
process.env.COIN_TIMEZONE = 'Asia/Taipei';

const { initializeCoinDatabase, resetCoinDatabaseForTests, withCoinTransaction } = require('../src/services/coinDatabase');
const {
  CoinServiceError,
  adjustPlayerBalance,
  createShopItem,
  dailyCheckin,
  getInventory,
  getPlayerBalance,
  purchaseItem,
} = require('../src/services/coinService');
const {
  createFixedDeposit,
  getAllBalanceSummaries,
  getBalanceSummary,
  listFixedDeposits,
  setFixedRate,
} = require('../src/services/bankService');
const {
  addPendingTask,
  getPayrollHistory,
  listWorkTasks,
  processDueJobs,
  reportWork,
  startJob,
} = require('../src/services/workService');

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

test('work task completion ratio is persisted in payroll history', async () => {
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
  assert.equal(payroll[0].totalTasks, 2);
  assert.equal(payroll[0].completedTasks, 1);
  assert.equal(payroll[0].paidAmount, 250);
  assert.equal(player.balance, 250);
  assert.ok(tasks.some((task) => task.status === 'completed'));
  assert.ok(tasks.some((task) => task.status === 'expired'));
});

test('work payroll pays rounded basic salary when no tasks exist', async () => {
  const job = await startJob('guild-1', 'user-1', '迎賓員', 1);
  await withCoinTransaction((api) => {
    api.run("UPDATE coin_jobs SET pay_at = ? WHERE id = ?", ['2000-01-01T00:00:00.000Z', job.id]);
  });

  await processDueJobs();
  const payroll = await getPayrollHistory('guild-1', { userId: 'user-1' });
  const player = await getPlayerBalance('guild-1', 'user-1');

  assert.equal(payroll[0].totalTasks, 0);
  assert.equal(payroll[0].payRatio, 0.75);
  assert.equal(payroll[0].paidAmount, 38);
  assert.equal(player.balance, 38);
});
