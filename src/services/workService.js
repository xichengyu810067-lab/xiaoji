const { PermissionFlagsBits } = require('discord.js');
const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const {
  CoinServiceError,
  TransactionType,
  ensureGuildSettings,
  ensurePlayer,
  insertTransaction,
} = require('./coinService');
const logger = require('../utils/logger');

const JOB_TYPES = Object.freeze([
  { name: '會計師', salary: 500, roleName: '小吉會計師' },
  { name: '老師', salary: 400, roleName: '小吉老師' },
  { name: '翻譯官', salary: 300, roleName: '小吉翻譯官' },
  { name: '小幫手', salary: 200, roleName: '小吉小幫手' },
  { name: '清潔工', salary: 100, roleName: '小吉清潔工' },
  { name: '迎賓員', salary: 50, roleName: '小吉迎賓員' },
]);

const JOB_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAID: 'paid',
  CANCELED: 'canceled',
  FAILED: 'failed',
});

const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
  CANCELED: 'cancelled',
  NO_WORK_AVAILABLE: 'no_work_available',
});

const PAYROLL_STATUS = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  CANCELED: 'cancelled',
  FAILED: 'failed',
});

const MIN_WORK_DAYS = 1;
const MAX_WORK_DAYS = 30;
const PAY_TIME_LABEL = '22:00 (台灣時間)';
const WORK_REMINDER_HOURS = 10;
const NO_WORK_PAY_RATIO = 0.75;

function nowIso() {
  return new Date().toISOString();
}

function addHoursIso(dateInput, hours) {
  const date = new Date(dateInput);
  date.setTime(date.getTime() + hours * 60 * 60 * 1000);
  return date.toISOString();
}

function getTaiwanDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function calculatePayTime(startDate, days) {
  const parts = getTaiwanDateParts(new Date(startDate));
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 14, 0, 0)).toISOString();
}

function getJobType(jobName) {
  return JOB_TYPES.find((job) => job.name === jobName) || null;
}

function mapJob(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    jobName: row.job_name,
    jobRoleId: row.job_role_id || null,
    dailySalary: Number(row.daily_salary),
    workDays: Number(row.work_days),
    totalSalary: Number(row.total_salary),
    status: row.status,
    isPaid: Boolean(row.is_paid),
    startAt: row.start_at,
    payAt: row.pay_at,
    actualPaidAt: row.actual_paid_at || null,
    lastContributionAt: row.last_contribution_at || null,
    lastReminderAt: row.last_reminder_at || null,
    todayTaskCount: Number(row.today_task_count || 0),
    todayCompletedTaskCount: Number(row.today_completed_task_count || 0),
    noWorkAvailableToday: Boolean(row.no_work_available_today),
    payrollStatus: row.payroll_status || PAYROLL_STATUS.PENDING,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    jobId: row.job_id === null || row.job_id === undefined ? null : Number(row.job_id),
    jobName: row.job_name,
    taskType: row.task_type,
    status: row.status,
    description: row.description || '',
    createdAt: row.created_at,
    dueAt: row.due_at,
    completedAt: row.completed_at || null,
    reminderCount: Number(row.reminder_count || 0),
    lastReminderAt: row.last_reminder_at || null,
  };
}

