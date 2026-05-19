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
  deleteWorkSubmission,
  editWorkSubmission,
  getPayrollHistory,
  listJobs,
  listWorkTasks,
  processDueJobs,
  reportWork,
  reviewWorkSubmission,
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
