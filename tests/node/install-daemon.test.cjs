const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const {
  selectReleaseAsset,
  assertTrustedUrl,
  acquireLock,
  downloadAsset,
  fetchLatestRelease,
  installDaemon,
  runCli,
  MAX_REDIRECTS,
  RELEASE_API_URL,
  RELEASE_API_HOSTS,
  DOWNLOAD_HOSTS,
  USER_AGENT,
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
const SETUP_URL = 'https://github.com/varie-ai/varie-claude-avatar/releases/download/v0.3.0/setup.exe';
const MAC_URL = 'https://github.com/varie-ai/varie-claude-avatar/releases/download/v0.3.0/mac.zip';

const RELEASE = {
  tag_name: 'v0.3.0',
  assets: [
    { name: 'Varie-Claude-Avatar-0.3.0-win-x64-setup.exe', browser_download_url: SETUP_URL },
    {
      name: 'Varie-Claude-Avatar-0.3.0-win-x64-portable.exe',
      browser_download_url: 'https://github.com/varie-ai/varie-claude-avatar/releases/download/v0.3.0/portable.exe',
    },
    { name: 'Varie-Claude-Avatar-0.3.0-mac-arm64.zip', browser_download_url: MAC_URL },
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

function bodyStream(chunks) {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk)), { objectMode: false });
}

/**
 * Fake https.get. No socket is ever opened, and every call is recorded with the
 * URL and the request options so header and allowlist behaviour is assertable.
 */
function makeHttpGet(routes) {
  const calls = [];
  const httpGet = (url, options, onResponse) => {
    calls.push({ url, options });

    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};

    const route = typeof routes === 'function' ? routes(url) : routes[url];
    queueMicrotask(() => {
      if (!route) {
        request.emit('error', Object.assign(new Error('no route'), { code: 'ENOTFOUND' }));
        return;
      }
      const response = route.stream ? route.stream() : bodyStream(route.body ?? []);
      response.statusCode = route.statusCode ?? 200;
      response.headers = route.headers ?? {};
      onResponse(response);
    });

    return request;
  };
  return { httpGet, calls };
}

/** Writable that records how much data ever queued behind it. */
function makeCountingSink({ highWaterMark = 64, slow = false } = {}) {
  let maxBuffered = 0;
  let bytes = 0;
  const sink = new Writable({
    highWaterMark,
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      maxBuffered = Math.max(maxBuffered, sink.writableLength);
      if (slow) setImmediate(callback);
      else callback();
    },
  });
  Object.defineProperty(sink, 'bytesWritten', { get: () => bytes });
  Object.defineProperty(sink, 'maxBuffered', { get: () => maxBuffered });
  return sink;
}

// --- selectReleaseAsset -----------------------------------------------------

