const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  getMusicUserFacingError,
  isPrivateYouTubeCookieAccess,
  isYtdlpCookieConfigurationError,
} = require('../src/services/musicService');
const {
  buildYtdlpAudioArgs,
  buildYtdlpMetadataArgs,
  loadYtdlpYouTubeAudio,
  resolveYtdlpCookiePath,
  validateYtdlpCookieFile,
  ytdlpMaxCookieBytes,
} = require('../src/services/youtubeYtdlpSource');

const videoId = 'dQw4w9WgXcQ';
const providerPaths = Object.freeze({
  pluginDir: '/runtime/provider/plugin',
  serverHome: '/runtime/provider/server',
  cacheHome: '/runtime/cache',
});

function createCookieFixture(t, { header = '# Netscape HTTP Cookie File', body = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-cookie-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cookiePath = path.join(root, 'youtube.cookies.txt');
  const cookieBody = body ?? `${header}\n.example\tTRUE\t/\tTRUE\t0\tSID\tsynthetic-private-value\n`;
  fs.writeFileSync(cookiePath, cookieBody, { mode: 0o600 });
  fs.chmodSync(cookiePath, 0o600);
  return { root, cookiePath };
}

function createChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function createSuccessfulSpawn(calls) {
  return (binaryPath, args, options) => {
    calls.push({ binaryPath, args, options });
    const child = createChild();
    if (calls.length === 1) {
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({
          id: videoId,
          title: 'Synthetic track',
          duration: 120,
          live_status: 'not_live',
        }));
        child.stderr.end();
        child.emit('close', 0);
      });
    }
    return child;
  };
}

function loadWithSpawn(spawnImpl, options = {}) {
  return loadYtdlpYouTubeAudio(`https://www.youtube.com/watch?v=${videoId}`, {
    ensureBinary: async () => '/runtime/yt-dlp',
    ensureProvider: async () => providerPaths,
    spawnImpl,
    platform: 'win32',
    ...options,
  });
}

test('cookie path is optional and anonymous behavior remains the default', async () => {
  assert.equal(await resolveYtdlpCookiePath({ allowCookies: true, env: {} }), null);
  assert.equal(
    await resolveYtdlpCookiePath({
      allowCookies: false,
      env: { YOUTUBE_COOKIES_PATH: 'deliberately-invalid-relative-path' },
    }),
    null
  );

  for (const args of [
    buildYtdlpMetadataArgs(videoId, '/opt/node', providerPaths),
    buildYtdlpAudioArgs(videoId, '/opt/node', providerPaths),
  ]) {
    assert.equal(args.includes('--cookies'), false);
  }
});

test('a valid explicit Netscape file is selected without returning its contents', async (t) => {
  const { cookiePath } = createCookieFixture(t);
  const resolved = await resolveYtdlpCookiePath({
    allowCookies: true,
    env: { YOUTUBE_COOKIES_PATH: cookiePath },
    platform: 'win32',
  });
  assert.equal(resolved, path.resolve(cookiePath));
  assert.doesNotMatch(resolved, /synthetic-private-value/);
});

test('metadata and audio subprocesses receive the same validated cookie path', async (t) => {
  const { cookiePath } = createCookieFixture(t);
  const calls = [];
  const result = await loadWithSpawn(createSuccessfulSpawn(calls), {
    allowCookies: true,
    env: { YOUTUBE_COOKIES_PATH: cookiePath },
  });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.args.filter((arg) => arg === '--cookies').length, 1);
    assert.equal(call.args[call.args.indexOf('--cookies') + 1], path.resolve(cookiePath));
    assert.equal(call.args.includes('--cookies-from-browser'), false);
    assert.equal(call.options.shell, undefined);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(call.options.env.YOUTUBE_COOKIES_PATH, undefined);
    assert.doesNotMatch(JSON.stringify(call.options.env), /youtube\.cookies\.txt|synthetic-private-value/);
  }
  assert.equal(result.track.title, 'Synthetic track');
  result.sourceProcess.kill('SIGKILL');
});

test('non-private loader entry ignores a configured cookie path', async (t) => {
  const { cookiePath } = createCookieFixture(t);
  const calls = [];
  const result = await loadWithSpawn(createSuccessfulSpawn(calls), {
    env: { YOUTUBE_COOKIES_PATH: cookiePath },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.args.includes('--cookies')), false);
  result.sourceProcess.kill('SIGKILL');
});

