const { Events } = require('discord.js');
const { restoreActivePolls } = require('../services/pollService');
const { restoreActiveReminders } = require('../services/reminderService');
const { checkAndAutoLeave, syncExistingGuilds } = require('../services/auditService');
const logger = require('../utils/logger');

module.exports = {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    logger.info(`小吉已登入：${client.user.tag}`);
    logger.info(`已載入 ${client.commands.size} 個 slash commands。`);
    await restoreActivePolls(client);
    await restoreActiveReminders(client);

    // Sync existing guilds (legacy support)
    await syncExistingGuilds(client);

    // Initial audit check and schedule hourly
    void checkAndAutoLeave(client);
    setInterval(() => {
      void checkAndAutoLeave(client);
    }, 60 * 60 * 1000);
  },
};
