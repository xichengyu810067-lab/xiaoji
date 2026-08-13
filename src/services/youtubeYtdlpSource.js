const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  ensurePinnedPotProvider,
  getCleanProviderEnv,
  getProviderRuntimePaths,
} = require('../../scripts/bootstrap-ytdlp-pot-provider');
const {
  YouTubeLocalSourceError,
  extractStrictYouTubeVideoId,
  sanitizeVideoTitle,
  youtubeSourceMaxDurationSeconds,
} = require('./youtubeLocalSource');

const ytdlpVersion = '2026.07.04';
const ytdlpMaxDownloadBytes = 64 * 1024 * 1024;
const ytdlpMaxMetadataBytes = 1024 * 1024;
const ytdlpMaxStderrBytes = 4096;
const ytdlpProcessTimeoutMs = 30_000;
const ytdlpDownloadTimeoutMs = 45_000;
const ytdlpAllowedDownloadHosts = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
]);
const ytdlpDiagnosticsByError = new WeakMap();
const ytdlpAssets = Object.freeze({
  glibc: Object.freeze({
    name: 'yt-dlp_linux',
    sha256: '6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae',
  }),
  musl: Object.freeze({
    name: 'yt-dlp_musllinux',
    sha256: 'f7439ec2e3ffe69e06ac233f83f0d9687b89105939129bddcbf74e5de0f2b40e',
  }),
});

let installPromise = null;

function createYtdlpError(code, diagnostics = null) {
  const error = new YouTubeLocalSourceError(code);
  if (diagnostics) {
    const safeDiagnostics = Object.freeze({
      stage: String(diagnostics.stage || 'unknown').replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'unknown',
      exitCode: Number.isSafeInteger(diagnostics.exitCode) ? diagnostics.exitCode : null,
      stdoutBytes: Number.isSafeInteger(diagnostics.stdoutBytes) ? diagnostics.stdoutBytes : 0,
      stderrBytes: Number.isSafeInteger(diagnostics.stderrBytes) ? diagnostics.stderrBytes : 0,
      stderrCategory: ['none', 'bot-challenge', 'js-runtime', 'unsupported-option', 'no-formats', 'unavailable', 'other']
        .includes(diagnostics.stderrCategory)
        ? diagnostics.stderrCategory
        : 'other',
    });
    ytdlpDiagnosticsByError.set(error, safeDiagnostics);
  }
  return error;
}

function getYtdlpDiagnostics(error) {
  return ytdlpDiagnosticsByError.get(error) || null;
}

function classifyYtdlpStderr(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  if (!text) return 'none';
  if (/sign in to confirm|not a bot/i.test(text)) return 'bot-challenge';
  if (/javascript runtime|js runtime|js-runtimes|ejs/i.test(text)) return 'js-runtime';
  if (/no such option|unrecognized arguments?|unknown option/i.test(text)) return 'unsupported-option';
  if (/no video formats|requested format is not available|no formats found/i.test(text)) return 'no-formats';
  if (/video unavailable|private video|members-only|age.restricted|geo.restricted/i.test(text)) return 'unavailable';
  return 'other';
}

function selectYtdlpAsset(report = process.report?.getReport?.(), platform = process.platform) {
  if (platform !== 'linux') return null;
  return report?.header?.glibcVersionRuntime ? ytdlpAssets.glibc : ytdlpAssets.musl;
}

function getYtdlpRuntimePath(asset = selectYtdlpAsset(), cwd = process.cwd()) {
  return path.join(cwd, '.runtime', 'yt-dlp', `${asset.name}-${ytdlpVersion}`);
}

function getYtdlpReleaseUrl(asset) {
  return `https://github.com/yt-dlp/yt-dlp/releases/download/${ytdlpVersion}/${asset.name}`;
}

function isAllowedYtdlpDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ytdlpAllowedDownloadHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function readVerifiedCachedBinary(filePath, expectedSha256, fsImpl = fs.promises) {
  try {
    const buffer = await fsImpl.readFile(filePath);
    return buffer.length <= ytdlpMaxDownloadBytes && sha256(buffer) === expectedSha256;
  } catch {
    return false;
  }
}

