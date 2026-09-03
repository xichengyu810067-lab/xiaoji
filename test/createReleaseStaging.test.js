const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    cp.execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        code: error?.code ?? 0,
        error,
        stdout,
        stderr,
      });
    });
  });
}

function removeIfExists(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function listFiles(dir, baseDir = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let outputs = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    const relative = path.relative(baseDir, entryPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      outputs = outputs.concat(listFiles(entryPath, baseDir));
      continue;
    }
    outputs.push(relative);
  }
  return outputs;
}

async function getTrackedFiles(rootDir) {
  const result = runCommand('git', ['-C', rootDir, 'ls-files', '-z']);
  const resolved = await result;
  assert.equal(resolved.code, 0, `git ls-files failed: ${resolved.stderr}`);
  return resolved.stdout
    .split('\u0000')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function getReleaseManifest(trackedFiles) {
  const allowedRoots = new Set(['docs', 'logs', 'scripts', 'src', 'website', 'test']);

  return trackedFiles
    .filter((file) => {
      if (!file.includes('/')) {
        return true;
      }

      const first = file.split('/')[0];
      return allowedRoots.has(first);
    })
    .map((file) => path.normalize(file).replace(/\\/g, '/'))
    .sort();
}

function makeUniqueStagingDir(root) {
  const id = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  return path.join(root, '.release-upload', `release-${id}`);
}

function runCreateReleaseStaging(root, destination) {
  const script = path.join(root, 'scripts', 'create-release-staging.ps1');

  return runCommand('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Destination',
    destination,
  ], {
    env: process.env,
    encoding: 'utf8',
  });
}

test('create-release-staging packs full website contents and excludes runtime artifacts', async () => {
  const root = process.cwd();
  const stagingTarget = makeUniqueStagingDir(root);
  const trackedFiles = await getTrackedFiles(root);
  const releaseManifest = getReleaseManifest(trackedFiles);

  try {
    const destination = path.relative(root, stagingTarget);
    const result = await runCreateReleaseStaging(root, destination);

    assert.equal(result.code, 0, `Expected script to succeed. stdout=${result.stdout} stderr=${result.stderr}`);

    const sourceWebsiteDir = path.join(root, 'website');
    const targetWebsiteDir = path.join(stagingTarget, 'website');

    assert.ok(fs.existsSync(targetWebsiteDir), 'website directory should be created in staging');

    const sourceFiles = listFiles(sourceWebsiteDir).sort();
    const stagedFiles = listFiles(targetWebsiteDir).sort();
    assert.deepStrictEqual(stagedFiles, sourceFiles, 'staged website files should match source website files exactly');

    const stagedTrackedFiles = listFiles(stagingTarget).sort();
    const releaseSet = new Set(releaseManifest);
    const generatedPlaceholders = new Set([
      'data/.gitkeep',
      'logs/.gitkeep',
      'src/data/.gitkeep',
    ]);
    const helpers = [
      'scripts/auto-nyanko.js',
      'scripts/auto-nyanko-debug.js',
      'scripts/fix-nyanko-files.js',
      'scripts/recover-nyanko.js',
    ];

    for (const stagedFile of stagedTrackedFiles) {
      if (generatedPlaceholders.has(stagedFile)) {
        continue;
      }
      assert.ok(releaseSet.has(stagedFile), `Staging contains file outside tracked manifest: ${stagedFile}`);
    }

    for (const helper of helpers) {
      assert.equal(
        stagedTrackedFiles.includes(path.normalize(helper).replace(/\\/g, '/')),
        false,
        `Host helper should not be included: ${helper}`,
      );
    }

    for (const tracked of releaseSet) {
      const trackedPath = path.join(stagingTarget, tracked);
      assert.ok(
        fs.existsSync(trackedPath),
        `Tracked manifest file should be present in staging: ${tracked}`,
      );
    }

    const forbiddenFiles = [
      '.env',
      'question.md',
      'node_modules',
      path.join('data', 'discord-guilds.json'),
      path.join('src', 'data', 'guildConfig.json'),
      'database',
      'storage',
    ];

    for (const forbidden of forbiddenFiles) {
      assert.equal(fs.existsSync(path.join(stagingTarget, forbidden)), false, `Forbidden staging path exists: ${forbidden}`);
    }

    const dataEntries = fs.existsSync(path.join(stagingTarget, 'data'))
      ? listFiles(path.join(stagingTarget, 'data'))
      : [];
    assert.equal(
      dataEntries.includes('guilds.json'),
      false,
      'Runtime data should not be included in staging data directory',
    );

    const srcDataEntries = fs.existsSync(path.join(stagingTarget, 'src', 'data'))
      ? listFiles(path.join(stagingTarget, 'src', 'data'))
      : [];
    assert.ok(srcDataEntries.every((entry) => entry === '.gitkeep'), 'Runtime src data should be cleaned before packing');

    const logsEntries = fs.existsSync(path.join(stagingTarget, 'logs'))
      ? listFiles(path.join(stagingTarget, 'logs'))
      : [];
    assert.ok(logsEntries.every((entry) => entry === '.gitkeep'), 'Runtime logs payload should be reset in staging');
  } finally {
    removeIfExists(stagingTarget);
  }
});

test('create-release-staging rejects sibling destination outside root', async () => {
  const root = process.cwd();
  const parent = path.dirname(root);
  const siblingDestination = path.join(parent, `${path.basename(root)}-backup-${Date.now()}-${Math.floor(Math.random() * 1000000)}`);
  const stagingCandidate = path.join(siblingDestination, '.release-upload', `sibling-${Date.now()}`);

  const existedBefore = fs.existsSync(stagingCandidate);
  const existedSiblingBefore = fs.existsSync(siblingDestination);

  try {
    const result = await runCreateReleaseStaging(root, stagingCandidate);

    assert.notEqual(result.code, 0, 'Expected script to fail for sibling destination');
    assert.match(
      result.stderr + result.stdout,
      /Destination must stay inside the project directory/,
      'Expected sibling containment error',
    );

    assert.equal(fs.existsSync(stagingCandidate), false, 'Sibling staging candidate must not be created');
    assert.equal(fs.existsSync(siblingDestination), existedSiblingBefore, 'Sibling destination itself should remain untouched');
  } finally {
    if (!existedSiblingBefore) {
      removeIfExists(siblingDestination);
    }
  }
});

test('create-release-staging rejects destination resolved to project root', async () => {
  const root = process.cwd();
  const destination = root;

  const result = await runCreateReleaseStaging(root, destination);

  assert.notEqual(result.code, 0, 'Expected script to fail when destination resolves to root');
  assert.match(
    result.stderr + result.stdout,
    /Destination must stay inside the project directory/,
    'Expected root containment error',
  );
  assert.ok(fs.existsSync(root), 'Root should remain intact');
});
