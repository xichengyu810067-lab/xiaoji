const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  JOB_TYPES,
  listJobs,
  startJob,
  getActiveJob,
  cancelJob,
} = require('../services/workService');
const { formatCoins, replyCoinError } = require('../utils/coinPresentation');

function formatTimestamp(isoString) {
  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:F> (<t:${timestamp}:R>)`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('work')
    .setDescription('小吉工作賺取吉幣系統')
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('顯示所有可選職業與薪水')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('start')
        .setDescription('開始一份工作')
        .addStringOption((option) =>
          option
            .setName('job')
            .setDescription('職業名稱')
            .setRequired(true)
            .addChoices(...JOB_TYPES.map((j) => ({ name: `${j.name} (日薪 ${j.salary})`, value: j.name })))
        )
        .addIntegerOption((option) =>
          option
            .setName('days')
            .setDescription('工作天數 (1-30 天)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(30)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription('查詢自己目前進行中的工作')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('cancel').setDescription('取消目前進行中的工作')
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '工作系統只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'list') {
        const info = await listJobs();
        const lines = info.jobs.map((j) => `• **${j.name}**：每日 ${formatCoins(j.salary)}`);
        
        await interaction.reply({
          content: [
            '**小吉職業清單**',
            ...lines,
            '',
            `• 最短工作天數：${info.minDays} 天`,
            `• 最長工作天數：${info.maxDays} 天`,
            `• 發薪時間：${info.payTime}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'start') {
        const jobName = interaction.options.getString('job', true);
        const days = interaction.options.getInteger('days', true);
        
        const job = await startJob(interaction.guildId, interaction.user.id, jobName, days);
        
        await interaction.reply({
          content: [
            '**工作已開始！**',
            `• 職業：${job.jobName}`,
            `• 天數：${job.workDays} 天`,
            `• 每日薪水：${formatCoins(job.dailySalary)}`,
            `• 預計總薪水：${formatCoins(job.totalSalary)}`,
            `• 預計發薪時間：${formatTimestamp(job.payAt)}`,
          ].join('\n'),
        });
        return;
      }

      if (subcommand === 'status') {
        const job = await getActiveJob(interaction.guildId, interaction.user.id);
        
        if (!job) {
          await interaction.reply({ content: '你目前沒有進行中的工作。使用 `/work start` 來開始工作！', ephemeral: true });
          return;
        }
        
        await interaction.reply({
          content: [
            '**目前工作狀態**',
            `• 職業：${job.jobName}`,
            `• 天數：${job.workDays} 天`,
            `• 每日薪水：${formatCoins(job.dailySalary)}`,
            `• 預計總薪水：${formatCoins(job.totalSalary)}`,
            `• 開始時間：${formatTimestamp(job.startAt)}`,
            `• 預計發薪時間：${formatTimestamp(job.payAt)}`,
            `• 狀態：${job.status === 'active' ? '進行中 🏃' : job.status}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'cancel') {
        const job = await cancelJob(interaction.guildId, interaction.user.id);
        
        await interaction.reply({
          content: `你已取消 **${job.jobName}** 的工作。取消後將不會發放任何薪水。`,
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
