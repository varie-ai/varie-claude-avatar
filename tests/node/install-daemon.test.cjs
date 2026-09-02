const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  selectReleaseAsset,
  assertTrustedUrl,
  acquireLock,
  downloadAsset,
  installDaemon,
  MAX_REDIRECTS,
} = require('../../plugin/scripts/lib/install-daemon.cjs');

// Contractual release fixture.
//
// FORWARD DEPENDENCY: the Windows names below are the artifact names that
// Task 6 configures (`nsis.artifactName` / `portable.artifactName` =
// `${productName}-${version}-win-${arch}-setup|portable.${ext}`) and that Task 7
// publishes. At the Task 4 commit `daemon/package.json` still has no
// artifactName, so a real release does not yet carry these names; selection is
// written against the Task 6 contract on purpose.
//
// macOS names are NOT changed by Task 6 (it is Windows-only) and the spec
// requires the existing macOS ZIP behaviour to be preserved, so the macOS rule
// is "a .zip, with arm64 telling Apple Silicon from Intel".
const RELEASE = {
  tag_name: 'v0.3.0',
  assets: [
    {
      name: 'Varie-Claude-Avatar-0.3.0-win-x64-setup.exe',
      browser_download_url: 'https://github.com/varie-ai/varie-claude-avatar/releases/download/v0.3.0/setup.exe',
    },
    {
      name: 'Varie-Claude-Avatar-0.3.0-win-x64-portable.exe',
      browser_download_url: 'https://github.com/varie-ai/varie-claude-avatar/releases/download/v0.3.0/portable.exe',
    },
    {
      name: 'Varie-Claude-Avatar-0.3.0-mac-arm64.zip',
      browser_download_url: 'https://github.com/varie-ai/varie-claude-avatar/releases/download/v0.3.0/mac.zip',
    },
  ],
};

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** Fake https.get: no socket is ever opened. */
function makeHttpGet(routes) {
  const requested = [];
  const httpGet = (url, onResponse) => {
    requested.push(url);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};

    const route = typeof routes === 'function' ? routes(url) : routes[url];
    queueMicrotask(() => {
      if (!route) {
        request.emit('error', Object.assign(new Error('no route'), { code: 'ENOTFOUND' }));
        return;
      }
      const response = new EventEmitter();
      response.statusCode = route.statusCode ?? 200;
      response.headers = route.headers ?? {};
      response.resume = () => {};
      onResponse(response);
      queueMicrotask(() => {
        for (const chunk of route.body ?? []) response.emit('data', Buffer.from(chunk));
        response.emit('end');
      });
    });
    return request;
  };
  return { httpGet, requested };
}

/** Collects written bytes instead of touching the disk. */
function makeSink() {
  const sink = new EventEmitter();
  sink.bytes = 0;
  sink.write = (chunk) => { sink.bytes += chunk.length; return true; };
  sink.end = (callback) => { if (callback) callback(); };
  return sink;
}

// --- selectReleaseAsset -----------------------------------------------------

test('selects the Windows x64 setup installer, never the portable build', () => {
  const asset = selectReleaseAsset(RELEASE, 'win32', 'x64');

  assert.equal(asset.name, 'Varie-Claude-Avatar-0.3.0-win-x64-setup.exe');
  assert.equal(asset.url, 'https://github.com/varie-ai/varie-claude-avatar/releases/download/v0.3.0/setup.exe');
  assert.ok(!asset.name.includes('portable'));
});

test('a release offering only the portable build is not installable', () => {
  const portableOnly = { tag_name: 'v0.3.0', assets: [RELEASE.assets[1]] };

  assert.throws(
    () => selectReleaseAsset(portableOnly, 'win32', 'x64'),
    (error) => error.code === 'E_NO_ASSET',
  );
});

test('selects the macOS ZIP by architecture', () => {
  const arm = selectReleaseAsset(RELEASE, 'darwin', 'arm64');
  assert.equal(arm.name, 'Varie-Claude-Avatar-0.3.0-mac-arm64.zip');

  const intelRelease = {
    tag_name: 'v0.3.0',
    assets: [
      RELEASE.assets[2],
      {
        name: 'Varie-Claude-Avatar-0.3.0-mac.zip',
        browser_download_url: 'https://github.com/varie-ai/varie-claude-avatar/releases/download/v0.3.0/intel.zip',
      },
    ],
  };
  const intel = selectReleaseAsset(intelRelease, 'darwin', 'x64');
  assert.equal(intel.name, 'Varie-Claude-Avatar-0.3.0-mac.zip');
});

