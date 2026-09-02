const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ensureDaemon,
  resolveLaunchTarget,
  probeEndpoint,
  waitForEndpoint,
  LAUNCH_TIMEOUT_MS,
  PROBE_INTERVAL_MS,
} = require('../../plugin/scripts/lib/daemon-lifecycle.cjs');

const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' };
const WIN_EXE = path.join('C:\\Users\\dev\\AppData\\Local', 'Programs', 'Varie Claude Avatar', 'Varie Claude Avatar.exe');
const MAC_HOME = '/Users/dev';
const DAEMON_ROOT = '/repo/daemon';

function getUniqueTestEndpoint() {
  const rand = crypto.randomBytes(4).toString('hex');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\vca-lifecycle-test-${process.pid}-${rand}`;
  }
  return path.join('/tmp', `vca-lifecycle-test-${process.pid}-${rand}.sock`);
}

/** Records every spawn without ever creating a process. */
function makeSpawnRecorder() {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = { unrefCount: 0, unref() { child.unrefCount += 1; } };
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawn, calls };
}

function baseOptions(overrides = {}) {
  const recorder = makeSpawnRecorder();
  const installs = [];
  const logs = [];

  return {
    recorder,
    installs,
    logs,
    options: {
      endpoint: 'test-endpoint',
      platform: 'win32',
      env: WIN_ENV,
      homedir: MAC_HOME,
      daemonRoot: DAEMON_ROOT,
      probe: async () => false,
      exists: () => false,
      spawn: recorder.spawn,
      install: async (info) => { installs.push(info); },
      waitForEndpoint: async () => true,
      log: (message) => logs.push(message),
      ...overrides,
    },
  };
}

// --- ensureDaemon decisions -------------------------------------------------

test('does nothing when the endpoint already responds', async () => {
  const { options, recorder, installs } = baseOptions({ probe: async () => true });

  const result = await ensureDaemon(options);

  assert.equal(result, 'running');
  assert.deepEqual(recorder.calls, []);
  assert.deepEqual(installs, []);
});

test('launches the installed Windows executable detached and hidden', async () => {
  const { options, recorder, installs } = baseOptions({
    platform: 'win32',
    exists: (candidate) => candidate === WIN_EXE,
  });

  const result = await ensureDaemon(options);

  assert.equal(result, 'launched');
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].command, WIN_EXE);
  assert.deepEqual(recorder.calls[0].args, []);
  assert.deepEqual(recorder.calls[0].options, { detached: true, stdio: 'ignore', windowsHide: true });
  assert.equal(recorder.calls[0].child.unrefCount, 1, 'the child must be unref()ed');
  assert.deepEqual(installs, [], 'an installed app must not trigger an installation');
});

test('launches the installed macOS app from /Applications through an argument vector', async () => {
  const appPath = '/Applications/Varie Claude Avatar.app';
  const { options, recorder } = baseOptions({
    platform: 'darwin',
    env: {},
    exists: (candidate) => candidate === appPath,
  });

  const result = await ensureDaemon(options);

  assert.equal(result, 'launched');
  assert.equal(recorder.calls[0].command, '/usr/bin/open');
  assert.deepEqual(recorder.calls[0].args, ['-g', '-j', appPath]);
  assert.equal(recorder.calls[0].options.detached, true);
});

test('falls back to the per-user macOS Applications directory', async () => {
  // macOS paths stay POSIX even when the suite runs on Windows.
  const appPath = `${MAC_HOME}/Applications/Varie Claude Avatar.app`;
  const { options, recorder } = baseOptions({
    platform: 'darwin',
    env: {},
    exists: (candidate) => candidate === appPath,
  });

  const result = await ensureDaemon(options);

  assert.equal(result, 'launched');
  assert.deepEqual(recorder.calls[0].args, ['-g', '-j', appPath]);
});

test('uses the source Electron binary only when the local checkout is built', async () => {
  const electron = path.join(DAEMON_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const bundle = path.join(DAEMON_ROOT, 'dist', 'main', 'index.js');

  const built = baseOptions({
    platform: 'win32',
    exists: (candidate) => candidate === electron || candidate === bundle,
  });
  assert.equal(await ensureDaemon(built.options), 'launched');
  assert.equal(built.recorder.calls[0].command, electron);
  assert.deepEqual(built.recorder.calls[0].args, [DAEMON_ROOT]);

  // Electron present but nothing built: not a usable source checkout.
  const unbuilt = baseOptions({
    platform: 'win32',
    exists: (candidate) => candidate === electron,
  });
  assert.equal(await ensureDaemon(unbuilt.options), 'installing');
  assert.deepEqual(unbuilt.recorder.calls, [], 'an unbuilt checkout must not be launched');
});

test('starts the installer without blocking when no application is present', async () => {
  const { options, recorder, installs } = baseOptions();

  const result = await ensureDaemon(options);

  assert.equal(result, 'installing');
  assert.deepEqual(recorder.calls, [], 'nothing may be launched when the app is absent');
  assert.equal(installs.length, 1);
});

test('a launch that never answers still returns launched without throwing', async () => {
  const { options, installs } = baseOptions({
    exists: (candidate) => candidate === WIN_EXE,
    waitForEndpoint: async () => false,
  });

  const result = await ensureDaemon(options);

  assert.equal(result, 'launched');
  assert.deepEqual(installs, [], 'a launch timeout must not trigger an installation');
});

test('a spawn failure is logged and handed over to the installer instead of throwing', async () => {
  const { options, installs, logs } = baseOptions({
    exists: (candidate) => candidate === WIN_EXE,
    spawn: () => { const error = new Error('nope'); error.code = 'EACCES'; throw error; },
  });

  const result = await ensureDaemon(options);

  assert.equal(result, 'installing');
  assert.equal(installs.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /EACCES/);
});

test('an installer failure is logged and never thrown into Claude Code', async () => {
  const { options, logs } = baseOptions({
    install: async () => { const error = new Error('boom'); error.code = 'E_LOCKED'; throw error; },
  });

  const result = await ensureDaemon(options);

  assert.equal(result, 'installing');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /E_LOCKED/);
});

test('a missing LOCALAPPDATA does not crash the Windows lookup', async () => {
  const { options, installs } = baseOptions({ platform: 'win32', env: {} });

  const result = await ensureDaemon(options);

  assert.equal(result, 'installing');
  assert.equal(installs.length, 1);
});

// --- resolveLaunchTarget ----------------------------------------------------

test('resolveLaunchTarget prefers the installed app over the source checkout', () => {
  const electron = path.join(DAEMON_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const bundle = path.join(DAEMON_ROOT, 'dist', 'main', 'index.js');

  const target = resolveLaunchTarget({
    platform: 'win32',
    env: WIN_ENV,
    homedir: MAC_HOME,
    daemonRoot: DAEMON_ROOT,
    exists: (candidate) => candidate === WIN_EXE || candidate === electron || candidate === bundle,
  });

  assert.equal(target.kind, 'installed');
  assert.equal(target.command, WIN_EXE);
});

test('resolveLaunchTarget returns null on an unsupported platform', () => {
  const target = resolveLaunchTarget({
    platform: 'linux',
    env: {},
    homedir: MAC_HOME,
    daemonRoot: DAEMON_ROOT,
    exists: () => true,
  });

  assert.equal(target, null);
});

// --- bounded waiting --------------------------------------------------------

test('waitForEndpoint probes at 250 ms for at most 5 seconds', async () => {
  let clock = 0;
  const delays = [];
  let probes = 0;

  const answered = await waitForEndpoint('endpoint', {
    probe: async () => { probes += 1; return false; },
    now: () => clock,
    delay: async (ms) => { delays.push(ms); clock += ms; },
  });

  assert.equal(answered, false);
  assert.equal(LAUNCH_TIMEOUT_MS, 5000);
  assert.equal(PROBE_INTERVAL_MS, 250);
  assert.equal(clock, 5000, 'the wait must stop exactly at the deadline');
  assert.ok(delays.every((ms) => ms === 250), 'every interval must be 250 ms');
  assert.equal(probes, 21, 'one probe per interval plus the final one');
});

test('waitForEndpoint stops as soon as the daemon answers', async () => {
  let clock = 0;
  let probes = 0;

  const answered = await waitForEndpoint('endpoint', {
    probe: async () => { probes += 1; return probes === 3; },
    now: () => clock,
    delay: async (ms) => { clock += ms; },
  });

  assert.equal(answered, true);
  assert.equal(probes, 3);
  assert.equal(clock, 500);
});

// --- probeEndpoint ----------------------------------------------------------

test('probeEndpoint reports a listening endpoint and cleans up its socket', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });

  try {
    assert.equal(await probeEndpoint(endpoint, { timeoutMs: 500 }), true);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test('probeEndpoint reports a missing endpoint as unavailable', { timeout: 5000 }, async () => {
  assert.equal(await probeEndpoint(getUniqueTestEndpoint(), { timeoutMs: 500 }), false);
});
