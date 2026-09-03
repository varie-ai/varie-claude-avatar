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
  const printed = [];
  const probes = [];

  const deps = {
    argv: [],
    stdin: fakeStdin(['{}']),
    getIpcEndpoint: () => 'test-endpoint',
    sendEvent: async (endpoint, event) => { sent.push({ endpoint, event }); },
    ensureDaemon: async (info) => { ensured.push(info); },
    probeDaemon: async (endpoint, options) => { probes.push({ endpoint, options }); return false; },
    print: (text) => { printed.push(text); },
    log: (message) => { logs.push(message); },
    setExitCode: (code) => { exitCodes.push(code); },
    context: { cwd: '/repo', now: 100, env: {}, pid: 7 },
    ...overrides,
  };

  return { deps, sent, logs, ensured, exitCodes, printed, probes };
}

test('parseArgs reads the command, the event name, --ensure and the fallbacks', () => {
  assert.deepEqual(cli.parseArgs(['session-start', '--ensure']), {
    command: 'event', eventName: 'session-start', ensure: true,
    tool: undefined, message: undefined, characterId: undefined,
  });

  assert.deepEqual(cli.parseArgs(['approval-needed', '--tool', 'Bash']), {
    command: 'event', eventName: 'approval-needed', ensure: false,
    tool: 'Bash', message: undefined, characterId: undefined,
  });

  assert.deepEqual(cli.parseArgs(['notification', '--message', 'Claude is waiting']), {
    command: 'event', eventName: 'notification', ensure: false,
    tool: undefined, message: 'Claude is waiting', characterId: undefined,
  });

  assert.deepEqual(cli.parseArgs(['notification', '--message=Claude is waiting']), {
    command: 'event', eventName: 'notification', ensure: false,
    tool: undefined, message: 'Claude is waiting', characterId: undefined,
  });

  assert.deepEqual(cli.parseArgs([]), {
    command: 'event', eventName: 'unknown', ensure: false,
    tool: undefined, message: undefined, characterId: undefined,
  });

  assert.deepEqual(cli.parseArgs(['status']), {
    command: 'status', eventName: 'status', ensure: false,
    tool: undefined, message: undefined, characterId: undefined,
  });

  assert.deepEqual(cli.parseArgs(['reload-character', '--character-id', 'abc']), {
    command: 'reload-character', eventName: 'reload-character', ensure: false,
    tool: undefined, message: undefined, characterId: 'abc',
  });

  assert.deepEqual(cli.parseArgs(['reload-character', '--character-id=abc']), {
    command: 'reload-character', eventName: 'reload-character', ensure: false,
    tool: undefined, message: undefined, characterId: 'abc',
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
    metadata: { project: 'repo', projectPath: '/repo', cwd: '/repo', summary: 'ls -la' },
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

// ---------------------------------------------------------------------------
// Operational sub-commands: `status` and `reload-character`.
//
// Both are invoked by the plugin skills, never by hooks.json. Neither may read
// stdin, and neither may start or install anything.
// ---------------------------------------------------------------------------

/**
 * A stdin stub that never ends and records whether anyone tried to read it.
 *
 * `reads` proves intent (a listener was attached); the missing 'end' proves
 * consequence (a reader would hang). Every test using it sets a timeout so a
 * regression fails fast instead of blocking the suite.
 */
function neverEndingStdin() {
  const stream = new EventEmitter();
  stream.isTTY = false;
  stream.reads = 0;
  stream.on('newListener', (event) => {
    if (event === 'data' || event === 'end' || event === 'close') stream.reads += 1;
  });
  return stream;
}

const COMMAND_TIMEOUT_MS = 5000;

test('status never reads stdin', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const stdin = neverEndingStdin();
  const { deps, printed } = makeDeps({ argv: ['status'], stdin });

  await cli.main(deps);

  assert.equal(stdin.reads, 0, 'status must not attach a reader to stdin');
  assert.equal(printed.length, 1, 'status must answer without waiting for stdin');
});

test('reload-character never reads stdin either', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const stdin = neverEndingStdin();
  const { deps, sent } = makeDeps({
    argv: ['reload-character', '--character-id', 'abc'],
    stdin,
  });

  await cli.main(deps);

  assert.equal(stdin.reads, 0, 'a skill invocation has no hook payload to read');
  assert.equal(sent.length, 1);
});

test('status probes the shared endpoint with a bounded budget', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, probes } = makeDeps({
    argv: ['status'],
    getIpcEndpoint: () => 'shared-endpoint',
  });

  await cli.main(deps);

  assert.equal(probes.length, 1, 'exactly one probe');
  assert.equal(probes[0].endpoint, 'shared-endpoint', 'the probe must use the shared endpoint');
  const timeoutMs = probes[0].options && probes[0].options.timeoutMs;
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'the probe must be bounded');
});

