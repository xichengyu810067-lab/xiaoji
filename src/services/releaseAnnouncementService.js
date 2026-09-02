const { createHash, randomUUID } = require('node:crypto');
const { ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { isGuildApproved } = require('./auditService');
const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const {
  getGuildFeatureSetting,
  recordFeatureUsage,
  setFeatureHealth,
} = require('./featurePlatformService');
const logger = require('../utils/logger');

const FEATURE_KEY = 'release_announcements';
const DEFAULT_REPOSITORY = 'xichengyu810067-lab/xiaoji';
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const RELEASES_PER_PAGE = 50;
const MAX_PAGES = 5;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DELIVERIES_PER_POLL = 10;
const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_LEASE_MS = 2 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;

class ReleaseAnnouncementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseAnnouncementError';
    this.code = code;
  }
}

function boundedText(value, maxLength, fallback = '') {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!text) return fallback;
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function parseRepository(value = DEFAULT_REPOSITORY) {
  const repository = String(value || DEFAULT_REPOSITORY).trim();
  const match = repository.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/);
  if (!match || match[2].startsWith('.') || match[2].endsWith('.') || match[2].includes('..')) {
    throw new ReleaseAnnouncementError('CONFIG_INVALID', 'GitHub release repository is invalid.');
  }
  return { owner: match[1], repo: match[2], repository: `${match[1]}/${match[2]}` };
}

function parsePollInterval(value) {
  if (value == null || String(value).trim() === '') return DEFAULT_POLL_INTERVAL_MS;
  const interval = Number(value);
  return Number.isSafeInteger(interval) && interval >= MIN_POLL_INTERVAL_MS && interval <= MAX_POLL_INTERVAL_MS
    ? interval
    : DEFAULT_POLL_INTERVAL_MS;
}

function readReleaseAnnouncementConfig(env = process.env) {
  const repository = parseRepository(env.GITHUB_RELEASE_REPOSITORY || DEFAULT_REPOSITORY);
  const token = String(env.GITHUB_RELEASE_TOKEN || '').trim();
  if (token && (token.length > 512 || /[\s\u0000-\u001f\u007f]/.test(token))) {
    throw new ReleaseAnnouncementError('CONFIG_INVALID', 'GitHub release token is invalid.');
  }
  return { ...repository, token: token || null, pollIntervalMs: parsePollInterval(env.GITHUB_RELEASE_POLL_INTERVAL_MS) };
}

function parseStableSemver(tagName) {
  const match = String(tagName || '').match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part > 2_147_483_647) || parts[0] < 1) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2], normalized: `${parts[0]}.${parts[1]}.${parts[2]}` };
}

