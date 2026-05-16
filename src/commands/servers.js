const { SlashCommandBuilder } = require('discord.js');
const { ensureBotOwner } = require('../utils/ownerOnly');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('servers')
    .setDescription('查看小吉目前加入的所有伺服器 (僅限機器人擁有者)'),

  async execute(interaction) {
    const isOwner = await ensureBotOwner(interaction);
    if (!isOwner) return;

    // 回覆需要時間，先 deferReply
    await interaction.deferReply({ ephemeral: true });

    const cachedGuilds = interaction.client.guilds.cache;
    const guildCount = cachedGuilds.size;

    let content = `小吉目前在 ${guildCount} 個伺服器：\n\n`;
    
    let index = 1;
    for (const cachedGuild of cachedGuilds.values()) {
      let serverInfo = `${index}. `;
      
      try {
        const guild = await interaction.client.guilds.fetch({ guild: cachedGuild.id, withCounts: true });
        serverInfo += `${guild.name}\n`;
        serverInfo += `   - ID：${guild.id}\n`;
        serverInfo += `   - 成員數：${guild.approximateMemberCount || guild.memberCount}\n`;
        if (guild.ownerId) {
            serverInfo += `   - 擁有者 ID：${guild.ownerId}\n`;
        }
        if (guild.joinedTimestamp) {
          serverInfo += `   - 加入時間：<t:${Math.floor(guild.joinedTimestamp / 1000)}:F>\n`;
        }
        serverInfo += `   - 狀態：獲取完整資訊成功\n`;
      } catch (error) {
        serverInfo += `${cachedGuild.name}\n`;
        serverInfo += `   - ID：${cachedGuild.id}\n`;
        serverInfo += `   - 狀態：獲取完整資訊失敗\n`;
        serverInfo += `   - 失敗原因：${error.message}\n`;
        if (cachedGuild.unavailable) {
           serverInfo += `   - unavailable：true\n`;
        }
      }
      
      serverInfo += '\n';
      content += serverInfo;
      index++;
    }

    const maxLen = 2000;
    if (content.length <= maxLen) {
      await interaction.editReply({ content });
    } else {
      let currentChunk = '';
      const lines = content.split('\n');
      let isFirstMessage = true;

      for (const line of lines) {
        if (currentChunk.length + line.length + 1 > maxLen) {
          if (isFirstMessage) {
            await interaction.editReply({ content: currentChunk });
            isFirstMessage = false;
          } else {
            await interaction.followUp({ content: currentChunk, ephemeral: true });
          }
          currentChunk = line + '\n';
        } else {
          currentChunk += line + '\n';
        }
      }

      if (currentChunk.trim().length > 0) {
        if (isFirstMessage) {
          await interaction.editReply({ content: currentChunk });
        } else {
          await interaction.followUp({ content: currentChunk, ephemeral: true });
        }
      }
    }
  },
};
