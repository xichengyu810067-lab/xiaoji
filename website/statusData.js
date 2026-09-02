(function exposeStatusData(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.XiaojiStatusData = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, function createStatusDataApi() {
  'use strict';

  function createStatusLoader({
    fetchImpl,
    urlProvider,
    renderSuccess,
    renderFailure,
    setLoading,
    timeoutMs = 5000,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    AbortControllerImpl = AbortController,
  }) {
    let activeController = null;

    async function refresh() {
      activeController?.abort();
      const controller = new AbortControllerImpl();
      activeController = controller;
      setLoading(true);
      const timeout = setTimeoutImpl(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(urlProvider(), {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('status_unavailable');
        const payload = await response.json();
        if (activeController !== controller) return { stale: true };
        renderSuccess(payload);
        return { ok: true };
      } catch (_error) {
        if (activeController !== controller) return { stale: true };
        renderFailure();
        return { ok: false };
      } finally {
        clearTimeoutImpl(timeout);
        if (activeController === controller) {
          activeController = null;
          setLoading(false);
        }
      }
    }

    return { refresh };
  }

  return { createStatusLoader };
});