function mapPayroll(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    jobId: Number(row.job_id),
    jobName: row.job_name,
    baseSalary: Number(row.base_salary),
    totalTasks: Number(row.total_tasks),
    completedTasks: Number(row.completed_tasks),
    payRatio: Number(row.pay_ratio),
    paidAmount: Number(row.paid_amount),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function normalizeLimit(limit, fallback = 10, max = 25) {
  const value = Number(limit || fallback);

  if (!Number.isSafeInteger(value) || value <= 0) {
    return fallback;
  }

  return Math.min(value, max);
}

function normalizeDescription(value, fallback = '未提供內容') {
  return String(value || '').trim().slice(0, 500) || fallback;
}

function normalizeTaskType(value) {
  return String(value || 'work_report').trim().slice(0, 80) || 'work_report';
}

function calculatePayrollForJob(api, jobRow) {
  const job = mapJob(jobRow);
  const totalTasks = Number(
    api.get(
      `SELECT COUNT(*) AS count
       FROM coin_work_tasks
       WHERE guild_id = ? AND job_id = ? AND status != ?`,
      [job.guildId, job.id, TASK_STATUS.CANCELED]
    ).count || 0
  );
  const completedTasks = Number(
    api.get(
      `SELECT COUNT(*) AS count
       FROM coin_work_tasks
       WHERE guild_id = ? AND job_id = ? AND status = ?`,
      [job.guildId, job.id, TASK_STATUS.COMPLETED]
    ).count || 0
  );
  const noWorkTasks = Number(
    api.get(
      `SELECT COUNT(*) AS count
       FROM coin_work_tasks
       WHERE guild_id = ? AND job_id = ? AND status = ?`,
      [job.guildId, job.id, TASK_STATUS.NO_WORK_AVAILABLE]
    ).count || 0
  );
  const hasNoWorkAvailable = job.noWorkAvailableToday || noWorkTasks > 0 || totalTasks === 0;

  if (hasNoWorkAvailable) {
    return {
      job,
      totalTasks,
      completedTasks,
      payRatio: NO_WORK_PAY_RATIO,
      paidAmount: Math.round(job.totalSalary * NO_WORK_PAY_RATIO),
      reason:
        totalTasks === 0
          ? `沒有可執行的工作任務，發放 75% 基本薪資：${job.totalSalary} x 75%。`
          : `已回報沒有可執行工作，發放 75% 基本薪資：${job.totalSalary} x 75%。`,
      transactionType: TransactionType.BASIC_SALARY,
    };
  }

  const completionRate = completedTasks / totalTasks;
  let payRatio = 0;

  if (completionRate >= 1) {
    payRatio = 1;
  } else if (completionRate >= 0.7) {
    payRatio = 0.8;
  } else if (completionRate >= 0.4) {
    payRatio = 0.5;
  } else if (completionRate > 0) {
    payRatio = 0.2;
  }

  const paidAmount = Math.round(job.totalSalary * payRatio);

  return {
    job,
    totalTasks,
    completedTasks,
    payRatio,
    paidAmount,
    reason:
      completedTasks > 0
        ? `依任務完成級距發薪：${completedTasks}/${totalTasks}，完成率 ${(completionRate * 100).toFixed(1)}%，發薪比例 ${(
            payRatio * 100
          ).toFixed(0)}%。`
        : '有任務但完全未完成，未發放薪資。',
    transactionType: TransactionType.WORK_SALARY,
  };
}

async function listJobs() {
  return {
    jobs: JOB_TYPES,
    minDays: MIN_WORK_DAYS,
    maxDays: MAX_WORK_DAYS,
    payTime: PAY_TIME_LABEL,
  };
}

async function startJob(guildId, userId, jobName, days) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
    }

    const jobType = getJobType(jobName);
    if (!jobType) {
      throw new CoinServiceError('INVALID_JOB', '找不到該職業。');
    }

    const workDays = Math.floor(Number(days));
    if (!Number.isSafeInteger(workDays) || workDays < MIN_WORK_DAYS || workDays > MAX_WORK_DAYS) {
      throw new CoinServiceError('INVALID_DAYS', `工作天數必須介於 ${MIN_WORK_DAYS} 到 ${MAX_WORK_DAYS} 天之間。`);
    }

    ensurePlayer(api, guildId, userId);
    const existingJob = api.get(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ?',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );

    if (existingJob?.job_name === jobType.name) {
      throw new CoinServiceError('HAS_ACTIVE_JOB', '你目前已有相同職業的進行中工作。', {
        job: mapJob(existingJob),
      });
    }

    const timestamp = nowIso();
    let replacedJob = null;

    if (existingJob) {
      replacedJob = mapJob(existingJob);
      api.run(
        'UPDATE coin_jobs SET status = ?, payroll_status = ?, updated_at = ? WHERE id = ?',
        [JOB_STATUS.CANCELED, PAYROLL_STATUS.CANCELED, timestamp, existingJob.id]
      );
      api.run(
        'UPDATE coin_work_tasks SET status = ? WHERE guild_id = ? AND job_id = ? AND status = ?',
        [TASK_STATUS.CANCELED, guildId, existingJob.id, TASK_STATUS.PENDING]
      );
    }

    const payAt = calculatePayTime(timestamp, workDays);
    const totalSalary = jobType.salary * workDays;

    api.run(
      `INSERT INTO coin_jobs (
        guild_id, user_id, job_name, job_role_id, daily_salary, work_days, total_salary,
        status, is_paid, start_at, pay_at, last_contribution_at, today_task_count,
        today_completed_task_count, no_work_available_today, payroll_status, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, NULL, 0, 0, 0, ?, ?, ?)`,
      [
        guildId,
        userId,
        jobType.name,
        jobType.salary,
        workDays,
        totalSalary,
        JOB_STATUS.ACTIVE,
        timestamp,
        payAt,
        PAYROLL_STATUS.PENDING,
        timestamp,
        timestamp,
      ]
    );

    const id = Number(api.get('SELECT last_insert_rowid() AS id').id);
    const job = mapJob(api.get('SELECT * FROM coin_jobs WHERE id = ?', [id]));
    job.replacedJob = replacedJob;
    return job;
  });
}

