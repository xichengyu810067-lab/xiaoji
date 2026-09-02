const packageJson = require('../../package.json');
const { getTaipeiDateKey } = require('../utils/taipeiClock');
const logger = require('../utils/logger');
const {
  listFeatureHealth,
  listFeatureUsageForDate,
  recordFeatureUsage,
} = require('./featurePlatformService');

const PUBLIC_STATUS_SCHEMA_VERSION = 1;
const PUBLIC_USAGE_FEATURE_KEY = 'public_website';
const PUBLIC_USAGE_METRIC_KEY = 'accepted';

const PUBLIC_FEATURES = Object.freeze([
  { key: 'core_chat', name: '小吉聊天', category: '核心服務', type: 'ready', critical: true },
  { key: 'moderation', name: '伺服器管理', category: '管理工具', commands: ['clear', 'timeout', 'kick', 'ban'], critical: true },
  { key: 'welcome', name: '新人歡迎', category: '管理工具', commands: ['set-welcome'] },
  { key: 'reminder', name: '提醒服務', category: '實用工具', commands: ['remind'] },
  { key: 'calendar', name: '行事曆', category: '實用工具', commands: ['calendar'] },
  { key: 'poll', name: '投票', category: '社群互動', commands: ['poll'] },
  { key: 'weather', name: '天氣查詢', category: '實用工具', commands: ['weather'] },
  { key: 'economy', name: '吉幣系統', category: '吉幣與遊戲', commands: ['coins', 'daily', 'economy'], critical: true, requiresDatabase: true },
  { key: 'word_chain', name: '文字接龍', category: '社群互動', commands: ['word-chain'], healthKey: 'word_chain' },
  { key: 'number_chain', name: '數字接龍', category: '社群互動', commands: ['number-chain'], healthKey: 'number_chain' },
  { key: 'daily_riddle', name: '每日猜謎', category: '每日活動', commands: ['daily-riddle'], healthKey: 'daily_riddle' },
  { key: 'daily_discussion', name: '每日議題', category: '每日活動', commands: ['daily-discussion'], healthKey: 'daily_discussion' },
  { key: 'chat_style', name: '對話風格', category: '聊天個人化', commands: ['chat-style'], healthKey: 'conversation_style' },
  { key: 'romance', name: '情侶模式', category: '聊天個人化', commands: ['romance'], healthKey: 'romance' },
  { key: 'tetris', name: '俄羅斯方塊', category: '吉幣與遊戲', commands: ['games'], healthKey: 'tetris', requiresHealth: true },
  { key: 'number_match', name: '數字配對', category: '吉幣與遊戲', commands: ['games'], healthKey: 'number_match', requiresHealth: true },
  { key: 'sudoku', name: '數獨', category: '吉幣與遊戲', commands: ['games'], healthKey: 'sudoku', requiresHealth: true },
  { key: 'official_website', name: '小吉官網', category: '網站服務', healthKey: 'public_website', staticReady: true },
  { key: 'status_website', name: '即時狀態網站', category: '網站服務', healthKey: 'status_website', staticReady: true },
  { key: 'release_announcements', name: '版本發布公告', category: '版本服務', healthKey: 'release_announcements', pending: true },
]);

const PUBLIC_STATUS_DETAILS = Object.freeze({
  normal: '功能目前可使用',
  maintenance: '功能正在維護或尚未啟用',
  broken: '功能目前發生異常',
});

function isClientReady(client) {
  try {
    return typeof client?.isReady === 'function' ? client.isReady() : Boolean(client?.readyAt);
  } catch (_error) {
    return false;
  }
}

function areCommandsLoaded(client, commandNames = []) {
  return commandNames.length > 0 && commandNames.every((commandName) => client?.commands?.has?.(commandName));
}

function normalizeHealthRows(rows) {
  const allowedStatuses = new Set(['normal', 'maintenance', 'broken']);
  const map = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.featureKey !== 'string' || !allowedStatuses.has(row.status)) continue;
    map.set(row.featureKey, {
      status: row.status,
      updatedAt: Number.isFinite(Date.parse(row.updatedAt)) ? new Date(row.updatedAt).toISOString() : null,
    });
  }

  return map;
}

function getProbeStatus(feature, client, ready) {
  if (feature.pending) return 'maintenance';
  if (feature.type === 'ready') return ready ? 'normal' : 'broken';
  if (!ready) return 'maintenance';
  if (feature.staticReady) return 'normal';
  return areCommandsLoaded(client, feature.commands) ? 'normal' : 'broken';
}