function validateReleaseUrl(value, { owner, repo }, tagName) {
  let url;
  try { url = new URL(String(value || '')); }
  catch (_error) { throw new ReleaseAnnouncementError('RELEASE_INVALID', 'Release URL is invalid.'); }
  let decodedPath;
  try { decodedPath = decodeURIComponent(url.pathname); }
  catch (_error) { throw new ReleaseAnnouncementError('RELEASE_INVALID', 'Release URL path is invalid.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password ||
      url.search || url.hash || decodedPath !== `/${owner}/${repo}/releases/tag/${tagName}`) {
    throw new ReleaseAnnouncementError('RELEASE_INVALID', 'Release URL does not match the configured repository and tag.');
  }
  return `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tagName)}`;
}

function normalizeRelease(raw, repositoryConfig) {
  if (!raw || raw.draft !== false || raw.prerelease !== false) return null;
  const version = parseStableSemver(raw.tag_name);
  if (!version) return null;
  const releaseId = typeof raw.id === 'number' && Number.isSafeInteger(raw.id) && raw.id > 0
    ? String(raw.id)
    : /^\d{1,30}$/.test(String(raw.id || '')) ? String(raw.id) : null;
  const publishedAt = new Date(raw.published_at);
  if (!releaseId || Number.isNaN(publishedAt.getTime())) return null;
  let htmlUrl;
  try { htmlUrl = validateReleaseUrl(raw.html_url, repositoryConfig, raw.tag_name); }
  catch (_error) { return null; }
  const releaseName = boundedText(raw.name, 200, `Release ${raw.tag_name}`);
  const bodySummary = boundedText(raw.body, 3_500, '此版本未提供變更摘要。');
  const digest = createHash('sha256').update(JSON.stringify({
    releaseId, tagName: raw.tag_name, releaseName, bodySummary, htmlUrl, publishedAt: publishedAt.toISOString(),
  })).digest('hex');
  return {
    releaseId,
    repository: repositoryConfig.repository,
    tagName: raw.tag_name,
    ...version,
    releaseName,
    bodySummary,
    htmlUrl,
    metadataDigest: digest,
    publishedAt: publishedAt.toISOString(),
  };
}

function compareReleases(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch ||
    left.publishedAt.localeCompare(right.publishedAt) || left.releaseId.localeCompare(right.releaseId);
}

async function readBoundedResponse(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ReleaseAnnouncementError('RESPONSE_TOO_LARGE', 'GitHub response is too large.');
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ReleaseAnnouncementError('RESPONSE_TOO_LARGE', 'GitHub response is too large.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new ReleaseAnnouncementError('RESPONSE_TOO_LARGE', 'GitHub response is too large.');
  return text;
}

async function fetchGithubReleases(config, {
  fetchImpl = globalThis.fetch,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new ReleaseAnnouncementError('FETCH_UNAVAILABLE', 'GitHub fetch is unavailable.');
  const releases = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const endpoint = `https://api.github.com/repos/${config.owner}/${config.repo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`;
    const controller = new AbortController();
    const timeout = setTimeoutFn(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout?.unref?.();
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'xiaoji-release-announcements/1.0',
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
      });
    } catch (error) {
      throw new ReleaseAnnouncementError(error?.name === 'AbortError' ? 'FETCH_TIMEOUT' : 'FETCH_FAILED', 'GitHub release request failed.');
    } finally {
      clearTimeoutFn(timeout);
    }
    if (response.url !== endpoint) throw new ReleaseAnnouncementError('REDIRECT_REJECTED', 'GitHub response endpoint changed.');
    if (!response.ok || response.status !== 200) throw new ReleaseAnnouncementError('FETCH_STATUS', 'GitHub release request returned an invalid status.');
    if (!String(response.headers?.get?.('content-type') || '').toLowerCase().includes('application/json')) {
      throw new ReleaseAnnouncementError('RESPONSE_INVALID', 'GitHub release response is not JSON.');
    }
    let pageRows;
    try { pageRows = JSON.parse(await readBoundedResponse(response)); }
    catch (error) {
      if (error instanceof ReleaseAnnouncementError) throw error;
      throw new ReleaseAnnouncementError('RESPONSE_INVALID', 'GitHub release response JSON is invalid.');
    }
    if (!Array.isArray(pageRows) || pageRows.length > RELEASES_PER_PAGE) {
      throw new ReleaseAnnouncementError('RESPONSE_INVALID', 'GitHub release response shape is invalid.');
    }
    for (const row of pageRows) {
      const normalized = normalizeRelease(row, config);
      if (normalized) releases.push(normalized);
    }
    if (pageRows.length < RELEASES_PER_PAGE) break;
    if (page === MAX_PAGES) {
      throw new ReleaseAnnouncementError('PAGE_LIMIT', 'GitHub release pagination exceeded the safety limit.');
    }
  }
  const unique = new Map(releases.map((release) => [`${release.repository}:${release.releaseId}`, release]));
  return [...unique.values()].sort(compareReleases);
}

function deliveryNonce(repository, releaseId, guildId) {
  return createHash('sha256').update(`${repository}:${releaseId}:${guildId}`).digest('hex').slice(0, 24);
}

