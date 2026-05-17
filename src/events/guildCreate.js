const { Events, AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const { AuditStatus, setGuildAudit, isWhitelisted } = require('../services/auditService');
const logger = require('../utils/logger');

module.exports = {
  name: Events.GuildCreate,

  async execute(guild) {
    logger.info(`Joined new guild: ${guild.name} (${guild.id})`);

    let inviterId = null;
    let inviterStatus = '無法確認邀請者';

    // Attempt to find the inviter from audit logs
    if (guild.members.me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      try {
        const auditLogs = await guild.fetchAuditLogs({
          limit: 1,
          type: AuditLogEvent.BotAdd,
        });
        const botAddLog = auditLogs.entries.first();

        if (botAddLog && botAddLog.target?.id === guild.members.me.id) {
          inviterId = botAddLog.executor?.id;
        }
      } catch (error) {
        logger.warn(`Failed to fetch audit logs for guild ${guild.id}: ${error.message}`);
      }
    }

    const whitelisted = inviterId ? isWhitelisted(inviterId) : false;
    const status = whitelisted ? AuditStatus.PENDING : AuditStatus.UNKNOWN;

    if (inviterId) {
      inviterStatus = whitelisted ? `邀請者在白名單內 (${inviterId})` : `邀請者不在白名單內 (${inviterId})`;
    }

    setGuildAudit(guild.id, {
      status,
      name: guild.name,
      inviterId,
      joinedAt: guild.joinedAt,
    });

    // Notify owner
    const ownerId = process.env.BOT_OWNER_ID;
    if (ownerId) {
      try {
        const owner = await guild.client.users.fetch(ownerId);
        if (owner) {
          const content = [
            `小吉加入了新的伺服器！`,
            `伺服器名稱：**${guild.name}**`,
            `伺服器 ID：\`${guild.id}\``,
            `邀請者：${inviterStatus}`,
            `目前狀態：**${status === AuditStatus.PENDING ? '待審核' : '未知來源 (待審核)'}**`,
            `請使用 \`/admin-guilds approve guild_id:${guild.id}\` 來批准，`,
            `或 \`/admin-guilds deny guild_id:${guild.id}\` 來拒絕並離開。`,
          ].join('\n');

          await owner.send(content);
        }
      } catch (error) {
        logger.error(`Failed to notify owner about new guild join: ${error.message}`);
      }
    }
  },
};