async function getActiveJob(guildId, userId) {
  return withCoinDatabase((api) => {
    const row = api.get(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ?',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );
    return row ? mapJob(row) : null;
  });
}

async function getWorkStatus(guildId, userId) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    ensurePlayer(api, guildId, userId);
    const job = api.get(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ?',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );
    const latestPayroll = api.get(
      'SELECT * FROM coin_payroll_history WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [guildId, userId]
    );
    const tasks = api
      .all(
        `SELECT *
         FROM coin_work_tasks
         WHERE guild_id = ? AND user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 10`,
        [guildId, userId]
      )
      .map(mapTask);

    return {
      activeJob: job ? mapJob(job) : null,
      latestPayroll: latestPayroll ? mapPayroll(latestPayroll) : null,
      recentTasks: tasks,
    };
  });
}

async function getAllWorkStatuses(guildId, { limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    return api
      .all(
        `SELECT *
         FROM coin_jobs
         WHERE guild_id = ?
         ORDER BY
           CASE status WHEN 'active' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END,
           updated_at DESC,
           id DESC
         LIMIT ?`,
        [guildId, normalizeLimit(limit)]
      )
      .map(mapJob);
  });
}

async function cancelJob(guildId, userId) {
  return withCoinTransaction((api) => {
    const row = api.get(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ?',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );

    if (!row) {
      throw new CoinServiceError('NO_ACTIVE_JOB', '你目前沒有進行中的工作。');
    }

    const timestamp = nowIso();
    api.run(
      'UPDATE coin_jobs SET status = ?, payroll_status = ?, updated_at = ? WHERE id = ?',
      [JOB_STATUS.CANCELED, PAYROLL_STATUS.CANCELED, timestamp, row.id]
    );
    api.run(
      'UPDATE coin_work_tasks SET status = ? WHERE guild_id = ? AND job_id = ? AND status = ?',
      [TASK_STATUS.CANCELED, guildId, row.id, TASK_STATUS.PENDING]
    );

    return mapJob(api.get('SELECT * FROM coin_jobs WHERE id = ?', [row.id]));
  });
}

async function reportWork(guildId, userId, { taskType = 'work_report', description = '', noWorkAvailable = false } = {}) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
    }

    const jobRow = api.get(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ?',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );

    if (!jobRow) {
      throw new CoinServiceError('NO_ACTIVE_JOB', '你目前沒有進行中的工作。');
    }

    const timestamp = nowIso();
    const status = noWorkAvailable ? TASK_STATUS.NO_WORK_AVAILABLE : TASK_STATUS.COMPLETED;
    const taskDescription = normalizeDescription(
      description,
      noWorkAvailable ? '回報目前沒有可執行的工作任務。' : '已回報工作產出。'
    );

    api.run(
      `INSERT INTO coin_work_tasks
        (guild_id, user_id, job_id, job_name, task_type, status, description, created_at, due_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guildId,
        userId,
        jobRow.id,
        jobRow.job_name,
        noWorkAvailable ? 'no_work_available' : normalizeTaskType(taskType),
        status,
        taskDescription,
        timestamp,
        addHoursIso(timestamp, WORK_REMINDER_HOURS),
        timestamp,
      ]
    );
    api.run(
      `UPDATE coin_jobs
       SET last_contribution_at = ?,
           today_task_count = today_task_count + 1,
           today_completed_task_count = today_completed_task_count + ?,
           no_work_available_today = CASE WHEN ? = 1 THEN 1 ELSE no_work_available_today END,
           updated_at = ?
       WHERE id = ?`,
      [timestamp, noWorkAvailable ? 0 : 1, noWorkAvailable ? 1 : 0, timestamp, jobRow.id]
    );

    const taskId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    return {
      job: mapJob(api.get('SELECT * FROM coin_jobs WHERE id = ?', [jobRow.id])),
      task: mapTask(api.get('SELECT * FROM coin_work_tasks WHERE id = ?', [taskId])),
    };
  });
}

async function addPendingTask(guildId, userId, { taskType = 'admin_task', description, dueHours = WORK_REMINDER_HOURS } = {}) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const jobRow = api.get(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ?',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );

    if (!jobRow) {
      throw new CoinServiceError('NO_ACTIVE_JOB', '目標使用者目前沒有進行中的工作。');
    }

    const normalizedDueHours = Number(dueHours || WORK_REMINDER_HOURS);
    if (!Number.isSafeInteger(normalizedDueHours) || normalizedDueHours < 1 || normalizedDueHours > 72) {
      throw new CoinServiceError('INVALID_DUE_HOURS', '提醒時間必須介於 1 到 72 小時之間。');
    }

    const timestamp = nowIso();
    api.run(
      `INSERT INTO coin_work_tasks
        (guild_id, user_id, job_id, job_name, task_type, status, description, created_at, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guildId,
        userId,
        jobRow.id,
        jobRow.job_name,
        normalizeTaskType(taskType),
        TASK_STATUS.PENDING,
        normalizeDescription(description, '管理員指派的工作任務。'),
        timestamp,
        addHoursIso(timestamp, normalizedDueHours),
      ]
    );
    api.run(
      'UPDATE coin_jobs SET today_task_count = today_task_count + 1, updated_at = ? WHERE id = ?',
      [timestamp, jobRow.id]
    );

    const taskId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    return mapTask(api.get('SELECT * FROM coin_work_tasks WHERE id = ?', [taskId]));
  });
}

