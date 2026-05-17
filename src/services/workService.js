const { withCoinTransaction, withCoinDatabase } = require('./coinDatabase');
const {
  CoinServiceError,
  TransactionType,
  ensureGuildSettings,
  ensurePlayer,
  mapPlayer,
} = require('./coinService');
const logger = require('../utils/logger');

const JOB_TYPES = Object.freeze([
  { name: '會計師', salary: 500 },
  { name: '老師', salary: 400 },
  { name: '翻譯官', salary: 300 },
  { name: '小幫手', salary: 200 },
  { name: '清潔工', salary: 100 },
  { name: '迎賓員', salary: 50 },
]);

const JOB_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAID: 'paid',
  CANCELED: 'canceled',
  FAILED: 'failed',
});

function nowIso() {
  return new Date().toISOString();
}

function getTaiwanTime(date = new Date()) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '-');
}

/**
 * Calculate the pay time: Start Date + Days at 22:00 Taiwan Time.
 */
function calculatePayTime(startDate, days) {
  const date = new Date(startDate);
  // Add days
  date.setDate(date.getDate() + days);
  
  // Set to 22:00:00 Taiwan Time
  // We'll use the ISO string but we need to target the TW 22:00.
  // TW is UTC+8. So TW 22:00 is UTC 14:00.
  const payDateUtc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 14, 0, 0));
  
  // Actually, Date objects work in local time by default, but we want a robust way.
  // Let's use the local components and then adjust for TW.
  // A better way: find the 22:00:00 in Asia/Taipei on that day.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  
  // Construct a date string that specifies the timezone
  const twMidnightStr = `${map.year}-${map.month.padStart(2, '0')}-${map.day.padStart(2, '0')}T22:00:00+08:00`;
  return new Date(twMidnightStr).toISOString();
}

function mapJob(row) {
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    jobName: row.job_name,
    dailySalary: row.daily_salary,
    workDays: row.work_days,
    totalSalary: row.total_salary,
    status: row.status,
    isPaid: Boolean(row.is_paid),
    startAt: row.start_at,
    payAt: row.pay_at,
    actualPaidAt: row.actual_paid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listJobs() {
  return {
    jobs: JOB_TYPES,
    minDays: 1,
    maxDays: 30,
    payTime: '22:00 (台灣時間)',
  };
}

async function startJob(guildId, userId, jobName, days) {
  return withCoinTransaction(async (api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
    }

    const jobType = JOB_TYPES.find(j => j.name === jobName);
    if (!jobType) {
      throw new CoinServiceError('INVALID_JOB', '找不到該職業。');
    }

    const workDays = Math.floor(Number(days));
    if (!Number.isSafeInteger(workDays) || workDays < 1 || workDays > 30) {
      throw new CoinServiceError('INVALID_DAYS', '工作天數必須介於 1 到 30 天之間。');
    }

    // Check for existing active job
    const existingJob = api.get(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ?',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );

    if (existingJob) {
      throw new CoinServiceError('HAS_ACTIVE_JOB', '你目前已有進行中的工作。', {
        job: mapJob(existingJob),
      });
    }

    const timestamp = nowIso();
    const payAt = calculatePayTime(timestamp, workDays);
    const totalSalary = jobType.salary * workDays;

    api.run(
      `INSERT INTO coin_jobs (
        guild_id, user_id, job_name, daily_salary, work_days, total_salary,
        status, is_paid, start_at, pay_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
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
        timestamp,
        timestamp,
      ]
    );

    const id = Number(api.get('SELECT last_insert_rowid() AS id').id);
    return mapJob(api.get('SELECT * FROM coin_jobs WHERE id = ?', [id]));
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

async function cancelJob(guildId, userId) {
  return withCoinTransaction(async (api) => {
    const row = api.get(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ?',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );

    if (!row) {
      throw new CoinServiceError('NO_ACTIVE_JOB', '你目前沒有進行中的工作。');
    }

    const timestamp = nowIso();
    api.run(
      'UPDATE coin_jobs SET status = ?, updated_at = ? WHERE id = ?',
      [JOB_STATUS.CANCELED, timestamp, row.id]
    );

    return mapJob(api.get('SELECT * FROM coin_jobs WHERE id = ?', [row.id]));
  });
}

/**
 * Process due jobs and pay salaries.
 */
async function processDueJobs() {
  const now = nowIso();
  
  // Find all active jobs that have reached their payAt time
  const dueJobs = await withCoinDatabase((api) => {
    return api.all(
      'SELECT * FROM coin_jobs WHERE status = ? AND is_paid = 0 AND pay_at <= ?',
      [JOB_STATUS.ACTIVE, now]
    );
  });

  if (dueJobs.length === 0) {
    return { processed: 0 };
  }

  logger.info(`正在處理 ${dueJobs.length} 筆到期工作發薪...`);
  let successCount = 0;
  let failCount = 0;

  for (const jobRow of dueJobs) {
    const job = mapJob(jobRow);
    try {
      await withCoinTransaction(async (api) => {
        // Re-check status in transaction
        const currentJob = api.get('SELECT * FROM coin_jobs WHERE id = ? AND status = ? AND is_paid = 0', [job.id, JOB_STATUS.ACTIVE]);
        if (!currentJob) return;

        const player = ensurePlayer(api, job.guildId, job.userId);
        const before = player.balance;
        const after = before + job.totalSalary;
        const timestamp = nowIso();

        // Update player balance
        api.run(
          'UPDATE coin_players SET balance = ?, total_earned = total_earned + ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
          [after, job.totalSalary, timestamp, job.guildId, job.userId]
        );

        // Record transaction
        api.run(
          `INSERT INTO coin_transactions
            (guild_id, user_id, type, balance_before, amount, balance_after, operator_id, reason, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            job.guildId,
            job.userId,
            'work_salary',
            before,
            job.totalSalary,
            after,
            'system',
            `工作薪資：${job.jobName}，工作 ${job.workDays} 天`,
            JSON.stringify({ jobId: job.id, jobName: job.jobName, workDays: job.workDays, payAt: job.payAt }),
            timestamp,
          ]
        );

        // Update job status
        api.run(
          'UPDATE coin_jobs SET status = ?, is_paid = 1, actual_paid_at = ?, updated_at = ? WHERE id = ?',
          [JOB_STATUS.PAID, timestamp, timestamp, job.id]
        );
        
        successCount++;
      });
    } catch (error) {
      logger.error(`發放工作薪資失敗 (JobID: ${job.id})`, error);
      failCount++;
      
      try {
        await withCoinTransaction(async (api) => {
          api.run('UPDATE coin_jobs SET status = ?, updated_at = ? WHERE id = ?', [JOB_STATUS.FAILED, nowIso(), job.id]);
        });
      } catch (e) {
        // Ignore update error
      }
    }
  }

  logger.info(`發薪完成：成功 ${successCount} 筆，失敗 ${failCount} 筆。`);
  return { processed: dueJobs.length, success: successCount, fail: failCount };
}

module.exports = {
  JOB_TYPES,
  JOB_STATUS,
  listJobs,
  startJob,
  getActiveJob,
  cancelJob,
  processDueJobs,
};
