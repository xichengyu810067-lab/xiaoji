const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const providerVersion = '1.3.1';
const providerCommit = '7608dd51ee813b48cf9a6d68c6e42cb197ce10e0';
const providerSourceSha256 = '5d4c54f9c5e75f3dcb48c906a5f8b860f57ee125b83f025e43362ab332695c3e';
const providerPluginSha256 = 'b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38';
const providerMaxArchiveBytes = 2 * 1024 * 1024;
const providerDownloadTimeoutMs = 30_000;
const providerCommandTimeoutMs = 120_000;
const providerAllowedHosts = new Set(['github.com', 'codeload.github.com', 'release-assets.githubusercontent.com']);
const providerSourceUrl = `https://codeload.github.com/Brainicism/bgutil-ytdlp-pot-provider/tar.gz/${providerCommit}`;
const providerPluginUrl = `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${providerVersion}/bgutil-ytdlp-pot-provider.zip`;
const providerSourceFiles = Object.freeze([
  'server/src/generate_once.ts',
  'server/src/session_manager.ts',
  'server/src/utils.ts',
]);
const providerPluginFiles = Object.freeze([
  'yt_dlp_plugins/extractor/getpot_bgutil.py',
  'yt_dlp_plugins/extractor/getpot_bgutil_script.py',
]);
const providerWrapper = `if (process.argv.includes('--version')) {\n  process.stdout.write('1.3.1\\n');\n  process.exit(0);\n}\nawait import('./generate_once_impl.js');\n`;

let providerInstallPromise = null;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function getProviderRuntimePaths(cwd = process.cwd()) {
  const root = path.resolve(cwd, '.runtime', 'bgutil-ytdlp-pot-provider', providerVersion);
  return Object.freeze({
    root,
    serverHome: path.join(root, 'server'),
    pluginDir: path.join(root, 'plugin'),
    cacheHome: path.resolve(cwd, '.runtime', 'cache'),
    receiptPath: path.join(root, 'receipt.json'),
  });
}

function isAllowedProviderDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && providerAllowedHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function fetchPinnedProviderAsset(url, {
  fetchImpl = globalThis.fetch,
  maxRedirects = 5,
  timeoutMs = providerDownloadTimeoutMs,
  maxBytes = providerMaxArchiveBytes,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('provider_fetch_unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let currentUrl = url;
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      if (!isAllowedProviderDownloadUrl(currentUrl)) throw new Error('provider_url_rejected');
      const response = await fetchImpl(currentUrl, {
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': `xiaoji-bgutil-bootstrap/${providerVersion}` },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.('location');
        if (!location || redirects === maxRedirects) throw new Error('provider_redirect_rejected');
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok || !response.body) throw new Error('provider_download_failed');
      const declaredHeader = response.headers?.get?.('content-length');
      if (declaredHeader !== null && declaredHeader !== undefined && String(declaredHeader).trim() !== '') {
        const declared = Number(declaredHeader);
        if (!Number.isFinite(declared) || declared <= 0 || declared > maxBytes) {
          throw new Error('provider_archive_size_invalid');
        }
      }
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) throw new Error('provider_archive_size_invalid');
        chunks.push(Buffer.from(chunk));
      }
      if (!total) throw new Error('provider_archive_empty');
      return Buffer.concat(chunks, total);
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error('provider_download_failed');
}

function normalizeArchivePath(value) {
  const normalized = String(value).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error('provider_archive_path_rejected');
  }
  return normalized;
}