test('cookie validation fails closed for unsafe paths, files, size, format, and permissions', async (t) => {
  const { root, cookiePath } = createCookieFixture(t);
  const missing = path.join(root, 'missing.cookies.txt');
  const directory = path.join(root, 'directory');
  const empty = path.join(root, 'empty.cookies.txt');
  const oversized = path.join(root, 'oversized.cookies.txt');
  const wrongFormat = path.join(root, 'wrong-format.cookies.txt');
  fs.mkdirSync(directory);
  fs.writeFileSync(empty, '');
  fs.writeFileSync(oversized, Buffer.alloc(ytdlpMaxCookieBytes + 1));
  fs.writeFileSync(wrongFormat, 'SID=synthetic-private-value\n');

  const cases = [
    ['relative.cookies.txt', 'youtube_local_cookie_path_invalid'],
    [missing, 'youtube_local_cookie_access_failed'],
    [directory, 'youtube_local_cookie_file_invalid'],
    [empty, 'youtube_local_cookie_size_invalid'],
    [oversized, 'youtube_local_cookie_size_invalid'],
    [wrongFormat, 'youtube_local_cookie_format_invalid'],
  ];
  for (const [configuredPath, code] of cases) {
    await assert.rejects(
      validateYtdlpCookieFile(configuredPath, { platform: 'win32' }),
      (error) => error.code === code && !JSON.stringify(error).includes('synthetic-private-value')
    );
  }

  fs.chmodSync(cookiePath, 0o644);
  await assert.rejects(
    validateYtdlpCookieFile(cookiePath, { platform: 'linux' }),
    (error) => error.code === 'youtube_local_cookie_permissions_invalid'
  );

  await assert.rejects(
    validateYtdlpCookieFile(cookiePath, {
      platform: 'linux',
      ownerUid: 1000,
      fsImpl: {
        lstat: async () => ({
          size: 64,
          mode: 0o600,
          uid: 1001,
          isFile: () => true,
          isSymbolicLink: () => false,
        }),
      },
    }),
    (error) => error.code === 'youtube_local_cookie_permissions_invalid'
  );

  const symlinkStat = {
    size: 64,
    mode: 0o600,
    isFile: () => true,
    isSymbolicLink: () => true,
  };
  await assert.rejects(
    validateYtdlpCookieFile(cookiePath, {
      platform: 'win32',
      fsImpl: { lstat: async () => symlinkStat },
    }),
    (error) => error.code === 'youtube_local_cookie_file_invalid'
  );
});

test('spawn failures expose neither the cookie path nor cookie contents', async (t) => {
  const { cookiePath } = createCookieFixture(t);
  await assert.rejects(
    loadWithSpawn(
      () => {
        throw new Error(`spawn failed ${cookiePath} synthetic-private-value`);
      },
      {
        allowCookies: true,
        env: { YOUTUBE_COOKIES_PATH: cookiePath },
      }
    ),
    (error) => {
      const serialized = `${error.message} ${JSON.stringify(error)}`;
      assert.equal(error.code, 'youtube_local_source_failed');
      assert.doesNotMatch(serialized, /synthetic-private-value|youtube\.cookies\.txt|xiaoji-cookie-test-/);
      return true;
    }
  );
});

test('cookie access requires exact standard owner and guild identifiers', () => {
  const env = { BOT_OWNER_ID: 'owner-1', DISCORD_GUILD_ID: 'guild-1' };
  assert.equal(isPrivateYouTubeCookieAccess({ guild: { id: 'guild-1' }, requestedBy: 'owner-1' }, env), true);
  assert.equal(isPrivateYouTubeCookieAccess({ guild: { id: 'guild-2' }, requestedBy: 'owner-1' }, env), false);
  assert.equal(isPrivateYouTubeCookieAccess({ guild: { id: 'guild-1' }, requestedBy: 'admin-1' }, env), false);
  assert.equal(
    isPrivateYouTubeCookieAccess(
      { guild: { id: 'guild-1' }, requestedBy: 'owner-1' },
      { OWNER_ID: 'owner-1', GUILD_ID: 'guild-1' }
    ),
    false
  );
  assert.equal(isYtdlpCookieConfigurationError({ code: 'youtube_local_cookie_format_invalid' }), true);
  assert.equal(isYtdlpCookieConfigurationError({ code: 'youtube_local_info_failed' }), false);

  const userMessage = getMusicUserFacingError({ code: 'youtube_local_cookie_format_invalid' });
  assert.match(userMessage, /YOUTUBE_COOKIES_PATH|Netscape/);
  assert.doesNotMatch(userMessage, /synthetic-private-value|youtube\.cookies\.txt|xiaoji-cookie-test-/);

  const musicServiceSource = fs.readFileSync(path.join(__dirname, '../src/services/musicService.js'), 'utf8');
  assert.match(
    musicServiceSource,
    /catch \(localError\) \{\s*if \(isYtdlpCookieConfigurationError\(localError\)\) throw localError;/
  );
});
