const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  JOB_TYPES,
  TASK_STATUS,
  addPendingTask,
  cancelJob,
  getActiveJob,
  getAllWorkStatuses,
  getPayrollHistory,
  getWorkStatus,
  listJobs,
  listWorkTasks,
  previewPayroll,
  processWorkReminders,
  removeJobRolesForMember,
  reportWork,
  startJob,
  syncAllJobRoles,
  syncJobRoleForMember,
} = require('../services/workService');
const { formatCoins, formatUser, replyCoinError } = require('../utils/coinPresentation');
const { ensureModerationAccess } = require('../utils/moderation');

const taskStatusChoices = [
  { name: '待完成', value: TASK_STATUS.PENDING },
  { name: '已完成', value: TASK_STATUS.COMPLETED },
  { name: '已逾期', value: TASK_STATUS.EXPIRED },
  { name: '已取消', value: TASK_STATUS.CANCELED },
  { name: '無工作可做', value: TASK_STATUS.NO_WORK_AVAILABLE },
];

function formatTimestamp(isoString) {
  if (!isoString) {
    return '無';
  }

  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:F> (<t:${timestamp}:R>)`;
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function statusLabel(status) {
  const labels = {
    active: '進行中',
    paid: '已發薪',
    canceled: '已取消',
    failed: '發薪失敗',
    pending: '待完成',
    completed: '已完成',
    expired: '已逾期',
    cancelled: '已取消',
    no_work_available: '無工作可做',
  };

  return labels[status] || status || '未知';
}

function addOptionalUserLimitOptions(subcommand) {
  return subcommand
    .addUserOption((option) => option.setName('user').setDescription('要查詢的使用者'))
    .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25));
}

function addTaskStatusOption(subcommand) {
  return subcommand.addStringOption((option) =>
    option.setName('status').setDescription('任務狀態').addChoices(...taskStatusChoices)
  );
}

function formatRoleWarnings(warnings) {
  if (!warnings?.length) {
    return [];
  }

  return ['', '**身分組提醒**', ...warnings.map((warning) => `• ${warning}`)];
}

function formatJobBlock(job, { includeUser = false } = {}) {
  if (!job) {
    return '目前沒有進行中的工作。';
  }

  return [
    includeUser ? `使用者：<@${job.userId}>` : null,
    `職業：${job.jobName}`,
    `天數：${job.workDays} 天`,
    `每日薪水：${formatCoins(job.dailySalary)}`,
    `預計總薪水：${formatCoins(job.totalSalary)}`,
    `開始時間：${formatTimestamp(job.startAt)}`,
    `預計發薪：${formatTimestamp(job.payAt)}`,
    `狀態：${statusLabel(job.status)}`,
    `任務數：${job.todayTaskCount}，已完成：${job.todayCompletedTaskCount}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatTaskLine(task) {
  return [
    `#${task.id}`,
    `<@${task.userId}>`,
    task.jobName,
    statusLabel(task.status),
    task.description || task.taskType,
    `建立 ${formatTimestamp(task.createdAt)}`,
    task.status === TASK_STATUS.PENDING ? `到期 ${formatTimestamp(task.dueAt)}` : null,
  ]
    .filter(Boolean)
    .join('｜');
}

function formatPayrollLine(payroll) {
  return [
    `#${payroll.id}`,
    `<@${payroll.userId}>`,
    payroll.jobName,
    `發放 ${formatCoins(payroll.paidAmount)}`,
    `比例 ${formatPercent(payroll.payRatio)}`,
    `任務 ${payroll.completedTasks}/${payroll.totalTasks}`,
    formatTimestamp(payroll.createdAt),
    payroll.reason,
  ].join('｜');
}

function formatPayrollPreviewLine(item) {
  return [
    `<@${item.job.userId}>`,
    item.job.jobName,
    `預估 ${formatCoins(item.paidAmount)} / ${formatCoins(item.job.totalSalary)}`,
    `比例 ${formatPercent(item.payRatio)}`,
    `任務 ${item.completedTasks}/${item.totalTasks}`,
    `發薪 ${formatTimestamp(item.job.payAt)}`,
    item.reason,
  ].join('｜');
}

async function ensureAdmin(interaction) {
  return ensureModerationAccess(interaction, {
    userPermission: PermissionFlagsBits.Administrator,
    userPermissionName: 'Administrator',
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('work')
    .setDescription('小吉工作賺取吉幣系統')
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('顯示所有可選職業與薪水'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('start')
        .setDescription('開始或切換一份工作')
        .addStringOption((option) =>
          option
            .setName('job')
            .setDescription('職業名稱')
            .setRequired(true)
            .addChoices(...JOB_TYPES.map((job) => ({ name: `${job.name} (日薪 ${job.salary})`, value: job.name })))
        )
        .addIntegerOption((option) =>
          option.setName('days').setDescription('工作天數 (1-30 天)').setRequired(true).setMinValue(1).setMaxValue(30)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查詢自己目前進行中的工作'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status-user')
        .setDescription('管理員查詢指定使用者工作狀態')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status-all')
        .setDescription('管理員查詢伺服器工作紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) => subcommand.setName('cancel').setDescription('取消目前進行中的工作'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('report')
        .setDescription('回報工作產出或回報目前沒有可執行工作')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('回報類型')
            .addChoices(
              { name: '完成工作', value: 'completed' },
              { name: '目前沒有可執行工作', value: 'no-work-available' }
            )
        )
        .addStringOption((option) => option.setName('task-type').setDescription('任務類型，例如公告、翻譯、整理').setMaxLength(80))
        .addStringOption((option) => option.setName('description').setDescription('工作內容摘要').setMaxLength(500))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('task-add')
        .setDescription('管理員指派一筆待完成工作任務')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
        .addStringOption((option) => option.setName('description').setDescription('任務內容').setRequired(true).setMaxLength(500))
        .addStringOption((option) => option.setName('task-type').setDescription('任務類型').setMaxLength(80))
        .addIntegerOption((option) =>
          option.setName('due-hours').setDescription('幾小時後提醒，預設 10').setMinValue(1).setMaxValue(72)
        )
    )
    .addSubcommand((subcommand) =>
      addTaskStatusOption(
        subcommand
          .setName('tasks')
          .setDescription('查詢自己的工作任務紀錄')
          .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
      )
    )
    .addSubcommand((subcommand) =>
      addTaskStatusOption(
        addOptionalUserLimitOptions(subcommand.setName('tasks-all').setDescription('管理員查詢工作任務紀錄'))
      )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('admin-remind')
        .setDescription('管理員手動檢查並發送工作提醒')
        .addBooleanOption((option) => option.setName('force').setDescription('是否忽略 10 小時間隔直接提醒'))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('role-sync')
        .setDescription('同步工作職業身分組')
        .addUserOption((option) => option.setName('user').setDescription('只同步指定使用者'))
    )
    .addSubcommand((subcommand) =>
      addOptionalUserLimitOptions(subcommand.setName('payroll-preview').setDescription('管理員預覽目前工作發薪結果'))
    )
    .addSubcommand((subcommand) =>
      addOptionalUserLimitOptions(subcommand.setName('payroll-history').setDescription('管理員查詢工作發薪紀錄'))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '工作系統只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      const adminSubcommands = new Set([
        'status-user',
        'status-all',
        'task-add',
        'tasks-all',
        'admin-remind',
        'role-sync',
        'payroll-preview',
        'payroll-history',
      ]);

      if (adminSubcommands.has(subcommand)) {
        const access = await ensureAdmin(interaction);
        if (!access.ok) {
          return;
        }
      }

      if (subcommand === 'list') {
        const info = await listJobs();
        const lines = info.jobs.map((job) => `• **${job.name}**：每日 ${formatCoins(job.salary)}｜身分組：${job.roleName}`);

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
        await interaction.deferReply();
        const jobName = interaction.options.getString('job', true);
        const days = interaction.options.getInteger('days', true);
        const job = await startJob(interaction.guildId, interaction.user.id, jobName, days);
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const roleResult = member ? await syncJobRoleForMember(member, job.jobName, { jobId: job.id }) : { warnings: ['找不到你的成員資料，無法同步職業身分組。'] };

        await interaction.editReply({
          content: [
            '**工作已開始！**',
            job.replacedJob ? `已切換職業：${job.replacedJob.jobName} -> ${job.jobName}` : `職業：${job.jobName}`,
            `天數：${job.workDays} 天`,
            `每日薪水：${formatCoins(job.dailySalary)}`,
            `預計總薪水：${formatCoins(job.totalSalary)}`,
            `預計發薪時間：${formatTimestamp(job.payAt)}`,
            roleResult.role ? `職業身分組：${roleResult.role}` : null,
            ...formatRoleWarnings(roleResult.warnings),
          ]
            .filter(Boolean)
            .join('\n'),
        });
        return;
      }

      if (subcommand === 'status') {
        const status = await getWorkStatus(interaction.guildId, interaction.user.id);

        await interaction.reply({
          content: [
            '**目前工作狀態**',
            formatJobBlock(status.activeJob),
            status.latestPayroll ? ['', '**最近發薪紀錄**', formatPayrollLine(status.latestPayroll)].join('\n') : null,
            status.recentTasks.length ? ['', '**最近任務**', ...status.recentTasks.slice(0, 5).map(formatTaskLine)].join('\n') : null,
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'status-user') {
        const user = interaction.options.getUser('user', true);
        const status = await getWorkStatus(interaction.guildId, user.id);

        await interaction.reply({
          content: [
            `**${formatUser(user)} 的工作狀態**`,
            formatJobBlock(status.activeJob, { includeUser: false }),
            status.latestPayroll ? ['', '**最近發薪紀錄**', formatPayrollLine(status.latestPayroll)].join('\n') : null,
            status.recentTasks.length ? ['', '**最近任務**', ...status.recentTasks.slice(0, 8).map(formatTaskLine)].join('\n') : null,
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'status-all') {
        const limit = interaction.options.getInteger('limit') || 10;
        const jobs = await getAllWorkStatuses(interaction.guildId, { limit });
        const lines = jobs.map((job) => `#${job.id}｜${formatJobBlock(job, { includeUser: true }).replaceAll('\n', '｜')}`);

        await interaction.reply({
          content: jobs.length ? ['**伺服器工作紀錄**', ...lines].join('\n') : '目前沒有工作紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        const job = await cancelJob(interaction.guildId, interaction.user.id);
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const roleResult = member ? await removeJobRolesForMember(member) : { warnings: ['找不到你的成員資料，無法移除職業身分組。'] };

        await interaction.editReply({
          content: [
            `你已取消 **${job.jobName}** 的工作。取消後將不會發放任何薪水。`,
            ...formatRoleWarnings(roleResult.warnings),
          ].join('\n'),
        });
        return;
      }

      if (subcommand === 'report') {
        const mode = interaction.options.getString('mode') || 'completed';
        const result = await reportWork(interaction.guildId, interaction.user.id, {
          taskType: interaction.options.getString('task-type') || 'work_report',
          description: interaction.options.getString('description') || '',
          noWorkAvailable: mode === 'no-work-available',
        });

        await interaction.reply({
          content: [
            mode === 'no-work-available' ? '已記錄：目前沒有可執行工作。' : '工作回報已記錄。',
            `職業：${result.job.jobName}`,
            `任務：#${result.task.id} ${statusLabel(result.task.status)}`,
            `內容：${result.task.description}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'task-add') {
        const user = interaction.options.getUser('user', true);
        const task = await addPendingTask(interaction.guildId, user.id, {
          description: interaction.options.getString('description', true),
          taskType: interaction.options.getString('task-type') || 'admin_task',
          dueHours: interaction.options.getInteger('due-hours') || 10,
        });

        await interaction.reply({
          content: ['工作任務已指派。', formatTaskLine(task)].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'tasks' || subcommand === 'tasks-all') {
        const user = subcommand === 'tasks-all' ? interaction.options.getUser('user') : interaction.user;
        const status = interaction.options.getString('status');
        const limit = interaction.options.getInteger('limit') || 10;
        const tasks = await listWorkTasks(interaction.guildId, {
          userId: user?.id || null,
          status,
          limit,
        });

        await interaction.reply({
          content: tasks.length ? ['**工作任務紀錄**', ...tasks.map(formatTaskLine)].join('\n') : '目前沒有符合條件的工作任務紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'admin-remind') {
        await interaction.deferReply({ ephemeral: true });
        const force = interaction.options.getBoolean('force') || false;
        const result = await processWorkReminders(interaction.client, { guildId: interaction.guildId, force });

        await interaction.editReply(`提醒檢查完成：檢查 ${result.checked} 筆，成功送出 ${result.reminded} 筆。`);
        return;
      }

      if (subcommand === 'role-sync') {
        await interaction.deferReply({ ephemeral: true });
        const user = interaction.options.getUser('user');

        if (user) {
          const job = await getActiveJob(interaction.guildId, user.id);
          if (!job) {
            await interaction.editReply(`${formatUser(user)} 目前沒有進行中的工作。`);
            return;
          }

          const member = await interaction.guild.members.fetch(user.id).catch(() => null);
          if (!member) {
            await interaction.editReply(`找不到 ${formatUser(user)} 的伺服器成員資料。`);
            return;
          }

          const result = await syncJobRoleForMember(member, job.jobName, { jobId: job.id });
          await interaction.editReply([
            `${formatUser(user)} 的職業身分組同步完成。`,
            result.role ? `職業身分組：${result.role}` : null,
            ...formatRoleWarnings(result.warnings),
          ].filter(Boolean).join('\n'));
          return;
        }

        const result = await syncAllJobRoles(interaction.guild);
        await interaction.editReply([
          `工作身分組同步完成：${result.synced}/${result.total}`,
          ...formatRoleWarnings(result.warnings.slice(0, 10)),
        ].join('\n'));
        return;
      }

      if (subcommand === 'payroll-preview') {
        const user = interaction.options.getUser('user');
        const limit = interaction.options.getInteger('limit') || 10;
        const items = await previewPayroll(interaction.guildId, { userId: user?.id || null, limit });

        await interaction.reply({
          content: items.length ? ['**工作發薪預覽**', ...items.map(formatPayrollPreviewLine)].join('\n') : '目前沒有可預覽的工作發薪資料。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'payroll-history') {
        const user = interaction.options.getUser('user');
        const limit = interaction.options.getInteger('limit') || 10;
        const history = await getPayrollHistory(interaction.guildId, { userId: user?.id || null, limit });

        await interaction.reply({
          content: history.length ? ['**工作發薪紀錄**', ...history.map(formatPayrollLine)].join('\n') : '目前沒有工作發薪紀錄。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