test('selects the Windows x64 setup installer, never the portable build', () => {
  const asset = selectReleaseAsset(RELEASE, 'win32', 'x64');

  assert.equal(asset.name, 'Varie-Claude-Avatar-0.3.0-win-x64-setup.exe');
  assert.equal(asset.url, SETUP_URL);
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
  assert.equal(selectReleaseAsset(intelRelease, 'darwin', 'x64').name, 'Varie-Claude-Avatar-0.3.0-mac.zip');
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

test('an asset advertised on the API host is not a download host', () => {
  const apiHosted = {
    tag_name: 'v0.3.0',
    assets: [{
      name: 'Varie-Claude-Avatar-0.3.0-win-x64-setup.exe',
      browser_download_url: 'https://api.github.com/repos/varie-ai/varie-claude-avatar/releases/assets/1',
    }],
  };

  assert.throws(
    () => selectReleaseAsset(apiHosted, 'win32', 'x64'),
    (error) => error.code === 'E_UNTRUSTED_HOST',
  );
});

// --- allowlists -------------------------------------------------------------

test('the release API and the asset download use separate allowlists', () => {
  assert.equal(assertTrustedUrl('https://api.github.com/x', RELEASE_API_HOSTS).hostname, 'api.github.com');
  assert.equal(assertTrustedUrl('https://github.com/x', DOWNLOAD_HOSTS).hostname, 'github.com');
  assert.equal(assertTrustedUrl('https://objects.githubusercontent.com/x', DOWNLOAD_HOSTS).hostname, 'objects.githubusercontent.com');

  assert.throws(
    () => assertTrustedUrl('https://github.com/x', RELEASE_API_HOSTS),
    (error) => error.code === 'E_UNTRUSTED_HOST',
    'the release API allowlist must not accept a download host',
  );
  assert.throws(
    () => assertTrustedUrl('https://api.github.com/x', DOWNLOAD_HOSTS),
    (error) => error.code === 'E_UNTRUSTED_HOST',
    'the download allowlist must not accept the API host',
  );
});

test('only HTTPS GitHub hosts are trusted', () => {
  const hostile = [
    'http://github.com/a/b',
    'https://github.com.evil.example/a',
    'https://evilgithub.com/a',
    'https://objects.githubusercontent.com.x/a',
    'file:///C:/Windows/System32/calc.exe',
    'https://user:pass@evil.example/a',
    'https://github.com:8443/a',
    'not a url',
  ];
  for (const url of hostile) {
    assert.throws(
      () => assertTrustedUrl(url, DOWNLOAD_HOSTS),
      (error) => error.code === 'E_UNTRUSTED_HOST',
      `${url} must be refused`,
    );
  }
});

// --- request headers --------------------------------------------------------

test('an asset download identifies itself with an application User-Agent', async () => {
  const { httpGet, calls } = makeHttpGet({ [SETUP_URL]: { body: ['MZ'] } });

  await downloadAsset(SETUP_URL, 'ignored', { httpGet, createWriteStream: () => makeCountingSink() });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SETUP_URL);
  assert.equal(typeof calls[0].options, 'object');
  assert.equal(calls[0].options.headers['User-Agent'], USER_AGENT);
  assert.match(USER_AGENT, /varie-claude-avatar/i);
  assert.notEqual(
    calls[0].options.headers.Accept,
    'application/vnd.github+json',
    'a download is not an API call',
  );
});

test('the release API request sends the GitHub Accept header and the User-Agent', async () => {
  const { httpGet, calls } = makeHttpGet({
    [RELEASE_API_URL]: { body: [JSON.stringify(RELEASE)] },
  });

  const release = await fetchLatestRelease({ httpGet });

  assert.equal(release.tag_name, 'v0.3.0');
  assert.equal(calls[0].url, RELEASE_API_URL);
  assert.equal(calls[0].options.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].options.headers['User-Agent'], USER_AGENT);
});

test('the release API may not redirect off the API host', async () => {
  const { httpGet } = makeHttpGet({
    [RELEASE_API_URL]: { statusCode: 302, headers: { location: 'https://github.com/elsewhere' } },
  });

  await assert.rejects(
    fetchLatestRelease({ httpGet }),
    (error) => error.code === 'E_UNTRUSTED_HOST',
  );
});

// --- downloadAsset ----------------------------------------------------------

test('follows GitHub redirects up to the bounded limit', async () => {
  const hop = 'https://objects.githubusercontent.com/hop1';
  const { httpGet, calls } = makeHttpGet({
    [SETUP_URL]: { statusCode: 302, headers: { location: hop } },
    [hop]: { body: ['MZ-installer-bytes'] },
  });

  const sink = makeCountingSink();
  const bytes = await downloadAsset(SETUP_URL, 'ignored', { httpGet, createWriteStream: () => sink });

  assert.equal(bytes, 'MZ-installer-bytes'.length);
  assert.deepEqual(calls.map((call) => call.url), [SETUP_URL, hop]);
});

test('refuses more than five redirects', async () => {
  const { httpGet } = makeHttpGet((url) => ({
    statusCode: 302,
    headers: { location: `https://objects.githubusercontent.com/next${url.length}` },
  }));

  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet, createWriteStream: () => makeCountingSink() }),
    (error) => error.code === 'E_TOO_MANY_REDIRECTS',
  );
  assert.equal(MAX_REDIRECTS, 5);
});

test('refuses a redirect that leaves the GitHub download hosts', async () => {
  const { httpGet } = makeHttpGet({
    'https://github.com/a': { statusCode: 302, headers: { location: 'https://evil.example.com/payload.exe' } },
  });

  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet, createWriteStream: () => makeCountingSink() }),
    (error) => error.code === 'E_UNTRUSTED_HOST',
  );
});

