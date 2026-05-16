const { Events } = require('discord.js');
const { handlePollButton } = require('../services/pollService');
const { replyEphemeral } = require('../utils/moderation');
const { isGuildApproved } = require('../services/auditService');
const { isBotOwner } = require('../utils/ownerOnly');
const logger = require('../utils/logger');

const AUDIT_PENDING_MESSAGE = '小吉在這個伺服器尚未通過機器人擁有者的審核，暫時無法提供服務。請耐心等待批准。';

module.exports = {
  name: Events.InteractionCreate,

  async execute(interaction) {
    const isOwner = isBotOwner(interaction.user.id);

    // Audit Check: Skip for DMs or Bot Owner
    if (interaction.guildId && !isOwner) {
      if (!isGuildApproved(interaction.guildId)) {
        // Only block if it's NOT an owner-only management command (starts with admin-)
        // This allows owners to approve/deny servers even from within that server.
        // (Though owners already bypass this via !isOwner, this is extra safety)
        if (!interaction.commandName?.startsWith('admin-')) {
          await replyEphemeral(interaction, AUDIT_PENDING_MESSAGE);
          return;
        }
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith('poll:')) {
      try {
        await handlePollButton(interaction);
      } catch (error) {
        logger.error('poll button handling failed', error);
        await replyEphemeral(interaction, '投票處理失敗，請稍後再試。');
      }
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      await replyEphemeral(interaction, '找不到這個指令，請重新部署 slash commands。');
      return;
    }

    try {
      logger.info(`[COMMAND_REPLY] executing /${interaction.commandName}`);
      await command.execute(interaction);
    } catch (error) {
      logger.error(`/${interaction.commandName} failed`, error);
      await replyEphemeral(interaction, '指令執行失敗，請稍後再試。');
    }
  },
};
