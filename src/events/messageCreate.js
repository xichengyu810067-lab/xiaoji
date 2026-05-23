const { Events } = require('discord.js');
const { handleAutomodMessage } = require('../services/automodService');
const { handleMentionMessage } = require('../services/mentionService');
const { handleMusicLinkMessage } = require('../services/musicService');
const { recordPublicMessage } = require('../services/memoryService');
const { isGuildApproved } = require('../services/auditService');
const { isBotOwner } = require('../utils/ownerOnly');
const logger = require('../utils/logger');

module.exports = {
  name: Events.MessageCreate,

  async execute(message) {
    if (message.author.bot) {
      return;
    }

    // Audit Check
    if (message.guildId && !isBotOwner(message.author.id)) {
      if (!isGuildApproved(message.guildId)) {
        // Only reply if mentioned to avoid spam
        if (message.mentions.has(message.client.user.id)) {
          await message.reply('小吉在這個伺服器尚未通過機器人擁有者的審核，暫時無法提供服務。請耐心等待批准。');
        }
        return;
      }
    }

    try {
      const handledByAutomod = await handleAutomodMessage(message);

      if (handledByAutomod) {
        return;
      }
    } catch (error) {
      logger.error('automod message handling failed', error);
    }

    try {
      const handledByMusic = await handleMusicLinkMessage(message);

      if (handledByMusic) {
        return;
      }
    } catch (error) {
      logger.error('music link handling failed', error);
    }

    try {
      await handleMentionMessage(message);
    } catch (error) {
      logger.error('mention message handling failed', error);
    }

    try {
      recordPublicMessage(message);
    } catch (error) {
      logger.error('public memory recording failed', error);
    }
  },
};
