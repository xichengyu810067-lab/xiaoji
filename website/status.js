(function bootstrapStatusSite() {
  'use strict';

  const API_TIMEOUT_MS = 5000;
  const REFRESH_INTERVAL_MS = 60_000;
  const FEATURE_STATUS = Object.freeze({
    normal: { label: '正常', detail: '功能目前可使用' },
    maintenance: { label: '維護中', detail: '功能正在維護或尚未啟用' },
    broken: { label: '損壞', detail: '功能目前發生異常' },
  });
  const OVERALL_STATUS = Object.freeze({
    operational: { label: '運作正常', detail: '核心服務目前可使用', className: 'is-operational' },
    degraded: { label: '部分異常', detail: '部分功能正在維護或發生異常', className: 'is-degraded' },
    outage: { label: '服務中斷', detail: '核心服務目前無法正常使用', className: 'is-outage' },
  });

  let refreshTimer = null;
  let activeController = null;

  function getApiBase() {
    const configured = document.querySelector('meta[name="xiaoji-api-base"]')?.content?.trim();
    return configured ? configured.replace(/\/$/, '') : '/api/public';
  }

  function normalizeOverallStatus(value) {
    return Object.hasOwn(OVERALL_STATUS, value) ? value : null;
  }

  function normalizeFeature(feature) {
    if (!feature || typeof feature !== 'object' || !Object.hasOwn(FEATURE_STATUS, feature.status)) return null;
    if (typeof feature.name !== 'string' || typeof feature.category !== 'string') return null;
    return {
      name: feature.name.slice(0, 80),
      category: feature.category.slice(0, 80),
      status: feature.status,
    };
  }

  function formatUpdatedAt(value) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return '更新時間未知';
    return `最後更新 ${new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(timestamp)}`;
  }

  function createFeatureRow(feature) {
    const row = document.createElement('article');
    row.className = 'service-row';

    const dot = document.createElement('span');
    dot.className = `service-dot ${feature.status}`;
    dot.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('div');
    copy.className = 'service-copy';
    const name = document.createElement('strong');
    name.textContent = feature.name;
    const detail = document.createElement('small');
    detail.textContent = FEATURE_STATUS[feature.status].detail;
    copy.append(name, detail);

    const badge = document.createElement('span');
    badge.className = `service-badge ${feature.status}`;
    badge.textContent = FEATURE_STATUS[feature.status].label;

    row.append(dot, copy, badge);
    return row;
  }

  function renderFeatureGroups(features) {
    const container = document.querySelector('[data-status-groups]');
    const categories = new Map();
    features.forEach((feature) => {
      if (!categories.has(feature.category)) categories.set(feature.category, []);
      categories.get(feature.category).push(feature);
    });

    container.replaceChildren();
    for (const [category, entries] of categories) {
      const group = document.createElement('section');
      group.className = 'status-group';
      const heading = document.createElement('h3');
      heading.textContent = category;
      const list = document.createElement('div');
      list.className = 'service-list';
      entries.forEach((feature) => list.append(createFeatureRow(feature)));
      group.append(heading, list);
      container.append(group);
    }
    container.setAttribute('aria-busy', 'false');
  }

  function renderSnapshot(payload) {
    const overallStatus = normalizeOverallStatus(payload?.bot?.status);
    const features = Array.isArray(payload?.features) ? payload.features.map(normalizeFeature).filter(Boolean) : [];
    if (payload?.schemaVersion !== 1 || !overallStatus || features.length === 0) {
      throw new Error('unsupported_status_payload');
    }

    const overall = OVERALL_STATUS[overallStatus];
    const card = document.querySelector('[data-overall-card]');
    card.classList.remove('is-operational', 'is-degraded', 'is-outage');
    card.classList.add(overall.className);
    document.querySelector('[data-overall-label]').textContent = overall.label;
    document.querySelector('[data-overall-detail]').textContent = overall.detail;
    document.querySelector('[data-last-updated]').textContent = formatUpdatedAt(payload.updatedAt);
    const latency = Number.isFinite(payload?.bot?.latencyMs) && payload.bot.latencyMs >= 0
      ? `${Math.round(payload.bot.latencyMs)} ms`
      : '—';
    document.querySelector('[data-latency]').textContent = `延遲 ${latency}`;

    const navDot = document.querySelector('[data-nav-status-dot]');
    navDot.classList.remove('is-operational', 'is-degraded', 'is-outage');
    navDot.classList.add(overall.className);

    const computedSummary = features.reduce((summary, feature) => {
      summary[feature.status] += 1;
      return summary;
    }, { normal: 0, maintenance: 0, broken: 0 });
    for (const status of Object.keys(computedSummary)) {
      document.querySelector(`[data-summary="${status}"]`).textContent = String(computedSummary[status]);
    }

    document.querySelector('[data-status-unavailable]').hidden = true;
    renderFeatureGroups(features);
  }

  function renderUnavailable() {
    const card = document.querySelector('[data-overall-card]');
    card.classList.remove('is-operational', 'is-degraded', 'is-outage');
    card.classList.add('is-degraded');
    document.querySelector('[data-overall-label]').textContent = '狀態未知';
    document.querySelector('[data-overall-detail]').textContent = '暫時無法確認小吉的服務狀態';
    document.querySelector('[data-last-updated]').textContent = '尚未取得更新';
    document.querySelector('[data-latency]').textContent = '延遲 —';
    document.querySelector('[data-status-unavailable]').hidden = false;
    for (const status of Object.keys(FEATURE_STATUS)) {
      document.querySelector(`[data-summary="${status}"]`).textContent = '—';
    }
    const groups = document.querySelector('[data-status-groups]');
    groups.replaceChildren();
    groups.setAttribute('aria-busy', 'false');
    const navDot = document.querySelector('[data-nav-status-dot]');
    navDot.classList.remove('is-operational', 'is-outage');
    navDot.classList.add('is-degraded');
  }

  async function refreshStatus() {
    const button = document.querySelector('[data-refresh]');
    button.disabled = true;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const timeout = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(`${getApiBase()}/status`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('status_unavailable');
      renderSnapshot(await response.json());
    } catch (_error) {
      renderUnavailable();
    } finally {
      window.clearTimeout(timeout);
      if (activeController === controller) {
        activeController = null;
        button.disabled = false;
      }
    }
  }

  function scheduleRefresh() {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
    if (document.hidden) return;
    refreshTimer = window.setInterval(refreshStatus, REFRESH_INTERVAL_MS);
  }

  document.querySelector('[data-current-year]').textContent = String(new Date().getFullYear());
  document.querySelector('[data-refresh]').addEventListener('click', refreshStatus);
  document.addEventListener('visibilitychange', () => {
    scheduleRefresh();
    if (!document.hidden) refreshStatus();
  });
  scheduleRefresh();
  refreshStatus();
})();
