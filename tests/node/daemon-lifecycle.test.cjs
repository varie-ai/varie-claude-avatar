const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  ensureDaemon,
  resolveLaunchTarget,
  probeEndpoint,
  waitForEndpoint,
  startInstaller,
  LAUNCH_TIMEOUT_MS,
  PROBE_INTERVAL_MS,
} = require('../../plugin/scripts/lib/daemon-lifecycle.cjs');
const { sendEvent, DEFAULT_TOTAL_BUDGET_MS } = require('../../plugin/scripts/lib/transport.cjs');

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

test('waitForEndpoint probes at 250 ms and never starts a probe after the deadline', async () => {
  let clock = 0;
  const delays = [];
  const probeTimes = [];

  const answered = await waitForEndpoint('endpoint', {
    probe: async () => { probeTimes.push(clock); return false; },
    now: () => clock,
    delay: async (ms) => { delays.push(ms); clock += ms; },
  });

  assert.equal(answered, false);
  assert.equal(LAUNCH_TIMEOUT_MS, 3500, 'the polling budget leaves room for delivery');
  assert.equal(PROBE_INTERVAL_MS, 250);
  assert.equal(clock, LAUNCH_TIMEOUT_MS, 'the wait must stop exactly at the deadline');
  assert.ok(delays.every((ms) => ms === 250), 'every interval must be 250 ms');
  assert.ok(
    probeTimes.every((at) => at < LAUNCH_TIMEOUT_MS),
    `no probe may start at or after the deadline, got ${probeTimes.at(-1)}`,
  );
  assert.equal(probeTimes.length, LAUNCH_TIMEOUT_MS / PROBE_INTERVAL_MS);
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

// --- asynchronous spawn failures --------------------------------------------

test('an asynchronous launch error is absorbed and handed to the installer', async () => {
  const { options, installs, logs } = baseOptions({
    exists: (candidate) => candidate === WIN_EXE,
    // The daemon never comes up, so only the spawn error can settle the race.
    waitForEndpoint: () => new Promise(() => {}),
    spawn: () => {
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('error', Object.assign(new Error('gone'), { code: 'ENOENT' })));
      return child;
    },
  });

  const result = await ensureDaemon(options);

  assert.equal(result, 'installing');
  assert.equal(installs.length, 1, 'the installer branch must take over');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ENOENT/);
  assert.ok(!logs[0].includes('gone'), 'only the code is logged');
});

test('the launch error listener is attached before unref', async () => {
  const order = [];
  const { options } = baseOptions({
    exists: (candidate) => candidate === WIN_EXE,
    waitForEndpoint: () => new Promise(() => {}),
    spawn: () => {
      const child = new EventEmitter();
      const realOn = child.on.bind(child);
      child.on = (event, handler) => { order.push(`on:${event}`); return realOn(event, handler); };
      child.once = child.on;
      child.unref = () => { order.push('unref'); };
      queueMicrotask(() => child.emit('error', Object.assign(new Error('x'), { code: 'EPERM' })));
      return child;
    },
  });

  await ensureDaemon(options);

  assert.ok(order.includes('on:error'), 'an error listener must be registered');
  assert.ok(
    order.indexOf('on:error') < order.indexOf('unref'),
    `the error listener must precede unref(), got ${order.join(' -> ')}`,
  );
});

test('a late launch error after a successful wait does not crash the process', async () => {
  let child = null;
  const { options } = baseOptions({
    exists: (candidate) => candidate === WIN_EXE,
    waitForEndpoint: async () => true,
    spawn: () => {
      child = new EventEmitter();
      child.unref = () => {};
      return child;
    },
  });

  const result = await ensureDaemon(options);
  assert.equal(result, 'launched');

  // Emitting 'error' with no listener would throw; the guard must absorb it.
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('late'), { code: 'EPIPE' })));
});

test('the detached installer absorbs and logs an asynchronous spawn error', async () => {
  const logs = [];
  let child = null;

  assert.doesNotThrow(() => {
    startInstaller({
      log: (message) => logs.push(message),
      execPath: 'node',
      spawn: () => {
        child = new EventEmitter();
        child.unref = () => {};
        return child;
      },
    });
  });

  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('boom'), { code: 'EACCES' })));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /EACCES/);
  assert.ok(!logs[0].includes('boom'), 'only the code is logged');
});

// --- SessionStart budget ----------------------------------------------------

test('the SessionStart budget covers lifecycle polling plus event delivery', () => {
  const hooksPath = path.join(__dirname, '..', '..', 'plugin', 'hooks', 'hooks.json');
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  const handler = hooks.hooks.SessionStart[0].hooks[0];

  // hooks.json expresses the timeout in seconds.
  const sessionStartMs = handler.timeout * 1000;
  assert.equal(sessionStartMs, 5000, 'the external SessionStart timeout stays 5 seconds');

  assert.ok(
    LAUNCH_TIMEOUT_MS <= sessionStartMs - 1000,
    `at least one second must stay reserved for delivery and overhead, polling is ${LAUNCH_TIMEOUT_MS}ms`,
  );
  assert.ok(
    LAUNCH_TIMEOUT_MS + DEFAULT_TOTAL_BUDGET_MS <= sessionStartMs,
    `polling (${LAUNCH_TIMEOUT_MS}ms) plus delivery (${DEFAULT_TOTAL_BUDGET_MS}ms) must fit ${sessionStartMs}ms`,
  );
});

test('a worst-case session start fits the budget on a simulated clock', async () => {
  let clock = 0;
  const now = () => clock;
  const delay = async (ms) => { clock += ms; };

  // The daemon never answers: the lifecycle burns its whole polling budget.
  const answered = await waitForEndpoint('endpoint', { probe: async () => false, now, delay });
  assert.equal(answered, false);
  const afterLifecycle = clock;
  assert.equal(afterLifecycle, LAUNCH_TIMEOUT_MS);

  // Delivery then runs against a missing endpoint and exhausts its retries.
  const fakeNet = {
    createConnection: () => {
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.write = () => {};
      socket.destroy = () => {};
      setImmediate(() => socket.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
      return socket;
    },
  };

  await assert.rejects(sendEvent('endpoint', {
    protocolVersion: 1,
    type: 'session_start',
    sessionId: 's',
    timestamp: 1,
    metadata: { project: 'p', projectPath: '/p', summary: '' },
  }, { netModule: fakeNet, now, delay }));

  assert.ok(clock < 5000, `a whole session start must stay under 5000ms, took ${clock}ms`);
  assert.ok(clock - afterLifecycle <= DEFAULT_TOTAL_BUDGET_MS);
});