test('refuses a non-200 response and an empty body', async () => {
  const notFound = makeHttpGet({ 'https://github.com/a': { statusCode: 404 } });
  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet: notFound.httpGet, createWriteStream: () => makeCountingSink() }),
    (error) => error.code === 'E_HTTP_STATUS',
  );

  const empty = makeHttpGet({ 'https://github.com/a': { body: [] } });
  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet: empty.httpGet, createWriteStream: () => makeCountingSink() }),
    (error) => error.code === 'E_EMPTY_DOWNLOAD',
  );
});

test('a download that never answers is bounded by a timeout', async () => {
  const httpGet = (_url, _options, _onResponse) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.setTimeout = (_ms, callback) => { queueMicrotask(callback); };
    return request;
  };

  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet, createWriteStream: () => makeCountingSink() }),
    (error) => error.code === 'E_TIMEOUT',
  );
});

test('the download respects backpressure instead of buffering the whole asset', async () => {
  const chunkCount = 200;
  const chunkSize = 64;
  const chunks = Array.from({ length: chunkCount }, () => 'x'.repeat(chunkSize));
  const { httpGet } = makeHttpGet({ 'https://github.com/a': { body: chunks } });

  const sink = makeCountingSink({ highWaterMark: 64, slow: true });
  const bytes = await downloadAsset('https://github.com/a', 'ignored', {
    httpGet,
    createWriteStream: () => sink,
  });

  assert.equal(bytes, chunkCount * chunkSize);
  assert.equal(sink.bytesWritten, chunkCount * chunkSize);
  assert.ok(
    sink.maxBuffered <= 10 * chunkSize,
    `a slow sink must throttle the source, peak buffer was ${sink.maxBuffered} bytes`,
  );
});

test('a failing sink aborts the download and destroys both streams', async () => {
  let response = null;
  const { httpGet } = makeHttpGet({
    'https://github.com/a': {
      stream: () => {
        response = bodyStream(['a'.repeat(1024), 'b'.repeat(1024)]);
        return response;
      },
    },
  });

  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    },
  });

  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet, createWriteStream: () => sink }),
    (error) => error.code === 'ENOSPC',
  );

  assert.equal(sink.destroyed, true, 'the file stream must be closed');
  assert.equal(response.destroyed, true, 'the response must be destroyed');
});

test('a response that fails mid-stream aborts the download and destroys the sink', async () => {
  const { httpGet } = makeHttpGet({
    'https://github.com/a': {
      stream: () => {
        let sent = 0;
        return new Readable({
          read() {
            sent += 1;
            if (sent === 1) {
              this.push(Buffer.from('partial'));
              return;
            }
            this.destroy(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
          },
        });
      },
    },
  });

  const sink = makeCountingSink();
  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet, createWriteStream: () => sink }),
    (error) => error.code === 'ECONNRESET',
  );

  assert.equal(sink.destroyed, true, 'the file stream must be closed');
});

test('a response aborted before end is not treated as a complete download', async () => {
  const { httpGet } = makeHttpGet({
    'https://github.com/a': {
      stream: () => {
        let sent = 0;
        return new Readable({
          read() {
            sent += 1;
            if (sent === 1) {
              this.push(Buffer.from('partial'));
              return;
            }
            this.destroy();
          },
        });
      },
    },
  });

  const sink = makeCountingSink();
  await assert.rejects(
    downloadAsset('https://github.com/a', 'ignored', { httpGet, createWriteStream: () => sink }),
    (error) => error.code === 'E_DOWNLOAD_INCOMPLETE',
  );
  assert.equal(sink.destroyed, true);
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
    assert.deepEqual(fs.readdirSync(dir), ['.installing'], 'no quarantine file may survive');
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

test('two competitors meeting the same stale lock: the loser never deletes the winner lock', () => {
  const dir = makeTempDir('vca-lock-');
  const lockPath = path.join(dir, '.installing');

  try {
    fs.writeFileSync(lockPath, '999999'); // owner is gone

    let winner = null;
    // Competitor A is interrupted exactly at its claim: B runs to completion
    // first and installs its own fresh lock.
    const interleavingFs = Object.create(fs);
    interleavingFs.renameSync = (from, to) => {
      if (winner === null) {
        winner = acquireLock(lockPath, {
          fs,
          pid: 222,
          isProcessAlive: (pid) => pid === 222,
        });
      }
      return fs.renameSync(from, to);
    };

    assert.throws(
      () => acquireLock(lockPath, {
        fs: interleavingFs,
        pid: 111,
        isProcessAlive: (pid) => pid === 222,
      }),
      (error) => error.code === 'E_LOCKED',
      'the loser must not acquire the lock',
    );

    assert.ok(winner, 'the winner must have acquired the lock');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), '222', 'the winner lock must survive untouched');
    assert.deepEqual(fs.readdirSync(dir), ['.installing'], 'no quarantine file may survive');

    winner.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    removeTempDir(dir);
  }
});