test('rejects unsupported architectures and platforms', () => {
  assert.throws(
    () => selectReleaseAsset(RELEASE, 'win32', 'arm64'),
    (error) => error.code === 'E_UNSUPPORTED_ARCH',
  );
  assert.throws(
    () => selectReleaseAsset(RELEASE, 'linux', 'x64'),
    (error) => error.code === 'E_UNSUPPORTED_PLATFORM',
  );
});

test('rejects a malformed release document', () => {
  for (const bad of [null, {}, { assets: 'nope' }, { assets: [{ name: 5 }] }]) {
    assert.throws(
      () => selectReleaseAsset(bad, 'win32', 'x64'),
      (error) => error.code === 'E_INVALID_RELEASE' || error.code === 'E_NO_ASSET',
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('rejects a matching asset served from a host outside GitHub', () => {
  const hostile = {
    tag_name: 'v0.3.0',
    assets: [{
      name: 'Varie-Claude-Avatar-0.3.0-win-x64-setup.exe',
      browser_download_url: 'https://evil.example.com/releases/download/v0.3.0/setup.exe',
    }],
  };

  assert.throws(
    () => selectReleaseAsset(hostile, 'win32', 'x64'),
    (error) => error.code === 'E_UNTRUSTED_HOST',
  );
});

// --- assertTrustedUrl -------------------------------------------------------

test('only HTTPS GitHub hosts are trusted', () => {
  assert.equal(assertTrustedUrl('https://github.com/a/b').host, 'github.com');
  assert.equal(assertTrustedUrl('https://objects.githubusercontent.com/x').host, 'objects.githubusercontent.com');

  const hostile = [
    'http://github.com/a/b',                     // plain HTTP
    'https://github.com.evil.example/a',         // suffix trick
    'https://evilgithub.com/a',                  // prefix trick
    'https://objects.githubusercontent.com.x/a', // suffix trick
    'file:///C:/Windows/System32/calc.exe',
    'https://user:pass@evil.example/a',
    'not a url',
  ];
  for (const url of hostile) {
    assert.throws(
      () => assertTrustedUrl(url),
      (error) => error.code === 'E_UNTRUSTED_HOST',
      `${url} must be refused`,
    );
  }
});

// --- downloadAsset ----------------------------------------------------------

test('follows GitHub redirects up to the bounded limit', async () => {
  const start = 'https://github.com/varie-ai/varie-claude-avatar/releases/download/v0.3.0/setup.exe';
  const hop = 'https://objects.githubusercontent.com/hop1';
  const { httpGet, requested } = makeHttpGet({
    [start]: { statusCode: 302, headers: { location: hop } },
    [hop]: { statusCode: 200, body: ['MZ-installer-bytes'] },
  });

  const sink = makeSink();
  const bytes = await downloadAsset(start, 'ignored', {
    httpGet,
    createWriteStream: () => sink,
  });

  assert.equal(bytes, 'MZ-installer-bytes'.length);
  assert.deepEqual(requested, [start, hop]);
});

test('refuses more than five redirects', async () => {
  const { httpGet } = makeHttpGet((url) => ({
    statusCode: 302,
    headers: { location: `https://objects.githubusercontent.com/next${url.length}` },
  }));

  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet, createWriteStream: makeSink }),
    (error) => error.code === 'E_TOO_MANY_REDIRECTS',
  );
  assert.equal(MAX_REDIRECTS, 5);
});

test('refuses a redirect that leaves the GitHub hosts', async () => {
  const start = 'https://github.com/a';
  const { httpGet } = makeHttpGet({
    [start]: { statusCode: 302, headers: { location: 'https://evil.example.com/payload.exe' } },
  });

  await assert.rejects(
    downloadAsset(start, 'ignored', { httpGet, createWriteStream: makeSink }),
    (error) => error.code === 'E_UNTRUSTED_HOST',
  );
});

test('refuses a non-200 response and an empty body', async () => {
  const notFound = makeHttpGet({ 'https://github.com/a': { statusCode: 404 } });
  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet: notFound.httpGet, createWriteStream: makeSink }),
    (error) => error.code === 'E_HTTP_STATUS',
  );

  const empty = makeHttpGet({ 'https://github.com/a': { statusCode: 200, body: [] } });
  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet: empty.httpGet, createWriteStream: makeSink }),
    (error) => error.code === 'E_EMPTY_DOWNLOAD',
  );
});

test('a download that never answers is bounded by a timeout', async () => {
  const httpGet = (_url, _onResponse) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.setTimeout = (_ms, callback) => { queueMicrotask(callback); };
    return request;
  };

  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet, createWriteStream: makeSink }),
    (error) => error.code === 'E_TIMEOUT',
  );
});