async function listWorkTasks(guildId, { userId = null, status = null, limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const params = [guildId];
    let where = 'WHERE guild_id = ?';

    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }

    if (status) {
      where += ' AND status = ?';
      params.push(status);
    }

    params.push(normalizeLimit(limit));
    return api
      .all(
        `SELECT *
         FROM coin_work_tasks
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        params
      )
      .map(mapTask);
  });
}

async function previewPayroll(guildId, { userId = null, limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const params = [guildId];
    let where = 'WHERE guild_id = ? AND status = ? AND is_paid = 0';
    params.push(JOB_STATUS.ACTIVE);

    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }

    params.push(normalizeLimit(limit));
    return api
      .all(
        `SELECT *
         FROM coin_jobs
         ${where}
         ORDER BY pay_at ASC, id ASC
         LIMIT ?`,
        params
      )
      .map((row) => calculatePayrollForJob(api, row));
  });
}

async function getPayrollHistory(guildId, { userId = null, limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const params = [guildId];
    let where = 'WHERE guild_id = ?';

    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }

    params.push(normalizeLimit(limit));
    return api
      .all(
        `SELECT *
         FROM coin_payroll_history
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        params
      )
      .map(mapPayroll);
  });
}

async function updateJobRoleId(guildId, jobId, roleId) {
  return withCoinTransaction((api) => {
    const timestamp = nowIso();
    api.run(
      'UPDATE coin_jobs SET job_role_id = ?, updated_at = ? WHERE guild_id = ? AND id = ?',
      [roleId || null, timestamp, guildId, jobId]
    );
  });
}