test('the status probe boundary reaches the real bounded lifecycle probe', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  // No server is created: an endpoint nobody listens on must answer false,
  // quickly, without throwing. This is the only test here that touches net.
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\varie-avatar-absent-${process.pid}`
    : `/tmp/varie-avatar-absent-${process.pid}.sock`;

  const answered = await cli.probeDaemon(endpoint, { timeoutMs: 250 });

  assert.equal(answered, false);
});

test('a reachable daemon prints exactly RUNNING', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, printed, exitCodes } = makeDeps({
    argv: ['status'],
    probeDaemon: async () => true,
  });

  const result = await cli.main(deps);

  assert.deepEqual(printed, ['RUNNING']);
  assert.equal(result.running, true);
  assert.deepEqual(exitCodes, [0]);
});

test('an unreachable daemon prints exactly NOT_RUNNING', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, printed, exitCodes } = makeDeps({
    argv: ['status'],
    probeDaemon: async () => false,
  });

  const result = await cli.main(deps);

  assert.deepEqual(printed, ['NOT_RUNNING']);
  assert.equal(result.running, false);
  assert.deepEqual(exitCodes, [0]);
});

test('a probe that throws is reported as NOT_RUNNING, not as a crash', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, printed, logs, exitCodes } = makeDeps({
    argv: ['status'],
    probeDaemon: async () => {
      const error = new Error('pipe exploded');
      error.code = 'EPIPE';
      throw error;
    },
  });

  const result = await cli.main(deps);

  assert.deepEqual(printed, ['NOT_RUNNING']);
  assert.equal(result.running, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /EPIPE/);
  assert.ok(!logs[0].includes('pipe exploded'), 'only the error code may be logged');
  assert.deepEqual(exitCodes, [0]);
});

test('status starts nothing and sends nothing', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, sent, ensured, printed } = makeDeps({ argv: ['status'] });

  await cli.main(deps);

  assert.deepEqual(ensured, [], 'status must not launch or install the daemon');
  assert.deepEqual(sent, [], 'status must not send an event');
  assert.equal(printed.length, 1);
});

test('status ignores --ensure: it is a query, never a bootstrap', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, sent, ensured, printed } = makeDeps({ argv: ['status', '--ensure'] });

  await cli.main(deps);

  assert.deepEqual(ensured, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(printed, ['NOT_RUNNING']);
});

test('reload-character sends reload_character with the exact character id', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, sent, printed, exitCodes } = makeDeps({
    argv: ['reload-character', '--character-id', 'abc'],
  });

  const result = await cli.main(deps);

  assert.equal(result.delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].endpoint, 'test-endpoint');
  assert.equal(sent[0].event.protocolVersion, 1);
  assert.equal(sent[0].event.type, 'reload_character');
  assert.equal(sent[0].event.metadata.characterId, 'abc');
  assert.deepEqual(printed, ['RELOAD_SENT']);
  assert.deepEqual(exitCodes, [0]);
});

test('the equals form carries the same identifier and event type', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, sent } = makeDeps({
    argv: ['reload-character', '--character-id=soren_cb3333dd3e3f'],
    context: { cwd: '/repo', now: 100, env: { CLAUDE_SESSION_ID: 'sess-9' }, pid: 7 },
  });

  await cli.main(deps);

  assert.equal(sent[0].event.type, 'reload_character');
  assert.equal(sent[0].event.metadata.characterId, 'soren_cb3333dd3e3f');
  assert.equal(sent[0].event.sessionId, 'sess-9', 'the session id still comes from the environment');
});

test('reload-character never bootstraps the daemon', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, ensured } = makeDeps({
    argv: ['reload-character', '--character-id', 'abc', '--ensure'],
  });

  await cli.main(deps);

  assert.deepEqual(ensured, [], 'switching a character must not install anything');
});

test('a missing or whitespace-only id opens no connection at all', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const cases = [
    ['reload-character'],
    ['reload-character', '--character-id', '   '],
    ['reload-character', '--character-id='],
    ['reload-character', '--character-id', '\t\n '],
  ];

  for (const argv of cases) {
    const { deps, sent, probes, printed, exitCodes } = makeDeps({ argv });

    const result = await cli.main(deps);

    assert.equal(result.delivered, false, `${argv.join(' ')} must not be delivered`);
    assert.equal(result.reason, 'missing_character_id');
    assert.deepEqual(sent, [], `${argv.join(' ')} must not open the transport`);
    assert.deepEqual(probes, [], `${argv.join(' ')} must not open a probe either`);
    assert.deepEqual(printed, ['MISSING_CHARACTER_ID']);
    assert.deepEqual(exitCodes, [0]);
  }
});

test('a flag where the id should be counts as a missing id', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, sent, printed } = makeDeps({
    argv: ['reload-character', '--character-id', '--ensure'],
  });

  const result = await cli.main(deps);

  assert.equal(result.reason, 'missing_character_id');
  assert.deepEqual(sent, [], 'a swallowed flag must never travel as an identifier');
  assert.deepEqual(printed, ['MISSING_CHARACTER_ID']);
});

test('shell metacharacters stay data and never leave the metadata field', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const hostile = '$(whoami); rm -rf / & `id` | "quoted" \'x\'';
  const { deps, sent, printed } = makeDeps({
    argv: ['reload-character', '--character-id', hostile],
  });

  await cli.main(deps);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.metadata.characterId, hostile, 'the value is transported verbatim');
  assert.equal(sent[0].event.type, 'reload_character');
  assert.equal(sent[0].event.tool, undefined);

  // The value must appear nowhere except that one metadata field.
  const elsewhere = { ...sent[0].event, metadata: { ...sent[0].event.metadata, characterId: '' } };
  assert.ok(!JSON.stringify(elsewhere).includes('whoami'), 'the id must not leak into another field');
  assert.deepEqual(printed, ['RELOAD_SENT']);
});

test('surrounding whitespace is trimmed rather than transported', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, sent } = makeDeps({
    argv: ['reload-character', '--character-id', '  abc  '],
  });

  await cli.main(deps);

  assert.equal(sent[0].event.metadata.characterId, 'abc');
});

test('a failed reload is reported as RELOAD_FAILED and still exits 0', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  const { deps, printed, logs, exitCodes } = makeDeps({
    argv: ['reload-character', '--character-id', 'abc'],
    sendEvent: async () => {
      const error = new Error('connect ENOENT abc');
      error.code = 'ENOENT';
      throw error;
    },
  });

  const result = await cli.main(deps);

  assert.equal(result.delivered, false);
  assert.deepEqual(printed, ['RELOAD_FAILED']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ENOENT/);
  assert.deepEqual(exitCodes, [0]);
});

test('an unknown first argument is still treated as a hook event', { timeout: COMMAND_TIMEOUT_MS }, async () => {
  // Only the two documented sub-commands are commands; everything else keeps
  // the original hook behaviour.
  const { deps, sent, printed } = makeDeps({ argv: ['reload_character'] });

  await cli.main(deps);

  assert.equal(sent.length, 1, 'an unrecognised name stays on the event path');
  assert.deepEqual(printed, [], 'the event path prints nothing');
});

test('requiring the CLI is inert: no probe, no output, no process work', () => {
  const modulePath = require.resolve('../../plugin/scripts/varie-avatar-hook.cjs');
  const previous = require.cache[modulePath];
  delete require.cache[modulePath];

  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };

  let reloaded;
  try {
    reloaded = require(modulePath);
  } finally {
    process.stdout.write = originalWrite;
    if (previous) require.cache[modulePath] = previous;
  }

  assert.deepEqual(writes, [], 'importing must not print anything');
  for (const name of ['parseArgs', 'readStdin', 'ensureDaemon', 'probeDaemon', 'main']) {
    assert.equal(typeof reloaded[name], 'function', `${name} must be exported`);
  }
  assert.equal(reloaded.parseArgs([]).command, 'event');
});
