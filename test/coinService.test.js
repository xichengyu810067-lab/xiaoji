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
  listJobs,
  listWorkTasks,
  processDueJobs,
  reportWork,
  reviewWorkSubmission,
  startJob,
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
} = require('../src/services/venueService');
const {
  applyCasinoLoanRelief,
  collectCasinoDebt,
  getCasinoDebtStatus,
  getCasinoLoanStatus,
  getHandValue,
  hitBlackjack,
  listCasinoHistory,
  playDice,
  playSlots,
  borrowCasinoLoan,
  processExpiredBlackjackSessions,
  repayCasinoLoan,
  standBlackjack,
  startBlackjack,
} = require('../src/services/casinoService');

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

test('casino loans borrow coins, accrue daily compound interest, and repay from wallet', async () => {
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

  assert.equal(borrowed.borrowedAmount, 1000);
  assert.equal(borrowed.balanceAfter, 6000);
  assert.equal(dayOne.loan.currentDebtAmount, 1030);
  assert.equal(dayOne.interestApplied, 30);
  assert.equal(dayTwo.loan.currentDebtAmount, 1061);
  assert.equal(dayTwo.interestApplied, 31);
  assert.equal(partial.repaymentAmount, 61);
  assert.equal(partial.loan.currentDebtAmount, 1000);
  assert.equal(final.repaymentAmount, 1000);
  assert.equal(final.loan.status, 'repaid');
  assert.equal(final.loan.currentDebtAmount, 0);
  assert.equal(balance.balance, 4939);
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
    amount: 5000,
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

test('casino dice and slots settle against the existing wallet balance', async () => {
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

  assert.deepEqual(dice.game.result.dice, [4, 4]);
  assert.equal(dice.payoutAmount, 200);
  assert.equal(dice.netAmount, 100);
  assert.deepEqual(slots.game.result.reels, ['七', '七', '七']);
  assert.equal(slots.payoutAmount, 1000);
  assert.equal(slots.netAmount, 900);
  assert.equal(balance.balance, 2000);
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
  assert.equal((await getPlayerBalance('guild-1', 'user-1')).balance, 1150);

  const hitStart = await startBlackjack('guild-1', 'user-1', {
    amount: 100,
    deck: ['10S', '7H', '9C', '7D', '8S'],
  });
  const hitResult = await hitBlackjack('guild-1', 'user-1', hitStart.session.id);

  assert.equal(hitResult.session.status, 'settled');
  assert.equal(hitResult.session.result.outcome, 'lose');
  assert.equal(hitResult.session.netAmount, -100);
  assert.equal((await getPlayerBalance('guild-1', 'user-1')).balance, 1050);

  const standStart = await startBlackjack('guild-1', 'user-1', {
    amount: 100,
    deck: ['10S', '8H', '9C', '7D', '10D'],
  });
  const standResult = await standBlackjack('guild-1', 'user-1', standStart.session.id);

  assert.equal(standResult.session.status, 'settled');
  assert.equal(standResult.session.result.outcome, 'win');
  assert.equal(standResult.session.payoutAmount, 200);
  assert.equal((await getPlayerBalance('guild-1', 'user-1')).balance, 1150);
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

  assert.equal(started.session.status, 'active');
  assert.equal(afterStart.balance, 900);
  assert.equal(expired.refunded, 1);
  assert.equal(afterRefund.balance, 1000);
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

test('casino venue orders assign active staff and require assigned makers to complete items', async () => {
  await startJob('guild-1', 'chef-1', '廚師', 1);
  await startJob('guild-1', 'bartender-1', '調酒師', 1);
  const meal = (await listVenueMenu('guild-1', { itemType: VenueItemType.MEAL }))[0];
  const drink = (await listVenueMenu('guild-1', { itemType: VenueItemType.DRINK }))[0];

  const result = await createVenueOrder('guild-1', 'customer-1', {
    mealId: meal.id,
    drinkId: drink.id,
    chefId: 'chef-1',
    bartenderId: 'bartender-1',
    date: new Date('2026-05-20T04:00:00.000Z'),
  });
  const mealItem = result.items.find((item) => item.itemType === VenueItemType.MEAL);
  const drinkItem = result.items.find((item) => item.itemType === VenueItemType.DRINK);

  assert.equal(result.items.length, 2);
  assert.equal(mealItem.makerUserId, 'chef-1');
  assert.equal(drinkItem.makerUserId, 'bartender-1');
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
  const chefTasks = await listWorkTasks('guild-1', { userId: 'chef-1', limit: 10 });

  assert.equal(completedMeal.item.status, 'completed');
  assert.equal(completedMeal.item.actualSteps, '熱鍋\n下飯\n調味\n盛盤');
  assert.ok(chefTasks.some((task) => task.taskType === 'casino_venue_meal' && task.status === 'completed'));
});

test('casino venue chef bonus is paid through regular payroll after the tenth completed meal', async () => {
  const job = await startJob('guild-1', 'chef-1', '廚師', 1);
  const meal = (await listVenueMenu('guild-1', { itemType: VenueItemType.MEAL }))[0];
  const baseDate = new Date('2026-05-20T04:00:00.000Z');

  for (let index = 0; index < 11; index += 1) {
    const date = new Date(baseDate.getTime() + index * 1000);
    const order = await createVenueOrder('guild-1', `customer-${index}`, {
      mealId: meal.id,
      chefId: 'chef-1',
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
  const meal = (await listVenueMenu('guild-1', { itemType: VenueItemType.MEAL }))[0];
  const baseDate = new Date('2026-05-20T04:00:00.000Z');

  for (let index = 0; index < 10; index += 1) {
    await createVenueOrder('guild-1', 'customer-1', {
      mealId: meal.id,
      date: new Date(baseDate.getTime() + index * 1000),
    });
  }

  await assert.rejects(
    () =>
      createVenueOrder('guild-1', 'customer-1', {
        mealId: meal.id,
        date: new Date(baseDate.getTime() + 10 * 1000),
      }),
    (error) => error instanceof CoinServiceError && error.code === 'VENUE_ORDER_RATE_LIMIT'
  );
});

test('casino venue expired pending items are completed by npc without creating payroll work', async () => {
  await startJob('guild-1', 'chef-1', '廚師', 1);
  const meal = (await listVenueMenu('guild-1', { itemType: VenueItemType.MEAL }))[0];
  const order = await createVenueOrder('guild-1', 'customer-1', {
    mealId: meal.id,
    chefId: 'chef-1',
    date: new Date('2026-05-20T00:00:00.000Z'),
  });

  assert.equal(order.items[0].status, 'pending');

  const expired = await processExpiredVenueOrderItems({
    date: new Date('2026-05-21T01:00:00.000Z'),
  });
  const history = await listVenueHistory('guild-1', { limit: 1 });
  const tasks = await listWorkTasks('guild-1', { userId: 'chef-1', limit: 10 });

  assert.equal(expired.completedByNpc, 1);
  assert.equal(history[0].status, 'completed');
  assert.equal(history[0].makerIsNpc, true);
  assert.equal(tasks.length, 0);
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