async function fetchPinnedYtdlpAsset(
  url,
  {
    fetchImpl = globalThis.fetch,
    maxRedirects = 5,
    maxBytes = ytdlpMaxDownloadBytes,
    timeoutMs = ytdlpDownloadTimeoutMs,
  } = {}
) {
  if (typeof fetchImpl !== 'function') throw new YouTubeLocalSourceError('youtube_local_fetch_unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new YouTubeLocalSourceError('youtube_local_source_failed')),
      { once: true }
    );
  });
  let currentUrl = url;

  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      if (!isAllowedYtdlpDownloadUrl(currentUrl)) {
        throw new YouTubeLocalSourceError('youtube_local_source_failed');
      }
      const response = await Promise.race([
        fetchImpl(currentUrl, {
          credentials: 'omit',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': `xiaoji-ytdlp-bootstrap/${ytdlpVersion}` },
        }),
        aborted,
      ]);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.('location');
        if (!location || redirects === maxRedirects) {
          throw new YouTubeLocalSourceError('youtube_local_source_failed');
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok || !response.body) throw new YouTubeLocalSourceError('youtube_local_source_failed');
      const declaredLengthHeader = response.headers?.get?.('content-length');
      const declaredLength = declaredLengthHeader === null || declaredLengthHeader === undefined
        ? null
        : Number(declaredLengthHeader);
      if (declaredLength !== null && (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > maxBytes)) {
        throw new YouTubeLocalSourceError('youtube_local_length_invalid');
      }

      const chunks = [];
      let total = 0;
      const iterator = response.body[Symbol.asyncIterator]?.();
      if (!iterator) throw new YouTubeLocalSourceError('youtube_local_stream_invalid');
      try {
        while (true) {
          const { done, value } = await Promise.race([iterator.next(), aborted]);
          if (done) break;
          total += value.length;
          if (total > maxBytes) throw new YouTubeLocalSourceError('youtube_local_length_invalid');
          chunks.push(Buffer.from(value));
        }
      } finally {
        Promise.resolve(iterator.return?.()).catch(() => {});
      }
      if (total <= 0) throw new YouTubeLocalSourceError('youtube_local_stream_empty');
      return Buffer.concat(chunks, total);
    }
  } catch (error) {
    if (error instanceof YouTubeLocalSourceError) throw error;
    throw new YouTubeLocalSourceError('youtube_local_source_failed');
  } finally {
    clearTimeout(timer);
  }
  throw new YouTubeLocalSourceError('youtube_local_source_failed');
}

