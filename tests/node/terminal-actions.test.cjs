const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MAIN_DIR = path.join(REPO_ROOT, 'daemon', 'src', 'main');
const ACTIONS_DIR = path.join(MAIN_DIR, 'terminal-actions');
const ESBUILD = path.join(REPO_ROOT, 'daemon', 'node_modules', 'esbuild');

// The terminal-action modules are TypeScript, so they are bundled once into a
// unique temporary directory and required from there. Nothing is written to
// daemon/dist, no Electron is loaded and no external command is executed.
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vca-terminal-actions-'));
const bundlePath = path.join(buildDir, 'terminal-actions.cjs');

after(() => {
  fs.rmSync(buildDir, { recursive: true, force: true });
});

function buildTerminalActions() {
  const esbuild = require(ESBUILD);
  esbuild.buildSync({
    entryPoints: [path.join(ACTIONS_DIR, 'create-terminal-actions.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: bundlePath,
    external: ['electron'],
    logLevel: 'silent',
  });
  return require(bundlePath);
}

const {
  createTerminalActionService,
  createValidatedTerminalActionService,
  selectTerminalActionAdapter,
  registerTerminalActionIpc,
  MacOSTerminalActions,
  UnsupportedTerminalActions,
} = buildTerminalActions();

function readSource(file) {
  return fs.readFileSync(file, 'utf8');
}

/** execFile spy that never runs a program. */
function makeExecFile(behaviour = (callback) => callback(null, '', '')) {
  const calls = [];
  const execFile = (...args) => {
    calls.push(args);
    const callback = args[args.length - 1];
    behaviour(callback);
    return { pid: -1 };
  };
  return { execFile, calls };
}

function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error(`duplicate handler for ${channel}`);
      handlers.set(channel, listener);
    },
    invoke(channel, ...args) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`no handler for ${channel}`);
      return listener({}, ...args);
    },
  };
}

// --- platform selection -----------------------------------------------------

test('Windows exposes no terminal actions in v1', () => {
  const service = createTerminalActionService('win32');
  assert.deepEqual(service.capabilities(), { focus: false, approve: false });
});

test('Windows perform returns a stable unsupported result', async () => {
  const service = createTerminalActionService('win32');

  assert.deepEqual(await service.perform('focus', 's-1'), { ok: false, reason: 'unsupported' });
  assert.deepEqual(await service.perform('approve', 's-1'), { ok: false, reason: 'unsupported' });
});

test('an unknown platform falls back to the unsupported adapter', async () => {
  for (const platform of ['linux', 'aix', 'freebsd', '', undefined]) {
    const adapter = selectTerminalActionAdapter(platform);
    assert.ok(adapter instanceof UnsupportedTerminalActions, `${platform} must be unsupported`);

    const service = createTerminalActionService(platform);
    assert.deepEqual(service.capabilities(), { focus: false, approve: false });
    assert.deepEqual(await service.perform('approve', 's-1'), { ok: false, reason: 'unsupported' });
  }
});

test('darwin selects the macOS adapter and advertises both actions', () => {
  const { execFile } = makeExecFile();
  const adapter = selectTerminalActionAdapter('darwin', { execFile });
  assert.ok(adapter instanceof MacOSTerminalActions);

  const service = createTerminalActionService('darwin', { execFile });
  assert.deepEqual(service.capabilities(), { focus: true, approve: true });
});

test('capabilities() returns a fresh object that cannot mutate the service', () => {
  const service = createTerminalActionService('win32');
  const first = service.capabilities();
  first.focus = true;

  assert.deepEqual(service.capabilities(), { focus: false, approve: false });
});

// --- runtime validation at the boundary -------------------------------------

test('an action outside the contract never reaches the adapter', async () => {
  const { execFile, calls } = makeExecFile();
  const service = createTerminalActionService('darwin', { execFile });

  for (const action of ['quit', 'FOCUS', '', null, undefined, 42, {}, ['focus']]) {
    const result = await service.perform(action, 's-1');
    assert.deepEqual(result, { ok: false, reason: 'unsupported' }, `${String(action)} must be refused`);
  }

  assert.deepEqual(calls, [], 'no adapter call may be attempted for an invalid action');
});