test('release() never removes a lock owned by another process', () => {
  const dir = makeTempDir('vca-lock-');
  const lockPath = path.join(dir, '.installing');

  try {
    const lock = acquireLock(lockPath, { pid: 4242, isProcessAlive: () => false });

    // Another process took over in the meantime.
    fs.writeFileSync(lockPath, '777');
    lock.release();

    assert.equal(fs.readFileSync(lockPath, 'utf8'), '777', 'a foreign lock must be left alone');
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

  const download = makeHttpGet({ [SETUP_URL]: { body: ['MZ-fake-installer'] } });

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
      queueMicrotask(() => {
        fs.mkdirSync(path.dirname(installedExe), { recursive: true });
        fs.writeFileSync(installedExe, 'exe');
        child.emit('exit', 0, null);
      });
      return child;
    },
    ...overrides,
  };

  return {
    options, spawns, logs, home, tmp, installedExe,
    cleanup: () => { removeTempDir(home); removeTempDir(tmp); },
  };
}

test('installs on Windows with a silent argument vector and verifies the executable', async () => {
  const ctx = windowsInstallOptions();

  try {
    const installedPath = await installDaemon(ctx.options);

    assert.equal(installedPath, ctx.installedExe);
    assert.equal(ctx.spawns.length, 1);
    assert.deepEqual(ctx.spawns[0].args, ['/S']);
    assert.equal(ctx.spawns[0].options.shell, undefined, 'never through a shell');
    assert.equal(ctx.spawns[0].options.windowsHide, true);
    assert.ok(ctx.logs.some((line) => line.includes('v0.3.0')));
    assert.ok(ctx.logs.some((line) => line.includes('Varie-Claude-Avatar-0.3.0-win-x64-setup.exe')));
  } finally {
    ctx.cleanup();
  }
});

test('the downloaded file uses a fixed local name inside the temporary directory', async () => {
  const ctx = windowsInstallOptions();

  try {
    await installDaemon(ctx.options);

    const downloadPath = ctx.spawns[0].command;
    assert.equal(path.basename(downloadPath), 'installer.exe');
    assert.equal(path.dirname(path.dirname(downloadPath)), ctx.tmp);
  } finally {
    ctx.cleanup();
  }
});

test('a traversing asset name cannot escape the temporary directory', async () => {
  const escaping = {
    tag_name: 'v0.3.0',
    assets: [{
      name: '../../escaped-win-x64-setup.exe',
      browser_download_url: SETUP_URL,
    }],
  };
  const ctx = windowsInstallOptions({ fetchRelease: async () => escaping });
  const escapedTarget = path.resolve(ctx.tmp, '..', '..', 'escaped-win-x64-setup.exe');

  try {
    await installDaemon(ctx.options);

    const downloadPath = ctx.spawns[0].command;
    assert.equal(path.basename(downloadPath), 'installer.exe');
    assert.ok(
      path.resolve(downloadPath).startsWith(path.resolve(ctx.tmp) + path.sep),
      `the download must stay inside ${ctx.tmp}, got ${downloadPath}`,
    );
    assert.equal(fs.existsSync(escapedTarget), false, 'nothing may be written outside the temporary directory');
  } finally {
    try { fs.rmSync(escapedTarget, { force: true }); } catch { /* nothing written */ }
    ctx.cleanup();
  }
});

