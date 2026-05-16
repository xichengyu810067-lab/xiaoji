const { SlashCommandBuilder } = require('discord.js');
const { addToWhitelist, removeFromWhitelist, getWhitelist } = require('../services/auditService');
const { ensureBotOwner } = require('../utils/ownerOnly');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin-whitelist')
    .setDescription('邀請者白名單管理 (僅限機器人擁有者)')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('新增允許邀請小吉的人')
        .addStringOption((option) =>
          option.setName('user_id').setDescription('Discord 使用者 ID').setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('移除允許邀請小吉的人')
        .addStringOption((option) =>
          option.setName('user_id').setDescription('Discord 使用者 ID').setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('查看目前允許邀請的名單')
    ),

  async execute(interaction) {
    const isOwner = await ensureBotOwner(interaction);
    if (!isOwner) return;

    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    if (subcommand === 'add') {
      const userId = interaction.options.getString('user_id');
      const added = addToWhitelist(userId, interaction.user.id);

      if (added) {
        await interaction.editReply(`已將使用者 \`${userId}\` 新增至邀請者白名單。`);
      } else {
        await interaction.editReply(`使用者 \`${userId}\` 已經在白名單內。`);
      }
      return;
    }

    if (subcommand === 'remove') {
      const userId = interaction.options.getString('user_id');
      const removed = removeFromWhitelist(userId);

      if (removed) {
        await interaction.editReply(`已從白名單移除使用者 \`${userId}\`。`);
      } else {
        await interaction.editReply(`找不到 ID 為 \`${userId}\` 的白名單項目。`);
      }
      return;
    }

    if (subcommand === 'list') {
      const whitelist = getWhitelist();

      if (whitelist.length === 0) {
        await interaction.editReply('目前白名單內沒有任何使用者。');
        return;
      }

      let content = '目前允許邀請小吉的使用者名單：\n\n';
      whitelist.forEach((entry, index) => {
        content += `${index + 1}. \`${entry.userId}\` (新增於 <t:${Math.floor(new Date(entry.addedAt).getTime() / 1000)}:d>)\n`;
      });

      await interaction.editReply(content);
    }
  },
};
