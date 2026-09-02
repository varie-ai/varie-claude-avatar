const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MAX_STDIN_BYTES } = require('../../plugin/scripts/lib/event.cjs');
const cli = require('../../plugin/scripts/varie-avatar-hook.cjs');

const SECRET = 'SUPER-SECRET-PROMPT-TEXT';

/** Minimal readable stub: no real stdin, no real process. */
function fakeStdin(chunks) {
  const stream = new EventEmitter();
  stream.isTTY = false;
  queueMicrotask(() => {
    for (const chunk of chunks) {
      stream.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
    }
    stream.emit('end');
  });
  return stream;
}

/** Builds a fully injected dependency set; no socket and no process is touched. */
function makeDeps(overrides = {}) {
  const sent = [];
  const logs = [];
  const ensured = [];
  const exitCodes = [];

  const deps = {
    argv: [],
    stdin: fakeStdin(['{}']),
    getIpcEndpoint: () => 'test-endpoint',
    sendEvent: async (endpoint, event) => { sent.push({ endpoint, event }); },
    ensureDaemon: async (info) => { ensured.push(info); },
    log: (message) => { logs.push(message); },
    setExitCode: (code) => { exitCodes.push(code); },
    context: { cwd: '/repo', now: 100, env: {}, pid: 7 },
    ...overrides,
  };

  return { deps, sent, logs, ensured, exitCodes };
}

test('parseArgs reads the event name, --ensure and the compatibility fallbacks', () => {
  assert.deepEqual(cli.parseArgs(['session-start', '--ensure']), {
    eventName: 'session-start', ensure: true, tool: undefined, message: undefined,
  });

  assert.deepEqual(cli.parseArgs(['approval-needed', '--tool', 'Bash']), {
    eventName: 'approval-needed', ensure: false, tool: 'Bash', message: undefined,
  });

  assert.deepEqual(cli.parseArgs(['notification', '--message', 'Claude is waiting']), {
    eventName: 'notification', ensure: false, tool: undefined, message: 'Claude is waiting',
  });

  assert.deepEqual(cli.parseArgs(['notification', '--message=Claude is waiting']), {
    eventName: 'notification', ensure: false, tool: undefined, message: 'Claude is waiting',
  });

  assert.deepEqual(cli.parseArgs([]), {
    eventName: 'unknown', ensure: false, tool: undefined, message: undefined,
  });
});

test('readStdin returns the payload without touching the real process', async () => {
  const result = await cli.readStdin({ stdin: fakeStdin(['{"a":', '1}']) });
  assert.deepEqual(result, { text: '{"a":1}', oversize: false });
});

test('readStdin reports a TTY as empty input', async () => {
  const tty = new EventEmitter();
  tty.isTTY = true;
  assert.deepEqual(await cli.readStdin({ stdin: tty }), { text: '', oversize: false });
});

test('readStdin accepts exactly 1 MiB and flags 1 MiB plus one byte', async () => {
  const exact = await cli.readStdin({ stdin: fakeStdin([Buffer.alloc(MAX_STDIN_BYTES, 0x61)]) });
  assert.equal(exact.oversize, false);
  assert.equal(exact.text.length, MAX_STDIN_BYTES);

  const tooLarge = await cli.readStdin({ stdin: fakeStdin([Buffer.alloc(MAX_STDIN_BYTES + 1, 0x61)]) });
  assert.equal(tooLarge.oversize, true);
  assert.equal(tooLarge.text, '', 'oversized stdin must not be retained');
});

test('a valid hook payload is delivered once to the shared endpoint', async () => {
  const { deps, sent, logs, exitCodes } = makeDeps({
    argv: ['approval-needed'],
    stdin: fakeStdin([JSON.stringify({
      session_id: 's-1', tool_name: 'Bash', tool_input: { command: 'ls -la' },
    })]),
  });

  const result = await cli.main(deps);

  assert.equal(result.delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].endpoint, 'test-endpoint');
  assert.deepEqual(sent[0].event, {
    protocolVersion: 1,
    type: 'approval_needed',
    sessionId: 's-1',
    tool: 'Bash',
    timestamp: 100,
    metadata: { project: 'repo', projectPath: '/repo', summary: 'ls -la' },
  });
  assert.deepEqual(logs, []);
  assert.deepEqual(exitCodes, [0]);
});

test('malformed stdin is rejected without sending anything and still exits 0', async () => {
  const { deps, sent, logs, exitCodes } = makeDeps({
    argv: ['approval-needed'],
    stdin: fakeStdin([`{"tool_input":{"command":"${SECRET}"`]),
  });

  const result = await cli.main(deps);

  assert.equal(result.delivered, false);
  assert.equal(result.rejected, true);
  assert.equal(result.reason, 'malformed');
  assert.equal(sent.length, 0, 'a rejected payload must never be sent');
  assert.deepEqual(exitCodes, [0]);
  assert.equal(logs.length, 1);
  assert.ok(!logs.join('\n').includes(SECRET), 'logs must never contain the payload');
});

test('JSON primitives and arrays are rejected without a synthetic event', async () => {
  for (const payload of ['null', '42', '"text"', 'true', '[{"tool_name":"Bash"}]']) {
    const { deps, sent, exitCodes } = makeDeps({
      argv: ['stop'],
      stdin: fakeStdin([payload]),
    });

    const result = await cli.main(deps);

    assert.equal(result.rejected, true, `${payload} must be rejected`);
    assert.equal(result.reason, 'not_object');
    assert.equal(sent.length, 0, `${payload} must not produce an event`);
    assert.deepEqual(exitCodes, [0]);
  }
});

