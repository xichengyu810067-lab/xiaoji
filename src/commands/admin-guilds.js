const { SlashCommandBuilder } = require('discord.js');
const { AuditStatus, setGuildAudit, getGuildAudit } = require('../services/auditService');
const { ensureBotOwner } = require('../utils/ownerOnly');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin-guilds')
    .setDescription('伺服器審核與管理 (僅限機器人擁有者)')
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('列出所有伺服器及其審核狀態')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('pending').setDescription('列出所有待審核的伺服器')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('approve')
        .setDescription('批准小吉留在指定伺服器')
        .addStringOption((option) =>
          option.setName('guild_id').setDescription('伺服器 ID').setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('deny')
        .setDescription('拒絕小吉留在指定伺服器並離開')
        .addStringOption((option) =>
          option.setName('guild_id').setDescription('伺服器 ID').setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('leave')
        .setDescription('讓小吉離開指定伺服器')
        .addStringOption((option) =>
          option.setName('guild_id').setDescription('伺服器 ID').setRequired(true)
        )
    ),

  async execute(interaction) {
    const isOwner = await ensureBotOwner(interaction);
    if (!isOwner) return;

    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    if (subcommand === 'list' || subcommand === 'pending') {
      const cachedGuilds = interaction.client.guilds.cache;
      let content = subcommand === 'list' ? '小吉目前所在的伺服器清單：\n\n' : '小吉待審核的伺服器清單：\n\n';
      let count = 0;

      for (const guild of cachedGuilds.values()) {
        const audit = getGuildAudit(guild.id);
        const status = audit?.status || AuditStatus.UNKNOWN;

        if (subcommand === 'pending' && status !== AuditStatus.PENDING && status !== AuditStatus.UNKNOWN) {
          continue;
        }

        count++;
        content += `${count}. **${guild.name}** (\`${guild.id}\`)\n`;
        content += `   - 狀態：${status}\n`;
        if (audit?.inviterId) {
          content += `   - 邀請者：\`${audit.inviterId}\`\n`;
        }
        if (audit?.addedAt) {
          content += `   - 加入時間：<t:${Math.floor(new Date(audit.addedAt).getTime() / 1000)}:F>\n`;
        }
        content += '\n';
      }

      if (count === 0) {
        content = subcommand === 'list' ? '小吉目前不在任何伺服器。' : '目前沒有待審核的伺服器。';
      }

      // Handle message length
      if (content.length <= 2000) {
        await interaction.editReply(content);
      } else {
        await interaction.editReply('伺服器清單太長，請查看後續訊息。');
        const chunks = content.match(/[\s\S]{1,2000}/g) || [];
        for (const chunk of chunks) {
          await interaction.followUp({ content: chunk, ephemeral: true });
        }
      }
      return;
    }

    const guildId = interaction.options.getString('guild_id');
    const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);

    if (subcommand === 'approve') {
      if (!guild) {
        await interaction.editReply(`找不到 ID 為 \`${guildId}\` 的伺服器。`);
        return;
      }

      setGuildAudit(guildId, {
        status: AuditStatus.APPROVED,
        name: guild.name,
      });

      await interaction.editReply(`已批准小吉留在伺服器：**${guild.name}** (\`${guildId}\`)。`);
      logger.info(`Guild ${guildId} approved by owner`);
      return;
    }

    if (subcommand === 'deny' || subcommand === 'leave') {
      if (!guild) {
        // Even if not in cache/fetchable, we might still want to set it as denied to prevent future joins
        setGuildAudit(guildId, {
          status: AuditStatus.DENIED,
          reason: subcommand === 'deny' ? 'Owner denied' : 'Owner manual leave',
        });
        await interaction.editReply(`已將伺服器 \`${guildId}\` 設為拒絕狀態（小吉目前似乎不在該伺服器）。`);
        return;
      }

      const guildName = guild.name;
      try {
        await guild.leave();
        setGuildAudit(guildId, {
          status: AuditStatus.DENIED,
          name: guildName,
          reason: subcommand === 'deny' ? 'Owner denied' : 'Owner manual leave',
        });
        await interaction.editReply(`小吉已離開伺服器：**${guildName}** (\`${guildId}\`)，狀態設為 \`denied\`。`);
        logger.info(`Xiaoji left guild ${guildId} (action: ${subcommand})`);
      } catch (error) {
        logger.error(`Failed to leave guild ${guildId}`, error);
        await interaction.editReply(`嘗試離開伺服器失敗：${error.message}`);
      }
    }
  },
};
