const { Events } = require('discord.js');
const { restoreActivePolls } = require('../services/pollService');
const { restoreActiveReminders } = require('../services/reminderService');
const { checkAndAutoLeave, syncExistingGuilds } = require('../services/auditService');
const { initializeCoinDatabase } = require('../services/coinDatabase');
const { processDueJobs } = require('../services/workService');
const { processBankInterest } = require('../services/bankService');
const logger = require('../utils/logger');

module.exports = {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    logger.info(`小吉已登入：${client.user.tag}`);
    logger.info(`已載入 ${client.commands.size} 個 slash commands。`);
    try {
      await initializeCoinDatabase();
    } catch (error) {
      logger.error('吉幣系統資料庫載入失敗，吉幣指令會暫時無法使用。', error);
    }

    await restoreActivePolls(client);
    await restoreActiveReminders(client);

    // Sync existing guilds (legacy support)
    await syncExistingGuilds(client);

    // Initial audit check and schedule hourly
    void checkAndAutoLeave(client);
    setInterval(() => {
      void checkAndAutoLeave(client);
    }, 60 * 60 * 1000);

    // Job processing: Initial check and schedule every 5 minutes
    void processDueJobs();
    setInterval(() => {
      void processDueJobs();
    }, 5 * 60 * 1000);

    // Bank interest: Initial check and schedule every 15 minutes
    void processBankInterest();
    setInterval(() => {
      void processBankInterest();
    }, 15 * 60 * 1000);
  },
};