test('stdin above 1 MiB is rejected without sending anything', async () => {
  const oversized = '{"message":"' + 'x'.repeat(MAX_STDIN_BYTES) + '"}';
  const { deps, sent, logs, exitCodes } = makeDeps({
    argv: ['user-prompt'],
    stdin: fakeStdin([oversized]),
  });

  const result = await cli.main(deps);

  assert.equal(result.rejected, true);
  assert.equal(result.reason, 'oversize');
  assert.equal(sent.length, 0);
  assert.deepEqual(exitCodes, [0]);
  assert.ok(!logs.join('\n').includes('xxxxxxxxxx'), 'logs must never contain the payload');
});

test('absent stdin is a valid empty payload and is still delivered', async () => {
  const { deps, sent } = makeDeps({
    argv: ['session-end'],
    stdin: fakeStdin([]),
  });

  const result = await cli.main(deps);

  assert.equal(result.delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.type, 'session_end');
  assert.equal(sent[0].event.sessionId, '7');
});

test('--ensure routes through the daemon boundary, other events do not', async () => {
  const withEnsure = makeDeps({ argv: ['session-start', '--ensure'] });
  await cli.main(withEnsure.deps);
  assert.equal(withEnsure.ensured.length, 1);
  assert.equal(withEnsure.ensured[0].eventName, 'session-start');
  assert.equal(withEnsure.ensured[0].endpoint, 'test-endpoint', 'the boundary receives the shared endpoint');
  assert.equal(typeof withEnsure.ensured[0].log, 'function', 'the boundary receives the hook logger');
  assert.equal(withEnsure.sent.length, 1);

  const withoutEnsure = makeDeps({ argv: ['stop'] });
  await cli.main(withoutEnsure.deps);
  assert.equal(withoutEnsure.ensured.length, 0);
  assert.equal(withoutEnsure.sent.length, 1);
});

test('the default ensureDaemon delegates to the daemon lifecycle', async () => {
  const spawns = [];
  const installs = [];

  const result = await cli.ensureDaemon({
    eventName: 'session-start',
    endpoint: 'test-endpoint',
    probe: async () => true,
    spawn: () => { spawns.push('spawn'); return { unref() {} }; },
    install: async () => { installs.push('install'); },
  });

  assert.equal(result, 'running');
  assert.deepEqual(spawns, [], 'a running daemon must not be launched again');
  assert.deepEqual(installs, []);
});

test('the daemon boundary hands over to the installer when nothing is installed', async () => {
  const installs = [];

  const result = await cli.ensureDaemon({
    eventName: 'session-start',
    endpoint: 'test-endpoint',
    platform: 'win32',
    env: {},
    probe: async () => false,
    exists: () => false,
    spawn: () => { throw new Error('nothing may be launched'); },
    install: async (info) => { installs.push(info); },
  });

  assert.equal(result, 'installing');
  assert.equal(installs.length, 1);
});

test('a failing daemon boundary never blocks delivery of the event', async () => {
  const { deps, sent, logs, exitCodes } = makeDeps({
    argv: ['session-start', '--ensure'],
    ensureDaemon: async () => { throw new Error('boom'); },
  });

  const result = await cli.main(deps);

  assert.equal(result.delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual(exitCodes, [0]);
});

test('--tool and --message stay available for the compatibility wrappers', async () => {
  const fallback = makeDeps({
    argv: ['notification', '--message', 'Claude is waiting'],
    stdin: fakeStdin([]),
  });
  await cli.main(fallback.deps);
  assert.equal(fallback.sent[0].event.metadata.summary, 'Claude is waiting');

  const toolFallback = makeDeps({
    argv: ['approval-needed', '--tool', 'Write'],
    stdin: fakeStdin([JSON.stringify({ tool_input: { file_path: '/a/b/main.ts' } })]),
  });
  await cli.main(toolFallback.deps);
  assert.equal(toolFallback.sent[0].event.tool, 'Write');
  assert.equal(toolFallback.sent[0].event.metadata.summary, 'main.ts');
});

test('stdin values win over the compatibility fallbacks', async () => {
  const { deps, sent } = makeDeps({
    argv: ['approval-needed', '--tool', 'Write'],
    stdin: fakeStdin([JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })]),
  });

  await cli.main(deps);

  assert.equal(sent[0].event.tool, 'Bash');
  assert.equal(sent[0].event.metadata.summary, 'ls');
});

test('a transport failure logs only the error code and still exits 0', async () => {
  const { deps, logs, exitCodes } = makeDeps({
    argv: ['approval-needed'],
    stdin: fakeStdin([JSON.stringify({ tool_name: 'Bash', tool_input: { command: SECRET } })]),
    sendEvent: async () => {
      const error = new Error(`connect ENOENT ${SECRET}`);
      error.code = 'ENOENT';
      throw error;
    },
  });

  const result = await cli.main(deps);

  assert.equal(result.delivered, false);
  assert.equal(result.rejected, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ENOENT/);
  assert.ok(!logs[0].includes(SECRET), 'logs must never contain the payload');
  assert.deepEqual(exitCodes, [0]);
});

test('a stdin read failure is handled without a synthetic event', async () => {
  const failing = new EventEmitter();
  failing.isTTY = false;
  queueMicrotask(() => failing.emit('error', new Error('stdin exploded')));

  const { deps, sent, exitCodes } = makeDeps({ argv: ['stop'], stdin: failing });

  const result = await cli.main(deps);

  // An empty read is a valid empty payload, exactly like a hook with no stdin.
  assert.equal(result.rejected, false);
  assert.equal(sent.length, 1);
  assert.deepEqual(exitCodes, [0]);
});