async function findOrCreateJobRole(guild, roleName) {
  const warnings = [];
  await guild.roles.fetch().catch(() => null);
  const existing = guild.roles.cache.find((role) => role.name === roleName);

  if (existing) {
    return { role: existing, warnings, created: false };
  }

  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));

  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { role: null, warnings: ['小吉缺少管理身分組權限，無法建立職業身分組。'], created: false };
  }

  try {
    const role = await guild.roles.create({
      name: roleName,
      reason: '小吉工作系統職業身分組',
    });
    return { role, warnings, created: true };
  } catch (error) {
    logger.warn(`建立工作身分組失敗：${roleName}`, error);
    return { role: null, warnings: ['小吉建立職業身分組時失敗，請檢查權限與身分組位置。'], created: false };
  }
}

function canManageRole(botMember, role) {
  return Boolean(
    botMember?.permissions.has(PermissionFlagsBits.ManageRoles) &&
      role &&
      !role.managed &&
      role.comparePositionTo(botMember.roles.highest) < 0
  );
}

async function syncJobRoleForMember(member, jobName, { jobId = null } = {}) {
  const jobType = getJobType(jobName);
  const warnings = [];

  if (!jobType) {
    return { ok: false, role: null, warnings: ['找不到這個職業對應的身分組。'] };
  }

  const botMember = member.guild.members.me || (await member.guild.members.fetchMe().catch(() => null));
  const roleResult = await findOrCreateJobRole(member.guild, jobType.roleName);
  warnings.push(...roleResult.warnings);

  if (!roleResult.role || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, role: roleResult.role, warnings };
  }

  const jobRoleNames = new Set(JOB_TYPES.map((job) => job.roleName));
  const currentJobRoles = member.roles.cache.filter((role) => jobRoleNames.has(role.name));

  for (const role of currentJobRoles.values()) {
    if (role.id !== roleResult.role.id && canManageRole(botMember, role)) {
      await member.roles.remove(role, '切換小吉工作職業').catch((error) => {
        logger.warn(`移除舊工作身分組失敗：member=${member.id} role=${role.name}`, error);
        warnings.push(`無法移除舊職業身分組：${role.name}`);
      });
    }
  }

  if (!member.roles.cache.has(roleResult.role.id)) {
    if (!canManageRole(botMember, roleResult.role)) {
      warnings.push(`小吉的最高身分組必須高於 ${roleResult.role.name}，無法給予職業身分組。`);
      return { ok: false, role: roleResult.role, warnings };
    }

    await member.roles.add(roleResult.role, '開始小吉工作').catch((error) => {
      logger.warn(`給予工作身分組失敗：member=${member.id} role=${roleResult.role.name}`, error);
      warnings.push(`無法給予職業身分組：${roleResult.role.name}`);
    });
  }

  if (jobId && roleResult.role) {
    await updateJobRoleId(member.guild.id, jobId, roleResult.role.id).catch((error) => {
      logger.warn(`更新工作身分組 ID 失敗：job=${jobId}`, error);
    });
  }

  return { ok: warnings.length === 0, role: roleResult.role, warnings };
}

async function removeJobRolesForMember(member) {
  const warnings = [];
  const botMember = member.guild.members.me || (await member.guild.members.fetchMe().catch(() => null));
  const jobRoleNames = new Set(JOB_TYPES.map((job) => job.roleName));
  const currentJobRoles = member.roles.cache.filter((role) => jobRoleNames.has(role.name));

  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, warnings: currentJobRoles.size ? ['小吉缺少管理身分組權限，無法移除職業身分組。'] : [] };
  }

  for (const role of currentJobRoles.values()) {
    if (!canManageRole(botMember, role)) {
      warnings.push(`小吉的最高身分組必須高於 ${role.name}，無法移除。`);
      continue;
    }

    await member.roles.remove(role, '結束小吉工作').catch((error) => {
      logger.warn(`移除工作身分組失敗：member=${member.id} role=${role.name}`, error);
      warnings.push(`無法移除職業身分組：${role.name}`);
    });
  }

  return { ok: warnings.length === 0, warnings };
}