test('an invalid sessionId never reaches the adapter', async () => {
  const { execFile, calls } = makeExecFile();
  const service = createTerminalActionService('darwin', { execFile });

  for (const sessionId of ['', '   ', '\t\n', null, undefined, 7, {}, ['s-1']]) {
    const result = await service.perform('focus', sessionId);
    assert.deepEqual(result, { ok: false, reason: 'session_not_found' }, `${String(sessionId)} must be refused`);
  }

  assert.deepEqual(calls, [], 'no adapter call may be attempted for an invalid sessionId');
});

// --- macOS adapter ----------------------------------------------------------

test('the macOS adapter runs osascript through an argument vector without a shell', async () => {
  const { execFile, calls } = makeExecFile();
  const clipboard = [];
  const service = createTerminalActionService('darwin', {
    execFile,
    writeClipboard: (text) => clipboard.push(text),
  });

  const result = await service.perform('approve', 's-1');

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);

  const [file, args, ...rest] = calls[0];
  assert.equal(file, '/usr/bin/osascript');
  assert.ok(Array.isArray(args));
  assert.equal(args.length, 2);
  assert.equal(args[0], '-e');
  assert.equal(typeof args[1], 'string');
  assert.equal(rest.length, 1, 'only a callback may follow the argument vector, never an options object');
  assert.equal(typeof rest[0], 'function');
  assert.deepEqual(clipboard, ['y'], 'the clipboard fallback must be preserved');
});

test('the macOS approve script keeps the existing activate plus return behaviour', async () => {
  const { execFile, calls } = makeExecFile();
  const service = createTerminalActionService('darwin', { execFile, writeClipboard: () => {} });

  await service.perform('approve', 's-1');
  const script = calls[0][1][1];

  assert.match(script, /System Events/);
  assert.match(script, /iTerm2/);
  assert.match(script, /activate/);
  assert.match(script, /keystroke return/);
});

test('the macOS focus action activates the terminal without sending input', async () => {
  const { execFile, calls } = makeExecFile();
  const clipboard = [];
  const service = createTerminalActionService('darwin', {
    execFile,
    writeClipboard: (text) => clipboard.push(text),
  });

  const result = await service.perform('focus', 's-1');
  const script = calls[0][1][1];

  assert.deepEqual(result, { ok: true });
  assert.match(script, /activate/);
  assert.ok(!/keystroke/.test(script), 'focus must never send input');
  assert.deepEqual(clipboard, [], 'focus must not touch the clipboard');
});

test('a missing terminal is reported as terminal_not_found', async () => {
  const { execFile } = makeExecFile((callback) => {
    const error = new Error('Application isn\u2019t running. (-600)');
    callback(error, '', 'execution error: Application isn\u2019t running. (-600)');
  });
  const service = createTerminalActionService('darwin', { execFile, writeClipboard: () => {} });

  assert.deepEqual(await service.perform('approve', 's-1'), { ok: false, reason: 'terminal_not_found' });
});

test('a denied automation permission is reported as automation_denied', async () => {
  const { execFile } = makeExecFile((callback) => {
    const error = new Error('Not authorized to send Apple events to System Events. (-1743)');
    callback(error, '', 'execution error: Not authorized to send Apple events to System Events. (-1743)');
  });
  const service = createTerminalActionService('darwin', { execFile, writeClipboard: () => {} });

  assert.deepEqual(await service.perform('focus', 's-1'), { ok: false, reason: 'automation_denied' });
});

test('raw system error details never reach the caller', async () => {
  const secret = 'C:/private/path/and/raw/osascript/detail';
  const { execFile } = makeExecFile((callback) => {
    callback(new Error(secret), '', secret);
  });
  const logged = [];
  const service = createTerminalActionService('darwin', {
    execFile,
    writeClipboard: () => {},
    log: (_level, message) => logged.push(message),
  });

  const result = await service.perform('approve', 's-1');

  assert.equal(result.ok, false);
  assert.ok(['terminal_not_found', 'automation_denied'].includes(result.reason));
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason'], 'the result carries nothing else');
  assert.ok(!JSON.stringify(result).includes(secret), 'no raw detail may reach the renderer');
  assert.ok(logged.some((line) => line.includes(secret)), 'the detail stays in the local log');
});