// --- acquireLock ------------------------------------------------------------

test('the lock is atomic: a live holder blocks a second installation', () => {
  const dir = makeTempDir('vca-lock-');
  const lockPath = path.join(dir, '.installing');

  try {
    const first = acquireLock(lockPath, { pid: 4242, isProcessAlive: () => true });
    assert.equal(fs.readFileSync(lockPath, 'utf8'), '4242');

    assert.throws(
      () => acquireLock(lockPath, { pid: 9999, isProcessAlive: () => true }),
      (error) => error.code === 'E_LOCKED',
    );

    first.release();
    assert.equal(fs.existsSync(lockPath), false, 'release must remove the lock');

    // Free again once released.
    acquireLock(lockPath, { pid: 5, isProcessAlive: () => true }).release();
  } finally {
    removeTempDir(dir);
  }
});

test('a stale lock left by a dead process is recovered', () => {
  const dir = makeTempDir('vca-lock-');
  const lockPath = path.join(dir, '.installing');

  try {
    fs.writeFileSync(lockPath, '123456');
    const lock = acquireLock(lockPath, { pid: 77, isProcessAlive: () => false });

    assert.equal(fs.readFileSync(lockPath, 'utf8'), '77', 'the new owner must take over');
    lock.release();
  } finally {
    removeTempDir(dir);
  }
});

test('a lock holding garbage is treated as stale', () => {
  const dir = makeTempDir('vca-lock-');
  const lockPath = path.join(dir, '.installing');

  try {
    fs.writeFileSync(lockPath, 'not-a-pid');
    const lock = acquireLock(lockPath, {
      pid: 88,
      isProcessAlive: () => { throw new Error('must not be consulted for garbage'); },
    });

    assert.equal(fs.readFileSync(lockPath, 'utf8'), '88');
    lock.release();
  } finally {
    removeTempDir(dir);
  }
});

// --- installDaemon ----------------------------------------------------------

function windowsInstallOptions(overrides = {}) {
  const home = makeTempDir('vca-home-');
  const tmp = makeTempDir('vca-tmp-');
  const localAppData = path.join(home, 'AppData', 'Local');
  const installedExe = path.join(localAppData, 'Programs', 'Varie Claude Avatar', 'Varie Claude Avatar.exe');
  const spawns = [];
  const logs = [];

  const download = makeHttpGet({
    'https://github.com/varie-ai/varie-claude-avatar/releases/download/v0.3.0/setup.exe': {
      statusCode: 200,
      body: ['MZ-fake-installer'],
    },
  });

  const options = {
    platform: 'win32',
    arch: 'x64',
    env: { LOCALAPPDATA: localAppData },
    homedir: home,
    tmpdir: tmp,
    fetchRelease: async () => RELEASE,
    httpGet: download.httpGet,
    isProcessAlive: () => false,
    log: (message) => logs.push(message),
    spawn: (command, args, spawnOptions) => {
      spawns.push({ command, args, options: spawnOptions });
      const child = new EventEmitter();
      // The silent installer "creates" the executable, then exits cleanly.
      queueMicrotask(() => {
        fs.mkdirSync(path.dirname(installedExe), { recursive: true });
        fs.writeFileSync(installedExe, 'exe');
        child.emit('exit', 0, null);
      });
      return child;
    },
    ...overrides,
  };

  return { options, spawns, logs, home, tmp, installedExe, cleanup: () => { removeTempDir(home); removeTempDir(tmp); } };
}

test('installs on Windows with a silent argument vector and verifies the executable', async () => {
  const ctx = windowsInstallOptions();

  try {
    const installedPath = await installDaemon(ctx.options);

    assert.equal(installedPath, ctx.installedExe);
    assert.equal(ctx.spawns.length, 1);
    assert.deepEqual(ctx.spawns[0].args, ['/S'], 'the installer must run silently through an argument vector');
    assert.match(ctx.spawns[0].command, /setup\.exe$/);
    assert.equal(ctx.spawns[0].options.shell, undefined, 'never through a shell');
    assert.equal(ctx.spawns[0].options.windowsHide, true);
    assert.ok(ctx.logs.some((line) => line.includes('v0.3.0')), 'the version must be logged');
    assert.ok(
      ctx.logs.some((line) => line.includes('Varie-Claude-Avatar-0.3.0-win-x64-setup.exe')),
      'the selected asset name must be logged',
    );
  } finally {
    ctx.cleanup();
  }
});

