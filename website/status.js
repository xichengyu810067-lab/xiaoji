(function bootstrapStatusSite() {
  'use strict';

  const REFRESH_INTERVAL_MS = 60_000;
  const FEATURE_STATUS = Object.freeze({
    normal: { label: '正常', detail: '功能目前可使用' },
    maintenance: { label: '維護中', detail: '功能正在維護或尚未啟用' },
    broken: { label: '損壞', detail: '功能目前發生異常' },
  });
  const UNKNOWN_FEATURE_STATUS = Object.freeze({
    className: 'unknown',
    label: '狀態尚未取得',
    detail: '即時狀態暫時無法取得',
  });
  const OVERALL_STATUS = Object.freeze({
    operational: { label: '運作正常', detail: '核心服務目前可使用', className: 'is-operational' },
    degraded: { label: '部分異常', detail: '部分功能正在維護或發生異常', className: 'is-degraded' },
    outage: { label: '服務中斷', detail: '核心服務目前無法正常使用', className: 'is-outage' },
  });

  let refreshTimer = null;

  function getWorkerBase() {
    const configured = document.querySelector('meta[name="xiaoji-api-base"]')?.content?.trim();
    if (!configured) throw new Error('public_status_worker_base_missing');
    return configured.replace(/\/$/, '');
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

  function createFeaturePanel(feature, presentation, freshness, index) {
    const panel = document.createElement('article');
    panel.className = `service-panel is-${presentation.className}`;

    const trigger = document.createElement('button');
    trigger.className = 'accordion-trigger';
    trigger.type = 'button';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `feature-panel-${index}`);

    const status = document.createElement('span');
    status.className = `service-badge ${presentation.className}`;
    status.textContent = presentation.label;

    const heading = document.createElement('span');
    heading.className = 'service-copy';
    const name = document.createElement('strong');
    name.textContent = feature.name;
    const detail = document.createElement('small');
    detail.textContent = presentation.detail;
    heading.append(name, detail);

    const indicator = document.createElement('span');
    indicator.className = 'accordion-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.textContent = '＋';
    trigger.append(status, heading, indicator);

    const bar = document.createElement('span');
    bar.className = `status-bar ${presentation.className}`;
    bar.setAttribute('aria-hidden', 'true');

    const content = document.createElement('div');
    content.className = 'accordion-content';
    content.id = `feature-panel-${index}`;
    content.hidden = true;
    content.setAttribute('role', 'region');
    content.setAttribute('aria-label', `${feature.name} 狀態詳情`);

    const explanation = document.createElement('p');
    explanation.textContent = `${feature.name}：${presentation.detail}。`;
    const checkedAt = document.createElement('p');
    checkedAt.className = 'status-meta-line';
    checkedAt.textContent = freshness;
    const diagnostic = document.createElement('p');
    diagnostic.className = 'status-diagnostic';
    diagnostic.textContent = presentation.className === 'unknown'
      ? '診斷摘要：尚未接收到可驗證的公開狀態快照，未將未知資料視為正常。'
      : '診斷摘要：此為去識別化的公開狀態摘要，不含伺服器、頻道或使用者資訊。';
    content.append(explanation, checkedAt, diagnostic);

    trigger.addEventListener('click', () => {
      const expanded = trigger.getAttribute('aria-expanded') === 'true';
      trigger.setAttribute('aria-expanded', String(!expanded));
      content.hidden = expanded;
      panel.classList.toggle('is-open', !expanded);
      indicator.textContent = expanded ? '＋' : '－';
    });

    panel.append(trigger, bar, content);
    return panel;
  }

  function renderFeatureGroups(features, getPresentation, freshness) {
    const container = document.querySelector('[data-status-groups]');
    const categories = new Map();
    features.forEach((feature) => {
      if (!categories.has(feature.category)) categories.set(feature.category, []);
      categories.get(feature.category).push(feature);
    });

    container.replaceChildren();
    let panelIndex = 0;
    for (const [category, entries] of categories) {
      const group = document.createElement('section');
      group.className = 'status-group';
      const heading = document.createElement('h3');
      heading.textContent = category;
      const list = document.createElement('div');
      list.className = 'service-list';
      entries.forEach((feature) => {
        panelIndex += 1;
        list.append(createFeaturePanel(feature, getPresentation(feature), freshness, panelIndex));
      });
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
    renderFeatureGroups(features, (feature) => ({
      className: feature.status,
      ...FEATURE_STATUS[feature.status],
    }), formatUpdatedAt(payload.updatedAt));
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
    renderFeatureGroups(
      window.XiaojiStatusData.PUBLIC_FEATURE_CATALOG,
      () => UNKNOWN_FEATURE_STATUS,
      '最後檢查：尚未取得公開資料'
    );
    const navDot = document.querySelector('[data-nav-status-dot]');
    navDot.classList.remove('is-operational', 'is-outage');
    navDot.classList.add('is-degraded');
  }

  const statusLoader = window.XiaojiStatusData.createStatusLoader({
    fetchImpl: window.fetch.bind(window),
    urlProvider: () => `${getWorkerBase()}/api/public/status`,
    renderSuccess: renderSnapshot,
    renderFailure: renderUnavailable,
    setLoading: (loading) => {
      document.querySelector('[data-refresh]').disabled = loading;
    },
    setTimeoutImpl: window.setTimeout.bind(window),
    clearTimeoutImpl: window.clearTimeout.bind(window),
    AbortControllerImpl: window.AbortController,
  });
  const refreshStatus = statusLoader.refresh;

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