test('a synchronous execFile failure is contained', async () => {
  const service = createTerminalActionService('darwin', {
    execFile: () => { throw new Error('spawn failed'); },
    writeClipboard: () => {},
  });

  const result = await service.perform('approve', 's-1');
  assert.equal(result.ok, false);
  assert.ok(['terminal_not_found', 'automation_denied'].includes(result.reason));
});

// --- Windows executes nothing ------------------------------------------------

test('Windows never touches an execution dependency', async () => {
  const { execFile, calls } = makeExecFile();
  const clipboard = [];
  const service = createTerminalActionService('win32', {
    execFile,
    writeClipboard: (text) => clipboard.push(text),
  });

  await service.perform('focus', 's-1');
  await service.perform('approve', 's-1');

  assert.deepEqual(calls, [], 'no command may be executed on Windows');
  assert.deepEqual(clipboard, [], 'no clipboard write may happen on Windows');
});

// --- IPC registration --------------------------------------------------------

test('the IPC boundary exposes exactly the two terminal-action channels', () => {
  const ipcMain = makeIpcMain();
  registerTerminalActionIpc({
    ipcMain,
    service: createTerminalActionService('win32'),
    findSession: () => ({ id: 's-1' }),
  });

  assert.deepEqual(
    [...ipcMain.handlers.keys()].sort(),
    ['get-terminal-action-capabilities', 'perform-terminal-action'],
  );
});

test('the capabilities channel returns the service capabilities', async () => {
  const ipcMain = makeIpcMain();
  registerTerminalActionIpc({
    ipcMain,
    service: createTerminalActionService('win32'),
    findSession: () => ({ id: 's-1' }),
  });

  assert.deepEqual(await ipcMain.invoke('get-terminal-action-capabilities'), { focus: false, approve: false });
});

test('an unknown session is refused before the adapter is consulted', async () => {
  const { execFile, calls } = makeExecFile();
  const ipcMain = makeIpcMain();
  registerTerminalActionIpc({
    ipcMain,
    service: createTerminalActionService('darwin', { execFile, writeClipboard: () => {} }),
    findSession: () => undefined,
  });

  const result = await ipcMain.invoke('perform-terminal-action', 'approve', 's-missing');

  assert.deepEqual(result, { ok: false, reason: 'session_not_found' });
  assert.deepEqual(calls, [], 'an unknown session must never reach the adapter');
});

test('a known session reaches the service', async () => {
  const { execFile, calls } = makeExecFile();
  const ipcMain = makeIpcMain();
  registerTerminalActionIpc({
    ipcMain,
    service: createTerminalActionService('darwin', { execFile, writeClipboard: () => {} }),
    findSession: (sessionId) => (sessionId === 's-1' ? { id: 's-1' } : undefined),
  });

  assert.deepEqual(await ipcMain.invoke('perform-terminal-action', 'focus', 's-1'), { ok: true });
  assert.equal(calls.length, 1);
});

test('the IPC handlers are registered only once per lifecycle', () => {
  const ipcMain = makeIpcMain();
  const registration = {
    ipcMain,
    service: createTerminalActionService('win32'),
    findSession: () => ({ id: 's-1' }),
  };

  assert.equal(registerTerminalActionIpc(registration), true);
  assert.equal(registerTerminalActionIpc(registration), false, 'a second registration must be a no-op');
  assert.equal(ipcMain.handlers.size, 2);
});

// --- main and preload surface ------------------------------------------------

test('the main process no longer implements send-approval', () => {
  const source = readSource(path.join(MAIN_DIR, 'index.ts'));

  assert.ok(!source.includes('send-approval'), 'the send-approval channel must be gone');
  assert.ok(!source.includes('osascript'), 'AppleScript must live in the macOS adapter');
  assert.ok(!/\bexec\(/.test(source), 'index.ts must not build shell commands');
});

test('the main process registers the terminal-action boundary once ready', () => {
  const source = readSource(path.join(MAIN_DIR, 'index.ts'));

  assert.match(source, /createTerminalActionService/);
  assert.match(source, /registerTerminalActionIpc/);
  assert.match(source, /app\.whenReady\(\)/);
});

test('preload exposes only the two terminal-action functions', () => {
  const source = readSource(path.join(MAIN_DIR, 'preload.ts'));

  assert.ok(!source.includes('sendApproval'), 'sendApproval must be removed');
  assert.ok(!source.includes('send-approval'), 'the old channel must be gone');

  assert.match(source, /getTerminalActionCapabilities/);
  assert.match(source, /performTerminalAction/);
  assert.match(source, /'get-terminal-action-capabilities'/);
  assert.match(source, /'perform-terminal-action'/);

  // The narrow surface stays narrow: ipcRenderer itself is never exposed.
  assert.ok(!/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*ipcRenderer\s*\)/.test(source));
});