async function syncAllJobRoles(guild) {
  const jobs = await getAllWorkStatuses(guild.id, { limit: 25 });
  const activeJobs = jobs.filter((job) => job.status === JOB_STATUS.ACTIVE);
  let synced = 0;
  const warnings = [];

  for (const job of activeJobs) {
    const member = await guild.members.fetch(job.userId).catch(() => null);

    if (!member) {
      warnings.push(`找不到成員 ${job.userId}，略過職業 ${job.jobName}。`);
      continue;
    }

    const result = await syncJobRoleForMember(member, job.jobName, { jobId: job.id });
    if (result.ok) {
      synced++;
    } else {
      warnings.push(...result.warnings.map((warning) => `${member.user.tag}：${warning}`));
    }
  }

  return { synced, total: activeJobs.length, warnings };
}

async function sendWorkReminder(client, row) {
  if (!client) {
    return false;
  }

  const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
  if (!guild) {
    return false;
  }

  const member = await guild.members.fetch(row.user_id).catch(() => null);
  const message = [
    `你在 **${guild.name}** 的小吉工作 **${row.job_name}** 還有待完成任務。`,
    `任務 #${row.id}：${row.description || row.task_type}`,
    '請使用 `/work report` 回報有效產出，或使用 `/work report mode:no-work-available` 回報目前沒有可執行工作。',
  ].join('\n');

  if (member) {
    const sent = await member.send(message).then(() => true).catch(() => false);
    if (sent) {
      return true;
    }
  }

  const channel = guild.systemChannel || guild.channels.cache.find((candidate) => candidate?.isTextBased?.());
  if (!channel?.isTextBased?.()) {
    return false;
  }

  return channel
    .send({
      content: `${member || `<@${row.user_id}>`} ${message}`,
      allowedMentions: { users: [row.user_id] },
    })
    .then(() => true)
    .catch(() => false);
}

async function processWorkReminders(client, { guildId = null, force = false } = {}) {
  const now = nowIso();
  const cutoff = addHoursIso(now, -WORK_REMINDER_HOURS);
  const params = [TASK_STATUS.PENDING, JOB_STATUS.ACTIVE];
  let guildFilter = '';

  if (guildId) {
    guildFilter = 'AND t.guild_id = ?';
    params.push(guildId);
  }

  params.push(force ? 1 : 0, now, force ? 1 : 0, cutoff, force ? 1 : 0, cutoff);
  const rows = await withCoinDatabase((api) =>
    api.all(
      `SELECT t.*, j.last_contribution_at AS job_last_contribution_at, j.last_reminder_at AS job_last_reminder_at
       FROM coin_work_tasks t
       JOIN coin_jobs j ON j.id = t.job_id
       WHERE t.status = ?
         AND j.status = ?
         ${guildFilter}
         AND (? = 1 OR t.due_at <= ?)
         AND (? = 1 OR j.last_contribution_at IS NULL OR j.last_contribution_at <= ?)
         AND (? = 1 OR j.last_reminder_at IS NULL OR j.last_reminder_at <= ?)
       ORDER BY t.due_at ASC
       LIMIT 25`,
      params
    )
  );

  let reminded = 0;

  for (const row of rows) {
    const sent = await sendWorkReminder(client, row);

    await withCoinTransaction((api) => {
      const timestamp = nowIso();
      api.run(
        `UPDATE coin_work_tasks
         SET reminder_count = reminder_count + 1, last_reminder_at = ?
         WHERE id = ?`,
        [timestamp, row.id]
      );
      api.run('UPDATE coin_jobs SET last_reminder_at = ?, updated_at = ? WHERE id = ?', [
        timestamp,
        timestamp,
        row.job_id,
      ]);
    });

    if (sent) {
      reminded++;
    }
  }

  return { checked: rows.length, reminded };
}

