const { Events } = require('discord.js');
const { restoreActivePolls } = require('../services/pollService');
const { restoreActiveReminders } = require('../services/reminderService');
const { checkAndAutoLeave, syncExistingGuilds } = require('../services/auditService');
const { initializeCoinDatabase } = require('../services/coinDatabase');
const { processDueJobs, processExpiredWorkTasks, processWorkPenaltyAnnouncements, processWorkReminders } = require('../services/workService');
const { processBankInterest } = require('../services/bankService');
const { processCasinoLoanInterest, processExpiredBlackjackSessions } = require('../services/casinoService');
const { processExpiredVenueOrderItems } = require('../services/venueService');
const { initializeLavalink } = require('../services/lavalinkService');
const logger = require('../utils/logger');

async function runStartupTask(label, task) {
  try {
    await task();
  } catch (error) {
    logger.error(`${label} 失敗。`, error);
  }
}

function scheduleStartupTask(label, task, intervalMs) {
  void runStartupTask(label, task);
  const timer = setInterval(() => {
    void runStartupTask(label, task);
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    logger.info(`小吉已登入：${client.user.tag}`);
    logger.info(`已載入 ${client.commands.size} 個 slash commands。`);
    
    await runStartupTask('Lavalink 初始化', () => initializeLavalink(client));
    await runStartupTask('吉幣系統資料庫載入', () => initializeCoinDatabase());
    await runStartupTask('投票資料恢復', () => restoreActivePolls(client));
    await runStartupTask('提醒資料恢復', () => restoreActiveReminders(client));
    await runStartupTask('既有伺服器審核資料同步', () => syncExistingGuilds(client));

    // Initial audit check and schedule hourly
    scheduleStartupTask('伺服器審核逾時檢查', () => checkAndAutoLeave(client), 60 * 60 * 1000);

    // Job processing: Initial check and schedule every 5 minutes
    scheduleStartupTask('工作發薪排程', () => processDueJobs(client), 5 * 60 * 1000);

    // Work reminders: check every hour for pending tasks older than 10 hours.
    scheduleStartupTask('工作提醒排程', () => processWorkReminders(client), 60 * 60 * 1000);

    scheduleStartupTask('逾期工作任務處理', () => processExpiredWorkTasks(client), 15 * 60 * 1000);

    scheduleStartupTask('工作扣薪公告排程', () => processWorkPenaltyAnnouncements(client), 15 * 60 * 1000);

    // Bank interest: Initial check and schedule every 15 minutes
    scheduleStartupTask('銀行活存利息排程', () => processBankInterest(), 15 * 60 * 1000);

    // Casino loans use daily compounding interest; blackjack sessions are refunded after timeout.
    scheduleStartupTask('賭場貸款利息排程', () => processCasinoLoanInterest(), 15 * 60 * 1000);

    scheduleStartupTask('逾期 21 點退款排程', () => processExpiredBlackjackSessions(), 5 * 60 * 1000);

    // Restaurant/bar pending items are taken over by NPC staff after 24 hours.
    scheduleStartupTask('逾期場館訂單處理', () => processExpiredVenueOrderItems(), 15 * 60 * 1000);
  },
};