test('the renderer keeps no terminal-action call to action in this release', () => {
  const rendererDir = path.join(REPO_ROOT, 'daemon', 'src', 'renderer');
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|js|html)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/performTerminalAction|sendApproval|getTerminalActionCapabilities/.test(source)) {
        offenders.push(full);
      }
    }
  };
  walk(rendererDir);

  assert.deepEqual(offenders, [], 'Windows v1 ships no focus or approve call to action');
});

// --- result contract enforcement --------------------------------------------

const CONTRACT_REASONS = ['unsupported', 'session_not_found', 'terminal_not_found', 'automation_denied'];

/** Adapter that answers whatever it is told, so the boundary can be probed. */
function makeAdapter(result) {
  return {
    capabilities: () => ({ focus: true, approve: true }),
    perform: async () => result,
  };
}

function serviceReturning(result) {
  return createValidatedTerminalActionService(makeAdapter(result));
}

test('the four contract reasons survive the boundary unchanged', async () => {
  for (const reason of CONTRACT_REASONS) {
    const result = await serviceReturning({ ok: false, reason }).perform('focus', 's-1');
    assert.deepEqual(result, { ok: false, reason }, `${reason} must be preserved`);
  }
});

test('an unknown reason string is reduced to unsupported', async () => {
  const offContract = [
    'arbitrary_private_value',
    'UNSUPPORTED',
    'Session_Not_Found',
    'session-not-found',
    'focus',
    '',
    ' unsupported ',
  ];

  for (const reason of offContract) {
    const result = await serviceReturning({ ok: false, reason }).perform('focus', 's-1');
    assert.deepEqual(
      result,
      { ok: false, reason: 'unsupported' },
      `${JSON.stringify(reason)} must not cross the boundary`,
    );
  }
});

test('a reason that is not a string is reduced to unsupported', async () => {
  const nonStrings = [null, undefined, 0, 42, -1, 1n, true, false, {}, [], ['unsupported'], { reason: 'unsupported' }];

  for (const reason of nonStrings) {
    const result = await serviceReturning({ ok: false, reason }).perform('approve', 's-1');
    assert.deepEqual(
      result,
      { ok: false, reason: 'unsupported' },
      `${String(reason)} must not cross the boundary`,
    );
  }
});

test('a missing reason becomes unsupported', async () => {
  const result = await serviceReturning({ ok: false }).perform('focus', 's-1');
  assert.deepEqual(result, { ok: false, reason: 'unsupported' });
});

test('an adapter cannot smuggle extra properties across the boundary', async () => {
  const marker = Symbol('adapter-private');
  const result = await serviceReturning({
    ok: false,
    reason: 'terminal_not_found',
    stderr: 'raw osascript detail',
    pid: 1234,
    [marker]: 'private',
  }).perform('approve', 's-1');

  assert.deepEqual(result, { ok: false, reason: 'terminal_not_found' });
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason']);
  assert.deepEqual(Object.getOwnPropertySymbols(result), []);
  assert.ok(!JSON.stringify(result).includes('raw osascript detail'));
});

test('success is normalized to exactly { ok: true }', async () => {
  const result = await serviceReturning({
    ok: true,
    reason: 'unsupported',
    extra: 'must not travel',
  }).perform('focus', 's-1');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(Object.keys(result), ['ok']);
});

test('an adapter answer that is not a result object is refused', async () => {
  for (const answer of [undefined, null, 'ok', 42, [], () => {}, { ok: 'true' }, { ok: 1 }]) {
    const result = await serviceReturning(answer).perform('focus', 's-1');
    assert.deepEqual(
      result,
      { ok: false, reason: 'unsupported' },
      `${String(answer)} must not cross the boundary`,
    );
  }
});