async function processDueJobs(client = null) {
  const now = nowIso();
  const dueJobs = await withCoinDatabase((api) =>
    api.all('SELECT * FROM coin_jobs WHERE status = ? AND is_paid = 0 AND pay_at <= ?', [
      JOB_STATUS.ACTIVE,
      now,
    ])
  );

  if (dueJobs.length === 0) {
    return { processed: 0, success: 0, fail: 0 };
  }

  logger.info(`正在處理 ${dueJobs.length} 筆到期工作發薪...`);
  let successCount = 0;
  let failCount = 0;

  for (const jobRow of dueJobs) {
    const job = mapJob(jobRow);

    try {
      const payroll = await withCoinTransaction((api) => {
        const currentJob = api.get(
          'SELECT * FROM coin_jobs WHERE id = ? AND status = ? AND is_paid = 0',
          [job.id, JOB_STATUS.ACTIVE]
        );
        if (!currentJob) {
          return null;
        }

        const timestamp = nowIso();
        api.run(
          `UPDATE coin_work_tasks
           SET status = ?
           WHERE guild_id = ? AND job_id = ? AND status = ?`,
          [TASK_STATUS.EXPIRED, job.guildId, job.id, TASK_STATUS.PENDING]
        );

        const calculated = calculatePayrollForJob(api, currentJob);
        const player = ensurePlayer(api, job.guildId, job.userId);
        const after = player.balance + calculated.paidAmount;

        if (calculated.paidAmount > 0) {
          api.run(
            `UPDATE coin_players
             SET balance = ?, total_earned = total_earned + ?, updated_at = ?
             WHERE guild_id = ? AND user_id = ?`,
            [after, calculated.paidAmount, timestamp, job.guildId, job.userId]
          );
        }

        insertTransaction(api, {
          guildId: job.guildId,
          userId: job.userId,
          type: calculated.transactionType,
          balanceBefore: player.balance,
          amount: calculated.paidAmount,
          balanceAfter: after,
          operatorId: 'system',
          reason: `工作薪資：${job.jobName}，工作 ${job.workDays} 天。${calculated.reason}`,
          metadata: {
            jobId: job.id,
            jobName: job.jobName,
            workDays: job.workDays,
            totalTasks: calculated.totalTasks,
            completedTasks: calculated.completedTasks,
            payRatio: calculated.payRatio,
          },
          createdAt: timestamp,
        });

        api.run(
          `INSERT INTO coin_payroll_history
            (guild_id, user_id, job_id, job_name, base_salary, total_tasks, completed_tasks, pay_ratio, paid_amount, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            job.guildId,
            job.userId,
            job.id,
            job.jobName,
            job.totalSalary,
            calculated.totalTasks,
            calculated.completedTasks,
            calculated.payRatio,
            calculated.paidAmount,
            calculated.reason,
            timestamp,
          ]
        );

        api.run(
          'UPDATE coin_jobs SET status = ?, is_paid = 1, actual_paid_at = ?, payroll_status = ?, updated_at = ? WHERE id = ?',
          [JOB_STATUS.PAID, timestamp, PAYROLL_STATUS.PAID, timestamp, job.id]
        );

        return calculated;
      });

      if (client && payroll) {
        const guild = await client.guilds.fetch(job.guildId).catch(() => null);
        const member = guild ? await guild.members.fetch(job.userId).catch(() => null) : null;
        if (member) {
          await removeJobRolesForMember(member).catch((error) => {
            logger.warn(`發薪後移除工作身分組失敗：job=${job.id}`, error);
          });
        }
      }

      successCount++;
    } catch (error) {
      logger.error(`發放工作薪資失敗 (JobID: ${job.id})`, error);
      failCount++;

      try {
        await withCoinTransaction((api) => {
          const timestamp = nowIso();
          api.run('UPDATE coin_jobs SET status = ?, payroll_status = ?, updated_at = ? WHERE id = ?', [
            JOB_STATUS.FAILED,
            PAYROLL_STATUS.FAILED,
            timestamp,
            job.id,
          ]);
        });
      } catch (updateError) {
        logger.error(`標記工作發薪失敗狀態也失敗 (JobID: ${job.id})`, updateError);
      }
    }
  }

  logger.info(`發薪完成：成功 ${successCount} 筆，失敗 ${failCount} 筆。`);
  return { processed: dueJobs.length, success: successCount, fail: failCount };
}

module.exports = {
  JOB_STATUS,
  JOB_TYPES,
  PAYROLL_STATUS,
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
  processDueJobs,
  processWorkReminders,
  removeJobRolesForMember,
  reportWork,
  startJob,
  syncAllJobRoles,
  syncJobRoleForMember,
};