async function installPinnedYtdlp({ asset = selectYtdlpAsset(), cwd, fetchImpl, fsImpl = fs.promises } = {}) {
  if (!asset) throw new YouTubeLocalSourceError('youtube_local_source_failed');
  const binaryPath = getYtdlpRuntimePath(asset, cwd);
  if (await readVerifiedCachedBinary(binaryPath, asset.sha256, fsImpl)) {
    await fsImpl.chmod(binaryPath, 0o755);
    return binaryPath;
  }

  const buffer = await fetchPinnedYtdlpAsset(getYtdlpReleaseUrl(asset), { fetchImpl });
  if (sha256(buffer) !== asset.sha256) throw new YouTubeLocalSourceError('youtube_local_source_failed');
  const directory = path.dirname(binaryPath);
  const temporaryPath = `${binaryPath}.${process.pid}.tmp`;
  await fsImpl.mkdir(directory, { recursive: true });
  try {
    await fsImpl.writeFile(temporaryPath, buffer, { mode: 0o755, flag: 'wx' });
    if (!(await readVerifiedCachedBinary(temporaryPath, asset.sha256, fsImpl))) {
      throw new YouTubeLocalSourceError('youtube_local_source_failed');
    }
    await fsImpl.chmod(temporaryPath, 0o755);
    await fsImpl.rename(temporaryPath, binaryPath);
    return binaryPath;
  } finally {
    await fsImpl.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function ensurePinnedYtdlp(options = {}) {
  if (options.asset || options.cwd || options.fetchImpl || options.fsImpl) return installPinnedYtdlp(options);
  if (!installPromise) installPromise = installPinnedYtdlp().catch((error) => {
    installPromise = null;
    throw error;
  });
  return installPromise;
}

function buildYtdlpCommonArgs(nodePath = process.execPath, providerPaths = getProviderRuntimePaths()) {
  return [
    '--no-config',
    '--no-plugin-dirs',
    '--plugin-dirs',
    providerPaths.pluginDir,
    '--no-playlist',
    '--no-remote-components',
    '--no-js-runtimes',
    '--js-runtimes',
    `node:${nodePath}`,
    '--extractor-args',
    `youtube:player_client=mweb;youtubepot-bgutilscript:server_home=${providerPaths.serverHome}`,
    '--proxy',
    '',
    '--no-warnings',
    '--no-progress',
  ];
}

function buildYtdlpMetadataArgs(videoId, nodePath = process.execPath, providerPaths = getProviderRuntimePaths()) {
  return [
    ...buildYtdlpCommonArgs(nodePath, providerPaths),
    '--skip-download',
    '--dump-single-json',
    '--',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

function buildYtdlpAudioArgs(videoId, nodePath = process.execPath, providerPaths = getProviderRuntimePaths()) {
  return [
    ...buildYtdlpCommonArgs(nodePath, providerPaths),
    '--format',
    'bestaudio/best',
    '--output',
    '-',
    '--',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

function spawnYtdlp(binaryPath, args, spawnImpl = spawn, providerPaths = getProviderRuntimePaths()) {
  try {
    return spawnImpl(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: getCleanProviderEnv(providerPaths.cacheHome),
    });
  } catch {
    throw new YouTubeLocalSourceError('youtube_local_source_failed');
  }
}

function collectYtdlpMetadata(child, { timeoutMs = ytdlpProcessTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const diagnostics = (stage, exitCode = null) => ({
      stage,
      exitCode,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      stderrCategory: classifyYtdlpStderr(stderr),
    });
    const timer = setTimeout(() => fail('youtube_local_info_timeout', 'timeout'), timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('error');
      child.removeAllListeners('close');
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = (code, stage, exitCode = null) => {
      try { if (!child.killed) child.kill('SIGKILL'); } catch {}
      finish(reject, createYtdlpError(code, diagnostics(stage, exitCode)));
    };

    child.stdout?.on('data', (chunk) => {
      if (stdout.length + chunk.length > ytdlpMaxMetadataBytes) {
        return fail('youtube_local_info_failed', 'stdout-limit');
      }
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < ytdlpMaxStderrBytes) {
        stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(0, ytdlpMaxStderrBytes);
      }
    });
    child.once('error', () => fail('youtube_local_info_failed', 'process-error'));
    child.once('close', (code) => {
      if (code !== 0) return fail('youtube_local_info_failed', 'exit-nonzero', code);
      if (stdout.length <= 0) return fail('youtube_local_info_failed', 'stdout-empty', code);
      try {
        finish(resolve, JSON.parse(stdout.toString('utf8')));
      } catch {
        fail('youtube_local_info_failed', 'json-invalid', code);
      }
    });
  });
}

function validateYtdlpMetadata(metadata, videoId) {
  if (!metadata || metadata.id !== videoId) {
    throw createYtdlpError('youtube_local_metadata_id_mismatch', { stage: 'identity' });
  }
  if (
    metadata.is_live === true ||
    ['is_live', 'is_upcoming', 'post_live', 'was_live'].includes(metadata.live_status)
  ) {
    throw createYtdlpError('youtube_local_live_rejected', { stage: 'live-check' });
  }
  const duration = Number(metadata.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw createYtdlpError('youtube_local_duration_invalid', { stage: 'duration' });
  }
  if (duration > youtubeSourceMaxDurationSeconds) {
    throw createYtdlpError('youtube_local_duration_overlong', { stage: 'duration' });
  }
  return {
    title: sanitizeVideoTitle(metadata.title),
    duration: Math.ceil(duration),
    source: 'youtube-local',
  };
}

async function loadYtdlpYouTubeAudio(input, {
  ensureBinary = ensurePinnedYtdlp,
  ensureProvider = ensurePinnedPotProvider,
  spawnImpl = spawn,
} = {}) {
  const videoId = extractStrictYouTubeVideoId(input);
  if (!videoId) throw new YouTubeLocalSourceError('youtube_local_invalid_video');
  const binaryPath = await ensureBinary();
  const providerPaths = await ensureProvider();
  const metadataChild = spawnYtdlp(binaryPath, buildYtdlpMetadataArgs(videoId, process.execPath, providerPaths), spawnImpl, providerPaths);
  const metadata = await collectYtdlpMetadata(metadataChild);
  const track = validateYtdlpMetadata(metadata, videoId);
  const sourceProcess = spawnYtdlp(binaryPath, buildYtdlpAudioArgs(videoId, process.execPath, providerPaths), spawnImpl, providerPaths);
  if (!sourceProcess?.stdout) {
    try { sourceProcess?.kill?.('SIGKILL'); } catch {}
    throw new YouTubeLocalSourceError('youtube_local_stream_create_failed');
  }
  sourceProcess.once('error', () => {
    sourceProcess.stdout?.destroy?.(new YouTubeLocalSourceError('youtube_local_stream_failed'));
  });
  sourceProcess.stderr?.resume?.();
  return { nodeStream: sourceProcess.stdout, sourceProcess, track };
}

module.exports = {
  buildYtdlpAudioArgs,
  buildYtdlpCommonArgs,
  buildYtdlpMetadataArgs,
  collectYtdlpMetadata,
  ensurePinnedYtdlp,
  fetchPinnedYtdlpAsset,
  getYtdlpReleaseUrl,
  getYtdlpDiagnostics,
  getYtdlpRuntimePath,
  installPinnedYtdlp,
  isAllowedYtdlpDownloadUrl,
  classifyYtdlpStderr,
  loadYtdlpYouTubeAudio,
  readVerifiedCachedBinary,
  selectYtdlpAsset,
  sha256,
  validateYtdlpMetadata,
  ytdlpAllowedDownloadHosts,
  ytdlpAssets,
  ytdlpMaxDownloadBytes,
  ytdlpVersion,
};