function extractSelectedTarGz(buffer, selectedFiles) {
  const archive = zlib.gunzipSync(buffer, { maxOutputLength: 8 * 1024 * 1024 });
  const wanted = new Map(selectedFiles.map((file) => [file, null]));
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = normalizeArchivePath(prefix ? `${prefix}/${rawName}` : rawName);
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > providerMaxArchiveBytes) {
      throw new Error('provider_archive_entry_invalid');
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error('provider_archive_truncated');
    for (const selected of wanted.keys()) {
      if (name.endsWith(`/${selected}`)) wanted.set(selected, Buffer.from(archive.subarray(dataStart, dataEnd)));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if ([...wanted.values()].some((value) => !value)) throw new Error('provider_source_missing');
  return wanted;
}

function extractSelectedZip(buffer, selectedFiles) {
  const wanted = new Map(selectedFiles.map((file) => [file, null]));
  for (let offset = 0; offset + 46 <= buffer.length;) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = normalizeArchivePath(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    if (wanted.has(name)) {
      if (uncompressedSize > 256 * 1024 || localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error('provider_plugin_entry_invalid');
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      const output = method === 0 ? Buffer.from(compressed) : method === 8 ? zlib.inflateRawSync(compressed) : null;
      if (!output || output.length !== uncompressedSize) throw new Error('provider_plugin_entry_invalid');
      wanted.set(name, output);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if ([...wanted.values()].some((value) => !value)) throw new Error('provider_plugin_missing');
  return wanted;
}

function getCleanProviderEnv(cacheHome, baseEnv = process.env) {
  const env = { ...baseEnv, XDG_CACHE_HOME: cacheHome, TOKEN_TTL: '6', FORCE_COLOR: 'false' };
  for (const key of Object.keys(env)) {
    if (/^(?:all|http|https|no)_proxy$/i.test(key) || key === 'YT_DLP_PLUGIN_DIRS') delete env[key];
  }
  return env;
}

function getSpawnInvocation(command, args, platform = process.platform, env = process.env) {
  if (platform === 'win32' && /\.cmd$/i.test(command)) {
    return Object.freeze({
      command: env.ComSpec || 'cmd.exe',
      args: Object.freeze(['/d', '/c', command, ...args]),
    });
  }
  return Object.freeze({ command, args: Object.freeze([...args]) });
}

function runBoundedCommand(command, args, {
  cwd,
  env,
  spawnImpl = spawn,
  timeoutMs = providerCommandTimeoutMs,
  maxOutputBytes = 64 * 1024,
  platform = process.platform,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const invocation = getSpawnInvocation(command, args, platform, env);
      child = spawnImpl(invocation.command, invocation.args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      reject(new Error('provider_command_spawn_failed'));
      return;
    }
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => fail('provider_command_timeout'), timeoutMs);
    timer.unref?.();
    const onStdout = (chunk) => count(chunk);
    const onStderr = (chunk) => count(chunk);
    const onError = () => fail('provider_command_failed', true);
    const onClose = (code) => {
      if (code === 0) finish(resolve, undefined);
      else fail('provider_command_failed', false);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off?.('data', onStdout);
      child.stderr?.off?.('data', onStderr);
      child.off?.('error', onError);
      child.off?.('close', onClose);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = (code, shouldKill = true) => {
      if (settled) return;
      if (shouldKill) {
        try { if (!child.killed && child.exitCode === null) child.kill('SIGKILL'); } catch {}
      }
      finish(reject, new Error(code));
    };
    const count = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) fail('provider_command_output_limit');
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

async function hashFile(filePath, fsImpl = fs.promises) {
  return sha256(await fsImpl.readFile(filePath));
}

async function verifyProviderRuntime(paths = getProviderRuntimePaths(), fsImpl = fs.promises) {
  try {
    const receipt = JSON.parse(await fsImpl.readFile(paths.receiptPath, 'utf8'));
    if (receipt.version !== providerVersion || receipt.commit !== providerCommit || receipt.sourceSha256 !== providerSourceSha256 || receipt.pluginSha256 !== providerPluginSha256) return false;
    for (const [relativePath, expectedHash] of Object.entries(receipt.files || {})) {
      const target = path.resolve(paths.root, relativePath);
      if (!target.startsWith(`${paths.root}${path.sep}`) || await hashFile(target, fsImpl) !== expectedHash) return false;
    }
    return Object.keys(receipt.files || {}).length >= 8;
  } catch {
    return false;
  }
}

async function writeSelectedFiles(root, files, fsImpl = fs.promises) {
  for (const [relativePath, content] of files) {
    const target = path.resolve(root, relativePath);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('provider_write_path_rejected');
    await fsImpl.mkdir(path.dirname(target), { recursive: true });
    await fsImpl.writeFile(target, content, { flag: 'wx' });
  }
}

async function installPinnedPotProvider({
  cwd = process.cwd(),
  fetchImpl = globalThis.fetch,
  fsImpl = fs.promises,
  spawnImpl = spawn,
  npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm',
} = {}) {
  const paths = getProviderRuntimePaths(cwd);
  if (await verifyProviderRuntime(paths, fsImpl)) return paths;
  const source = await fetchPinnedProviderAsset(providerSourceUrl, { fetchImpl });
  const plugin = await fetchPinnedProviderAsset(providerPluginUrl, { fetchImpl });
  if (sha256(source) !== providerSourceSha256 || sha256(plugin) !== providerPluginSha256) throw new Error('provider_hash_mismatch');
  const staging = `${paths.root}.${process.pid}.${Date.now()}.tmp`;
  const stagingPaths = {
    root: staging,
    serverHome: path.join(staging, 'server'),
    pluginDir: path.join(staging, 'plugin'),
    receiptPath: path.join(staging, 'receipt.json'),
  };
  try {
    await fsImpl.mkdir(staging, { recursive: true });
    await writeSelectedFiles(staging, extractSelectedTarGz(source, providerSourceFiles), fsImpl);
    await writeSelectedFiles(path.join(staging, 'plugin'), extractSelectedZip(plugin, providerPluginFiles), fsImpl);
    const templateDir = path.resolve(cwd, 'deploy', 'ytdlp-pot-provider');
    for (const name of ['package.json', 'package-lock.json']) {
      await fsImpl.copyFile(path.join(templateDir, name), path.join(staging, 'server', name));
    }
    const env = getCleanProviderEnv(paths.cacheHome);
    await runBoundedCommand(npmCommand, ['ci', '--ignore-scripts'], { cwd: stagingPaths.serverHome, env, spawnImpl });
    await runBoundedCommand(npmCommand, [
      'exec', '--ignore-scripts', '--no', '--', 'tsc',
      'src/generate_once.ts', 'src/session_manager.ts', 'src/utils.ts',
      '--outDir', 'build', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'node',
      '--strictNullChecks', '--noImplicitAny', '--esModuleInterop', '--skipLibCheck', '--rewriteRelativeImportExtensions',
    ], { cwd: stagingPaths.serverHome, env, spawnImpl });
    const builtEntry = path.join(stagingPaths.serverHome, 'build', 'generate_once.js');
    await fsImpl.rename(builtEntry, path.join(stagingPaths.serverHome, 'build', 'generate_once_impl.js'));
    await fsImpl.writeFile(builtEntry, providerWrapper, { flag: 'wx' });
    await runBoundedCommand(process.execPath, [builtEntry, '--version'], { cwd: stagingPaths.serverHome, env, spawnImpl, timeoutMs: 10_000 });
    const critical = [
      'server/package.json', 'server/package-lock.json', 'server/build/generate_once.js',
      'server/build/generate_once_impl.js', 'server/build/session_manager.js', 'server/build/utils.js',
      ...providerPluginFiles.map((file) => `plugin/${file}`),
    ];
    const files = {};
    for (const relativePath of critical) files[relativePath] = await hashFile(path.join(staging, relativePath), fsImpl);
    await fsImpl.writeFile(stagingPaths.receiptPath, `${JSON.stringify({ version: providerVersion, commit: providerCommit, sourceSha256: providerSourceSha256, pluginSha256: providerPluginSha256, files }, null, 2)}\n`, { flag: 'wx' });
    await fsImpl.mkdir(path.dirname(paths.root), { recursive: true });
    await fsImpl.rm(paths.root, { recursive: true, force: true });
    await fsImpl.rename(staging, paths.root);
    await fsImpl.mkdir(paths.cacheHome, { recursive: true });
    return paths;
  } catch (error) {
    await fsImpl.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function ensurePinnedPotProvider(options = {}) {
  if (Object.keys(options).length) return installPinnedPotProvider(options);
  if (!providerInstallPromise) providerInstallPromise = installPinnedPotProvider().catch((error) => {
    providerInstallPromise = null;
    throw error;
  });
  return providerInstallPromise;
}

module.exports = {
  ensurePinnedPotProvider,
  extractSelectedTarGz,
  extractSelectedZip,
  fetchPinnedProviderAsset,
  getCleanProviderEnv,
  getProviderRuntimePaths,
  getSpawnInvocation,
  installPinnedPotProvider,
  isAllowedProviderDownloadUrl,
  normalizeArchivePath,
  providerCommit,
  providerPluginSha256,
  providerPluginUrl,
  providerSourceSha256,
  providerSourceUrl,
  providerVersion,
  providerWrapper,
  runBoundedCommand,
  sha256,
  verifyProviderRuntime,
};
