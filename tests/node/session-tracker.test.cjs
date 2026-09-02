const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildEvent } = require('../../plugin/scripts/lib/event.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ESBUILD = path.join(REPO_ROOT, 'daemon', 'node_modules', 'esbuild');
const SOURCE = path.join(REPO_ROOT, 'daemon', 'src', 'main', 'session-tracker.ts');

// SessionTracker is TypeScript, so it is bundled once into a unique temporary
// directory and required from there. Nothing is written to daemon/dist and no
// Electron is loaded. Every tracker below is pointed at its own temporary state
// directory, so the real ~/.varie-claude-avatar/state.json is never read,
// written or even resolved.
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vca-session-tracker-'));
const bundlePath = path.join(buildDir, 'session-tracker.cjs');

after(() => {
  fs.rmSync(buildDir, { recursive: true, force: true });
});

function buildSessionTracker() {
  const esbuild = require(ESBUILD);
  esbuild.buildSync({
    entryPoints: [SOURCE],
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

const { SessionTracker } = buildSessionTracker();

/** Runs one case against a private state directory, removed in a finally. */
function withStateDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vca-session-state-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Registers one event's metadata and reads the session back. */
function roundTrip(metadata, sessionId = 's-1') {
  return withStateDir((dir) => {
    const tracker = new SessionTracker(dir);
    tracker.addSession(sessionId, metadata);
    return tracker.getSession(sessionId);
  });
}

// --- the real pipeline -------------------------------------------------------

test('cwd and terminal survive buildEvent -> addSession -> getSession', () => {
  // The source of truth is what the caller handed the client, not a value this
  // test recomputes: the assertions compare against the context inputs.
  const cwd = 'C:\\work\\my repo';
  const terminal = 'iTerm.app';

  const event = buildEvent('session-start', { session_id: 's-42' }, {
    cwd, terminal, now: 1, env: {},
  });

  const stored = roundTrip(event.metadata, event.sessionId);

  assert.equal(stored.id, 's-42', 'the session id is preserved');
  assert.equal(stored.cwd, cwd, 'the working directory survives end to end');
  assert.equal(stored.terminal, terminal, 'the terminal survives end to end');
});

test('a terminal detected from the environment also survives end to end', () => {
  const event = buildEvent('session-start', { session_id: 's-43' }, {
    cwd: '/home/dev/repo', now: 1, env: { TERM_PROGRAM: 'Apple_Terminal' },
  });

  const stored = roundTrip(event.metadata, event.sessionId);

  assert.equal(stored.cwd, '/home/dev/repo');
  assert.equal(stored.terminal, 'Apple_Terminal');
});

test('an undetectable terminal stays undefined rather than being invented', () => {
  const event = buildEvent('session-start', { session_id: 's-44' }, {
    cwd: '/home/dev/repo', now: 1, env: {},
  });

  assert.ok(!('terminal' in event.metadata));

  const stored = roundTrip(event.metadata, event.sessionId);
  assert.equal(stored.terminal, undefined);
  assert.equal(stored.cwd, '/home/dev/repo');
});

// --- precedence --------------------------------------------------------------

test('a legacy event carrying only projectPath still yields a correct cwd', () => {
  // Exactly what the pre-Node Bash notifier emitted, and what any client older
  // than this release still emits.
  const stored = roundTrip({ project: 'repo', projectPath: '/home/dev/repo', summary: '' });

  assert.equal(stored.cwd, '/home/dev/repo');
});

test('the canonical cwd wins over projectPath when the two differ', () => {
  const stored = roundTrip({
    project: 'repo',
    cwd: '/canonical/working/dir',
    projectPath: '/display/path',
    summary: '',
  });

  assert.equal(stored.cwd, '/canonical/working/dir');
});

test('an unusable cwd never shadows a usable projectPath', () => {
  const unusable = ['', '   ', '\t\n ', 42, 0, null, true, {}, [], undefined];

  for (const cwd of unusable) {
    const stored = roundTrip({ cwd, projectPath: '/home/dev/repo', summary: '' });

    assert.equal(
      stored.cwd,
      '/home/dev/repo',
      `cwd ${JSON.stringify(cwd)} must fall through to projectPath`,
    );
  }
});

test('when neither value is usable the cwd stays undefined', () => {
  for (const metadata of [
    {},
    { cwd: '', projectPath: '' },
    { cwd: '   ', projectPath: '  ' },
    { cwd: 7, projectPath: [] },
    undefined,
  ]) {
    const stored = roundTrip(metadata);

    assert.equal(stored.cwd, undefined, `${JSON.stringify(metadata)} must not invent a cwd`);
  }
});

test('an unusable terminal is dropped instead of stored as a broken value', () => {
  for (const terminal of ['', '   ', 42, null, {}, []]) {
    const stored = roundTrip({ projectPath: '/repo', terminal });

    assert.equal(stored.terminal, undefined, `${JSON.stringify(terminal)} is not a terminal`);
  }
});

// --- persistence and isolation ----------------------------------------------

test('the resolved values survive being written and re-read from disk', () => {
  withStateDir((dir) => {
    const first = new SessionTracker(dir);
    const event = buildEvent('session-start', { session_id: 's-77' }, {
      cwd: '/home/dev/repo', terminal: 'vscode', now: 1, env: {},
    });
    first.addSession(event.sessionId, event.metadata);

    // A second tracker reads the file the first one wrote.
    const reopened = new SessionTracker(dir);
    const stored = reopened.getSession('s-77');

    assert.equal(stored.cwd, '/home/dev/repo');
    assert.equal(stored.terminal, 'vscode');
    assert.equal(stored.id, 's-77');
  });
});

test('the whole metadata object is still retained alongside the resolved fields', () => {
  const stored = roundTrip({
    project: 'repo',
    projectPath: '/home/dev/repo',
    cwd: '/home/dev/repo',
    summary: 'npm test',
  });

  assert.equal(stored.metadata.summary, 'npm test', 'nothing that arrived is dropped');
  assert.equal(stored.metadata.projectPath, '/home/dev/repo');
});

test('a tracker writes only inside the directory it was given', () => {
  withStateDir((dir) => {
    const tracker = new SessionTracker(dir);
    tracker.addSession('s-1', { projectPath: '/repo' });

    assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'only the state file is created');
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(written.sessions[0].cwd, '/repo');
  });
});

test('the production default is unchanged: the user state directory under the home', () => {
  // The constructor argument exists for these tests only; a SessionTracker
  // built with no argument must still resolve the real per-user directory.
  const source = fs.readFileSync(SOURCE, 'utf8');

  assert.match(
    source,
    /os\.homedir\(\)\s*,\s*'\.varie-claude-avatar'/,
    'the default must stay the real user state directory',
  );
  assert.match(source, /constructor\s*\(/);
});