function buildFeatureStatuses(
  client,
  healthRows,
  { healthAvailable = true, databaseAvailable = healthAvailable, now = new Date() } = {}
) {
  const ready = isClientReady(client);
  const health = normalizeHealthRows(healthRows);

  return PUBLIC_FEATURES.map((feature) => {
    const override = feature.healthKey ? health.get(feature.healthKey) : null;
    const probeStatus = getProbeStatus(feature, client, ready);
    let status = probeStatus;

    if (override?.status === 'broken' || override?.status === 'maintenance') {
      status = override.status;
    } else if (override?.status === 'normal' && probeStatus === 'normal') {
      status = 'normal';
    }

    if (!healthAvailable && feature.healthKey && status === 'normal') {
      status = 'maintenance';
    }
    if (feature.requiresHealth && !override && status === 'normal') {
      status = 'maintenance';
    }
    if (!databaseAvailable && feature.requiresDatabase && status === 'normal') {
      status = 'maintenance';
    }

    return {
      key: feature.key,
      name: feature.name,
      category: feature.category,
      status,
      detail: PUBLIC_STATUS_DETAILS[status],
      updatedAt: override?.updatedAt || now.toISOString(),
      critical: Boolean(feature.critical),
    };
  });
}

function summarizeFeatures(features) {
  return features.reduce(
    (summary, feature) => {
      summary[feature.status] += 1;
      return summary;
    },
    { normal: 0, maintenance: 0, broken: 0 }
  );
}

function getOverallBotStatus(client, features) {
  if (!isClientReady(client)) return 'outage';
  if (features.some((feature) => feature.critical && feature.status === 'broken')) return 'outage';
  if (features.some((feature) => feature.status === 'broken')) return 'degraded';
  if (features.some((feature) => feature.critical && feature.status === 'maintenance')) return 'degraded';
  return 'operational';
}

function getTodayInteractionCount(rows) {
  const row = (Array.isArray(rows) ? rows : []).find(
    (item) => item?.featureKey === PUBLIC_USAGE_FEATURE_KEY && item?.metricKey === PUBLIC_USAGE_METRIC_KEY
  );
  return Number.isSafeInteger(row?.usageCount) && row.usageCount >= 0 ? row.usageCount : 0;
}

async function loadPublicStatusData(now, { healthReader = listFeatureHealth, usageReader = listFeatureUsageForDate } = {}) {
  const usageDate = getTaipeiDateKey(now);
  const [healthResult, usageResult] = await Promise.allSettled([healthReader(), usageReader(usageDate)]);

  return {
    usageDate,
    healthRows: healthResult.status === 'fulfilled' ? healthResult.value : [],
    healthAvailable: healthResult.status === 'fulfilled',
    usageRows: usageResult.status === 'fulfilled' ? usageResult.value : [],
    usageAvailable: usageResult.status === 'fulfilled',
  };
}

async function buildPublicStatusSnapshot(client, { now = new Date(), healthReader, usageReader } = {}) {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? new Date(now.getTime()) : new Date();
  const data = await loadPublicStatusData(safeNow, { healthReader, usageReader });
  const features = buildFeatureStatuses(client, data.healthRows, {
    healthAvailable: data.healthAvailable,
    databaseAvailable: data.healthAvailable && data.usageAvailable,
    now: safeNow,
  });
  const ping = Number(client?.ws?.ping);

  return {
    schemaVersion: PUBLIC_STATUS_SCHEMA_VERSION,
    updatedAt: safeNow.toISOString(),
    timezone: 'Asia/Taipei',
    bot: {
      status: getOverallBotStatus(client, features),
      version: packageJson.version,
      latencyMs: Number.isFinite(ping) && ping >= 0 ? Math.round(ping) : null,
    },
    guilds: {
      adoptedCount: Number.isSafeInteger(client?.guilds?.cache?.size) && client.guilds.cache.size >= 0
        ? client.guilds.cache.size
        : null,
    },
    usage: {
      date: data.usageDate,
      todayInteractions: data.usageAvailable ? getTodayInteractionCount(data.usageRows) : null,
      available: data.usageAvailable,
    },
    summary: summarizeFeatures(features),
    features,
  };
}

async function buildPublicOverviewSnapshot(client, options = {}) {
  const snapshot = await buildPublicStatusSnapshot(client, options);
  return {
    schemaVersion: snapshot.schemaVersion,
    updatedAt: snapshot.updatedAt,
    timezone: snapshot.timezone,
    bot: snapshot.bot,
    guilds: snapshot.guilds,
    usage: snapshot.usage,
    summary: snapshot.summary,
  };
}

async function recordPublicInteraction(now = new Date(), { recorder = recordFeatureUsage, loggerImpl = logger } = {}) {
  try {
    await recorder(PUBLIC_USAGE_FEATURE_KEY, PUBLIC_USAGE_METRIC_KEY, 1, now);
    return true;
  } catch (_error) {
    loggerImpl.warn('[PUBLIC_STATUS] Interaction aggregate update failed.');
    return false;
  }
}

module.exports = {
  PUBLIC_FEATURES,
  PUBLIC_STATUS_SCHEMA_VERSION,
  PUBLIC_USAGE_FEATURE_KEY,
  PUBLIC_USAGE_METRIC_KEY,
  buildFeatureStatuses,
  buildPublicOverviewSnapshot,
  buildPublicStatusSnapshot,
  recordPublicInteraction,
};