test('the lock and the temporary directory are always removed', async () => {
  const ctx = windowsInstallOptions();

  try {
    await installDaemon(ctx.options);

    assert.equal(fs.existsSync(path.join(ctx.home, '.varie-claude-avatar', '.installing')), false);
    assert.deepEqual(fs.readdirSync(ctx.tmp), []);
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
    assert.equal(ctx.spawns.length, 0);
    assert.equal(fs.readFileSync(path.join(stateDir, '.installing'), 'utf8'), '4242');
  } finally {
    ctx.cleanup();
  }
});

test('macOS extracts the ZIP through ditto with an argument vector', async () => {
  const home = makeTempDir('vca-home-');
  const tmp = makeTempDir('vca-tmp-');
  const appPath = `${home}/Applications/Varie Claude Avatar.app`;
  const spawns = [];

  const download = makeHttpGet({ [MAC_URL]: { body: ['PK-fake-zip'] } });

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
    assert.equal(path.basename(spawns[0].args[2]), 'app.zip');
    assert.equal(spawns[0].args[3], `${home}/Applications`);
    assert.equal(spawns[0].args.length, 4);
  } finally {
    removeTempDir(home);
    removeTempDir(tmp);
  }
});

// --- standalone CLI ---------------------------------------------------------

function makeCliDeps(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const logged = [];
  const exitCodes = [];

  return {
    stdout, stderr, logged, exitCodes,
    deps: {
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
      appendLog: (message) => logged.push(message),
      setExitCode: (code) => exitCodes.push(code),
      installDaemon: async ({ log }) => { log('installing v0.3.0 (setup)'); return 'C:/app.exe'; },
      ...overrides,
    },
  };
}

test('--verbose mirrors the concise messages on stdout as well as the log', async () => {
  const ctx = makeCliDeps();

  await runCli(['--verbose'], ctx.deps);

  assert.ok(ctx.logged.some((line) => line.includes('installing v0.3.0')));
  assert.ok(ctx.stdout.join('').includes('installing v0.3.0'), 'the message must reach stdout');
  assert.deepEqual(ctx.exitCodes, [0]);
});

test('without --verbose the CLI stays silent but still writes the log', async () => {
  const ctx = makeCliDeps();

  await runCli([], ctx.deps);

  assert.ok(ctx.logged.some((line) => line.includes('installing v0.3.0')));
  assert.deepEqual(ctx.stdout, []);
  assert.deepEqual(ctx.stderr, []);
  assert.deepEqual(ctx.exitCodes, [0]);
});

test('a direct run that fails exits non-zero and reports the code', async () => {
  const ctx = makeCliDeps({
    installDaemon: async () => { throw Object.assign(new Error('locked'), { code: 'E_LOCKED' }); },
  });

  await runCli(['--verbose'], ctx.deps);

  assert.deepEqual(ctx.exitCodes, [1], 'a standalone failure must be visible to the caller');
  assert.ok(ctx.stderr.join('').includes('E_LOCKED'));
  assert.ok(ctx.logged.some((line) => line.includes('E_LOCKED')));
});

test('a silent failure still exits non-zero and records the code', async () => {
  const ctx = makeCliDeps({
    installDaemon: async () => { throw Object.assign(new Error('nope'), { code: 'E_NO_ASSET' }); },
  });

  await runCli([], ctx.deps);

  assert.deepEqual(ctx.exitCodes, [1]);
  assert.deepEqual(ctx.stderr, []);
  assert.ok(ctx.logged.some((line) => line.includes('E_NO_ASSET')));
});

// --- compatibility wrapper --------------------------------------------------

test('the install-daemon shell entry point is only a wrapper around the Node installer', () => {
  const wrapperPath = path.join(__dirname, '..', '..', 'plugin', 'scripts', 'install-daemon');
  const wrapper = fs.readFileSync(wrapperPath, 'utf8');

  assert.match(wrapper, /exec node "\$SCRIPT_DIR\/lib\/install-daemon\.cjs" "\$@"/);
  assert.match(wrapper, /deprecated/i);

  for (const legacy of ['curl', 'unzip', 'mktemp', 'OSTYPE', 'browser_download_url', 'LOCK_FILE']) {
    assert.ok(!wrapper.includes(legacy), `the wrapper must no longer implement ${legacy}`);
  }
});
