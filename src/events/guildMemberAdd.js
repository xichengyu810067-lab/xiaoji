const { Events } = require('discord.js');
const { handleGuildMemberAdd } = require('../services/autoroleService');
const { handleGuildMemberWelcome } = require('../services/welcomeService');
const logger = require('../utils/logger');

module.exports = {
  name: Events.GuildMemberAdd,

  async execute(member) {
    try {
      await handleGuildMemberAdd(member);
    } catch (error) {
      logger.error('autorole handling failed', error);
    }

    try {
      await handleGuildMemberWelcome(member);
    } catch (error) {
      logger.error('welcome handling failed', error);
    }
  },
};