async function persistReleasesAndDeliveries(releases, guildIds, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  return withCoinTransaction((api) => {
    for (const release of releases) {
      api.run(`INSERT INTO github_releases
        (release_id, repository, tag_name, version_major, version_minor, version_patch, release_name,
         body_summary, html_url, metadata_digest, published_at, discovered_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(release_id) DO UPDATE SET
          repository = excluded.repository, tag_name = excluded.tag_name,
          version_major = excluded.version_major, version_minor = excluded.version_minor,
          version_patch = excluded.version_patch, release_name = excluded.release_name,
          body_summary = excluded.body_summary, html_url = excluded.html_url,
          metadata_digest = excluded.metadata_digest, published_at = excluded.published_at,
          updated_at = excluded.updated_at`, [
        release.releaseId, release.repository, release.tagName, release.major, release.minor, release.patch,
        release.releaseName, release.bodySummary, release.htmlUrl, release.metadataDigest, release.publishedAt,
        timestamp, timestamp,
      ]);
    }
    const stored = api.all(`SELECT release_id, repository FROM github_releases
      ORDER BY version_major, version_minor, version_patch, published_at, release_id`);
    for (const guildId of guildIds) for (const release of stored) {
      api.run(`INSERT INTO release_announcement_deliveries
        (release_id, guild_id, status, attempt_count, next_attempt_at, nonce, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)
        ON CONFLICT(release_id, guild_id) DO UPDATE SET
          status = 'pending', attempt_count = 0, next_attempt_at = excluded.next_attempt_at,
          lease_owner = NULL, lease_until = NULL, last_error = NULL, updated_at = excluded.updated_at
        WHERE release_announcement_deliveries.status = 'suppressed'`, [
        release.release_id, guildId, timestamp, deliveryNonce(release.repository, release.release_id, guildId), timestamp, timestamp,
      ]);
    }
    return { releases: stored.length, guilds: guildIds.length };
  });
}

async function claimNextDelivery(workerId, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  const leaseUntil = new Date(new Date(now).getTime() + DELIVERY_LEASE_MS).toISOString();
  return withCoinTransaction((api) => {
    const candidate = api.get(`SELECT delivery.*, release.repository, release.tag_name, release.release_name,
        release.body_summary, release.html_url, release.published_at
      FROM release_announcement_deliveries AS delivery
      JOIN github_releases AS release ON release.release_id = delivery.release_id
      WHERE delivery.attempt_count < ? AND (
        (delivery.status = 'pending' AND delivery.next_attempt_at <= ?) OR
        (delivery.status = 'processing' AND delivery.lease_until <= ?)
      )
      ORDER BY release.version_major, release.version_minor, release.version_patch,
        release.published_at, release.release_id, delivery.guild_id
      LIMIT 1`, [MAX_DELIVERY_ATTEMPTS, timestamp, timestamp]);
    if (!candidate) return null;
    api.run(`UPDATE release_announcement_deliveries
      SET status = 'processing', attempt_count = attempt_count + 1, lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE release_id = ? AND guild_id = ? AND attempt_count = ? AND (
        (status = 'pending' AND next_attempt_at <= ?) OR (status = 'processing' AND lease_until <= ?)
      )`, [workerId, leaseUntil, timestamp, candidate.release_id, candidate.guild_id, candidate.attempt_count, timestamp, timestamp]);
    if (Number(api.get('SELECT changes() AS count').count) !== 1) return null;
    return { ...candidate, attempt_count: Number(candidate.attempt_count) + 1, lease_owner: workerId, lease_until: leaseUntil };
  });
}

async function markDeliveryDelivered(delivery, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  return withCoinTransaction((api) => {
    api.run(`UPDATE release_announcement_deliveries SET status = 'delivered', lease_owner = NULL,
      lease_until = NULL, last_error = NULL, delivered_at = ?, updated_at = ?
      WHERE release_id = ? AND guild_id = ? AND status = 'processing' AND lease_owner = ?`,
    [timestamp, timestamp, delivery.release_id, delivery.guild_id, delivery.lease_owner]);
    if (Number(api.get('SELECT changes() AS count').count) !== 1) {
      throw new ReleaseAnnouncementError('LEASE_LOST', 'Release delivery lease was lost.');
    }
  });
}