test('the lock and the temporary directory are always removed', async () => {
  const ctx = windowsInstallOptions();

  try {
    await installDaemon(ctx.options);

    assert.equal(fs.existsSync(path.join(ctx.home, '.varie-claude-avatar', '.installing')), false);
    assert.deepEqual(fs.readdirSync(ctx.tmp), [], 'no temporary download directory may survive');
  } finally {
    ctx.cleanup();
  }
});

test('cleanup also happens when the installation fails', async () => {
  const ctx = windowsInstallOptions({
    fetchRelease: async () => { throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }); },
  });

  try {
    await assert.rejects(installDaemon(ctx.options), (error) => error.code === 'ENOTFOUND');

    assert.equal(fs.existsSync(path.join(ctx.home, '.varie-claude-avatar', '.installing')), false);
    assert.deepEqual(fs.readdirSync(ctx.tmp), []);
  } finally {
    ctx.cleanup();
  }
});

test('a non-zero installer exit code fails the installation', async () => {
  const ctx = windowsInstallOptions({
    spawn: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    },
  });

  try {
    await assert.rejects(installDaemon(ctx.options), (error) => error.code === 'E_INSTALLER_EXIT');
  } finally {
    ctx.cleanup();
  }
});

test('an installer that exits cleanly without producing the executable is rejected', async () => {
  const ctx = windowsInstallOptions({
    spawn: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    },
  });

  try {
    await assert.rejects(installDaemon(ctx.options), (error) => error.code === 'E_INSTALL_VERIFICATION');
  } finally {
    ctx.cleanup();
  }
});

test('a concurrent installation is refused instead of running twice', async () => {
  const ctx = windowsInstallOptions({ isProcessAlive: () => true });
  const stateDir = path.join(ctx.home, '.varie-claude-avatar');

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.installing'), '4242');

    await assert.rejects(installDaemon(ctx.options), (error) => error.code === 'E_LOCKED');
    assert.equal(ctx.spawns.length, 0, 'a blocked installation must not spawn anything');
    assert.equal(
      fs.readFileSync(path.join(stateDir, '.installing'), 'utf8'),
      '4242',
      'the running installation keeps its lock',
    );
  } finally {
    ctx.cleanup();
  }
});

test('macOS extracts the ZIP through ditto with an argument vector', async () => {
  const home = makeTempDir('vca-home-');
  const tmp = makeTempDir('vca-tmp-');
  const appPath = `${home}/Applications/Varie Claude Avatar.app`;
  const spawns = [];

  const download = makeHttpGet({
    'https://github.com/varie-ai/varie-claude-avatar/releases/download/v0.3.0/mac.zip': {
      statusCode: 200,
      body: ['PK-fake-zip'],
    },
  });

  try {
    const installedPath = await installDaemon({
      platform: 'darwin',
      arch: 'arm64',
      env: {},
      homedir: home,
      tmpdir: tmp,
      fetchRelease: async () => RELEASE,
      httpGet: download.httpGet,
      isProcessAlive: () => false,
      exists: (candidate) => candidate === appPath,
      log: () => {},
      spawn: (command, args, options) => {
        spawns.push({ command, args, options });
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 0, null));
        return child;
      },
    });

    assert.equal(installedPath, appPath);
    assert.equal(spawns[0].command, '/usr/bin/ditto');
    assert.equal(spawns[0].args[0], '-x');
    assert.equal(spawns[0].args[1], '-k');
    assert.match(spawns[0].args[2], /mac-arm64\.zip$/);
    assert.equal(spawns[0].args[3], `${home}/Applications`);
    assert.equal(spawns[0].args.length, 4);
  } finally {
    removeTempDir(home);
    removeTempDir(tmp);
  }
});

// --- compatibility wrapper --------------------------------------------------

test('the install-daemon shell entry point is only a wrapper around the Node installer', () => {
  const wrapperPath = path.join(__dirname, '..', '..', 'plugin', 'scripts', 'install-daemon');
  const wrapper = fs.readFileSync(wrapperPath, 'utf8');

  assert.match(wrapper, /exec node "\$SCRIPT_DIR\/lib\/install-daemon\.cjs" "\$@"/);
  assert.match(wrapper, /deprecated/i);

  // The download, extraction and locking logic now lives in the Node module.
  for (const legacy of ['curl', 'unzip', 'mktemp', 'OSTYPE', 'browser_download_url', 'LOCK_FILE']) {
    assert.ok(!wrapper.includes(legacy), `the wrapper must no longer implement ${legacy}`);
  }
});