async function markDeliveryFailed(delivery, errorCode, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  const dead = Number(delivery.attempt_count) >= MAX_DELIVERY_ATTEMPTS;
  const nextAttempt = new Date(new Date(now).getTime() + RETRY_DELAY_MS).toISOString();
  return withCoinTransaction((api) => api.run(`UPDATE release_announcement_deliveries
    SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_until = NULL, last_error = ?, updated_at = ?
    WHERE release_id = ? AND guild_id = ? AND status = 'processing' AND lease_owner = ?`, [
    dead ? 'dead_letter' : 'pending', nextAttempt, boundedText(errorCode, 80, 'delivery_failed'), timestamp,
    delivery.release_id, delivery.guild_id, delivery.lease_owner,
  ]));
}

async function markDeliverySuppressed(delivery, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  return withCoinTransaction((api) => api.run(`UPDATE release_announcement_deliveries
    SET status = 'suppressed', lease_owner = NULL, lease_until = NULL,
      last_error = 'GUILD_NOT_APPROVED', updated_at = ?
    WHERE release_id = ? AND guild_id = ? AND status = 'processing' AND lease_owner = ?`, [
    timestamp, delivery.release_id, delivery.guild_id, delivery.lease_owner,
  ]));
}

function hasChannelPermissions(channel, guild) {
  if (!channel || channel.guildId !== guild.id || channel.isThread?.() ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return false;
  const permissions = channel.permissionsFor?.(guild.members?.me);
  return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
    .every((permission) => permissions?.has?.(permission));
}

async function selectReleaseChannel(guild, { settingReader = getGuildFeatureSetting } = {}) {
  const setting = await settingReader(guild.id, FEATURE_KEY);
  const preferred = setting?.channelId ? guild.channels?.cache?.get?.(setting.channelId) : null;
  if (hasChannelPermissions(preferred, guild)) return preferred;
  if (hasChannelPermissions(guild.systemChannel, guild)) return guild.systemChannel;
  const channels = [...(guild.channels?.cache?.values?.() || [])]
    .filter((channel) => hasChannelPermissions(channel, guild))
    .sort((left, right) => {
      const leftPriority = left.type === ChannelType.GuildAnnouncement ? 0 : 1;
      const rightPriority = right.type === ChannelType.GuildAnnouncement ? 0 : 1;
      return leftPriority - rightPriority || String(left.id).localeCompare(String(right.id));
    });
  return channels[0] || null;
}

function buildReleaseMessage(delivery) {
  const embed = new EmbedBuilder()
    .setColor(0xff8fbd)
    .setTitle(boundedText(`正式 GitHub Release｜${delivery.tag_name}`, 256))
    .setURL(delivery.html_url)
    .setDescription(boundedText(`**${delivery.release_name}**\n\n${delivery.body_summary}`, 4_096))
    .setFooter({ text: '小吉正式版本公告' })
    .setTimestamp(new Date(delivery.published_at));
  return {
    content: '小吉帶來新的正式 GitHub Release 公告！',
    embeds: [embed],
    allowedMentions: { parse: [] },
    nonce: delivery.nonce,
    enforceNonce: true,
  };
}

async function processReleaseAnnouncementTick(client, options = {}) {
  const now = options.now instanceof Date ? new Date(options.now) : new Date();
  const healthReporter = options.healthReporter || setFeatureHealth;
  const usageRecorder = options.usageRecorder || recordFeatureUsage;
  const auditChecker = options.auditChecker || isGuildApproved;
  let config;
  try {
    config = options.config || readReleaseAnnouncementConfig(options.env || process.env);
    const releases = await fetchGithubReleases(config, options);
    const guilds = [...(client?.guilds?.cache?.values?.() || [])]
      .filter((guild) => auditChecker(guild.id))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    await persistReleasesAndDeliveries(releases, guilds.map((guild) => guild.id), now);
    const workerId = options.workerId || randomUUID();
    let delivered = 0;
    let failed = 0;
    let suppressed = 0;
    for (let index = 0; index < (options.deliveryLimit || MAX_DELIVERIES_PER_POLL); index += 1) {
      const delivery = await claimNextDelivery(workerId, now);
      if (!delivery) break;
      const guild = client.guilds.cache.get(delivery.guild_id);
      try {
        if (!guild || !auditChecker(delivery.guild_id)) throw new ReleaseAnnouncementError('GUILD_NOT_APPROVED', 'Guild is not approved.');
        const channel = await selectReleaseChannel(guild, options);
        if (!channel) throw new ReleaseAnnouncementError('CHANNEL_UNAVAILABLE', 'No safe release announcement channel is available.');
        await channel.send(buildReleaseMessage(delivery));
        await options.afterSend?.(delivery);
        await markDeliveryDelivered(delivery, now);
        await usageRecorder(FEATURE_KEY, 'announcement', 1, now);
        delivered += 1;
      } catch (error) {
        if (error?.code === 'GUILD_NOT_APPROVED') {
          await markDeliverySuppressed(delivery, now).catch(() => {});
          suppressed += 1;
        } else {
          await markDeliveryFailed(delivery, error?.code || 'delivery_failed', now).catch(() => {});
          failed += 1;
        }
      }
    }
    const unhealthyBacklog = await withCoinDatabase((api) => Number(api.get(`SELECT COUNT(*) AS count
      FROM release_announcement_deliveries
      WHERE status = 'dead_letter' OR (status <> 'suppressed' AND last_error IS NOT NULL)`).count));
    const unhealthy = failed > 0 || unhealthyBacklog > 0;
    await healthReporter(FEATURE_KEY, unhealthy ? 'broken' : 'normal', {
      detail: failed > 0 ? 'delivery_failed' : unhealthyBacklog > 0 ? 'delivery_backlog' : null,
      now,
    });
    return { ok: failed === 0, releases: releases.length, approvedGuilds: guilds.length, delivered, failed, suppressed };
  } catch (_error) {
    await healthReporter(FEATURE_KEY, 'broken', { detail: 'github_sync_failed', now }).catch(() => {});
    return { ok: false, releases: 0, approvedGuilds: 0, delivered: 0, failed: 1, suppressed: 0 };
  }
}

let schedulerState = null;

function startReleaseAnnouncementScheduler(client, options = {}) {
  if (schedulerState) return schedulerState;
  const config = options.config || readReleaseAnnouncementConfig(options.env || process.env);
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const state = { timer: null, inFlight: null, stopped: false, clearIntervalFn };
  const run = () => {
    if (state.stopped || state.inFlight) return state.inFlight;
    state.inFlight = Promise.resolve(processReleaseAnnouncementTick(client, { ...options, config }))
      .catch(() => null)
      .finally(() => { state.inFlight = null; });
    return state.inFlight;
  };
  state.run = run;
  void run();
  state.timer = setIntervalFn(() => { void run(); }, config.pollIntervalMs);
  state.timer?.unref?.();
  schedulerState = state;
  return state;
}

function stopReleaseAnnouncementScheduler() {
  if (!schedulerState) return false;
  schedulerState.stopped = true;
  schedulerState.clearIntervalFn(schedulerState.timer);
  schedulerState = null;
  return true;
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REPOSITORY,
  FEATURE_KEY,
  MAX_DELIVERIES_PER_POLL,
  MAX_PAGES,
  RELEASES_PER_PAGE,
  ReleaseAnnouncementError,
  buildReleaseMessage,
  claimNextDelivery,
  fetchGithubReleases,
  normalizeRelease,
  parsePollInterval,
  parseRepository,
  parseStableSemver,
  persistReleasesAndDeliveries,
  processReleaseAnnouncementTick,
  readReleaseAnnouncementConfig,
  selectReleaseChannel,
  startReleaseAnnouncementScheduler,
  stopReleaseAnnouncementScheduler,
  validateReleaseUrl,
};
