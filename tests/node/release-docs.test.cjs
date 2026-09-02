const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cli = require('../../plugin/scripts/varie-avatar-hook.cjs');
const { buildEvent } = require('../../plugin/scripts/lib/event.cjs');

// This suite reads files only. It starts no workflow, no packaging, no daemon
// and no network call.
const REPO_ROOT = path.join(__dirname, '..', '..');

const CI_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const RELEASE_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const CHECKLIST_PATH = path.join(REPO_ROOT, 'docs', 'windows-release-checklist.md');
const RUNNER_PATH = path.join(REPO_ROOT, 'tests', 'node', 'run-tests.cjs');
const SOCKET_SERVER_PATH = path.join(REPO_ROOT, 'daemon', 'src', 'main', 'socket-server.ts');
const ADAPTER_PATH = path.join(
  REPO_ROOT, 'daemon', 'src', 'main', 'terminal-actions', 'create-terminal-actions.ts',
);

const SKILL_PATHS = {
  install: path.join(REPO_ROOT, 'plugin', 'skills', 'install', 'SKILL.md'),
  status: path.join(REPO_ROOT, 'plugin', 'skills', 'status', 'SKILL.md'),
  set: path.join(REPO_ROOT, 'plugin', 'skills', 'set', 'SKILL.md'),
};

const read = (file) => fs.readFileSync(file, 'utf8');

// ---------------------------------------------------------------------------
// A parser for the YAML subset these workflows use.
//
// It exists so the assertions below can talk about jobs, steps and permissions
// instead of matching substrings: a check on "the step that runs test -x" must
// find that step's own `if`, not any `if` in the file. Block mappings, block
// sequences, flow sequences, quoted and plain scalars and block scalars are
// supported; anchors, aliases and flow mappings are not, and the workflows do
// not use them.
// ---------------------------------------------------------------------------

function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  let index = 0;

  const isBlank = (line) => line.trim() === '';
  const isComment = (line) => /^\s*#/.test(line);
  const indentOf = (line) => line.length - line.trimStart().length;

  function skipIgnorable() {
    while (index < lines.length && (isBlank(lines[index]) || isComment(lines[index]))) index += 1;
  }

  function parseScalar(token) {
    if (token === '') return null;
    if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
      return token.slice(1, -1).replace(/''/g, "'");
    }
    if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
      return token.slice(1, -1);
    }
    if (token.startsWith('[') && token.endsWith(']')) {
      const inner = token.slice(1, -1).trim();
      return inner === '' ? [] : inner.split(',').map((item) => parseScalar(item.trim()));
    }
    return token;
  }

  /** Collects every line more indented than the key that introduced the block. */
  function parseBlockScalar(parentIndent) {
    const collected = [];
    let blockIndent = null;

    while (index < lines.length) {
      const line = lines[index];
      if (isBlank(line)) {
        collected.push('');
        index += 1;
        continue;
      }
      const ind = indentOf(line);
      if (ind <= parentIndent) break;
      if (blockIndent === null) blockIndent = ind;
      if (ind < blockIndent) break;
      collected.push(line.slice(blockIndent));
      index += 1;
    }

    while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
    return collected.join('\n');
  }

  function parseNode(minIndent) {
    skipIgnorable();
    if (index >= lines.length) return null;
    const ind = indentOf(lines[index]);
    if (ind < minIndent) return null;
    return lines[index].trim().startsWith('-') ? parseSequence(ind) : parseMapping(ind);
  }

  function parseSequence(indent) {
    const items = [];

    for (;;) {
      skipIgnorable();
      if (index >= lines.length) break;
      const line = lines[index];
      if (indentOf(line) !== indent) break;
      const trimmed = line.trim();
      if (!trimmed.startsWith('-')) break;

      const rest = trimmed === '-' ? '' : trimmed.slice(1).trim();

      if (rest === '') {
        index += 1;
        items.push(parseNode(indent + 1));
        continue;
      }

      // "- key: value" is a mapping whose first key sits where the value does.
      // Rewriting the marker into spaces lets the mapping parser own the line.
      if (/^[^\s"'[][^:]*:(\s|$)/.test(rest)) {
        lines[index] = ' '.repeat(indent + 2) + rest;
        items.push(parseMapping(indent + 2));
        continue;
      }

      index += 1;
      items.push(parseScalar(rest));
    }

    return items;
  }

  function parseMapping(indent) {
    const map = {};

    for (;;) {
      skipIgnorable();
      if (index >= lines.length) break;
      const line = lines[index];
      if (indentOf(line) !== indent) break;
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) break;

      const match = /^([^:]+):(?:\s+(.*))?$/.exec(trimmed);
      assert.ok(match, `line ${index + 1} is not a mapping entry: ${line}`);

      const key = match[1].trim();
      const rest = (match[2] ?? '').trim();
      index += 1;

      if (/^[|>][-+]?$/.test(rest)) {
        map[key] = parseBlockScalar(indent);
      } else if (rest === '') {
        map[key] = parseNode(indent + 1);
      } else {
        map[key] = parseScalar(rest);
      }
    }

    return map;
  }

  const document = parseNode(0);
  skipIgnorable();
  assert.equal(index, lines.length, `unconsumed content at line ${index + 1}`);
  return document;
}

const ci = parseYaml(read(CI_PATH));
const release = parseYaml(read(RELEASE_PATH));

// ---------------------------------------------------------------------------
// Sources of truth
// ---------------------------------------------------------------------------

const pkg = JSON.parse(read(path.join(REPO_ROOT, 'daemon', 'package.json')));

/** Expands an electron-builder artifactName template. */
function expandArtifactName(template, values) {
  return template.replace(/\$\{(\w+)\}/g, (whole, macro) => {
    assert.ok(macro in values, `unexpanded macro: ${macro}`);
    return values[macro];
  });
}

function windowsArtifactName(target, version) {
  return expandArtifactName(pkg.build[target].artifactName, {
    productName: pkg.build.productName,
    version,
    arch: 'x64',
    ext: 'exe',
  });
}

/** Event types the daemon actually accepts, read from the server itself. */
const DAEMON_EVENT_TYPES = (() => {
  const source = read(SOCKET_SERVER_PATH);
  const block = /const VALID_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(source);
  assert.ok(block, 'VALID_EVENT_TYPES must be readable from socket-server.ts');
  const types = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(types.length > 5, 'the daemon must declare its event types');
  return new Set(types);
})();

/** Returns the contents of every fenced code block in a Markdown document. */
function fencedBlocks(markdown) {
  const blocks = [];
  let current = null;

  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) {
      if (current === null) current = [];
      else {
        blocks.push(current.join('\n'));
        current = null;
      }
      continue;
    }
    if (current !== null) current.push(line);
  }

  return blocks;
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// ---------------------------------------------------------------------------
// Workflow helpers
// ---------------------------------------------------------------------------

function jobRunsOnWindows(job) {
  const runsOn = job['runs-on'];
  if (typeof runsOn === 'string' && /windows/i.test(runsOn)) return true;
  if (typeof runsOn === 'string' && runsOn.includes('matrix.os')) {
    const targets = job.strategy?.matrix?.os ?? [];
    return targets.some((target) => /windows/i.test(target));
  }
  return false;
}

/** True when the step is not restricted away from Windows by its own `if`. */
function stepRunsOnWindows(job, step) {
  if (!jobRunsOnWindows(job)) return false;
  const condition = step.if;
  if (typeof condition !== 'string') return true;
  return !/runner\.os\s*==\s*'(macOS|Linux)'/.test(condition);
}

const runSteps = (job) => (job.steps ?? []).filter((step) => typeof step.run === 'string');

// ---------------------------------------------------------------------------
// Workflows: presence and shape
// ---------------------------------------------------------------------------

test('both workflows exist and parse into jobs', () => {
  assert.ok(fs.existsSync(CI_PATH));
  assert.ok(fs.existsSync(RELEASE_PATH));

  assert.equal(ci.name, 'CI');
  assert.equal(release.name, 'Release');
  assert.deepEqual(Object.keys(ci.jobs), ['build']);
  assert.deepEqual(Object.keys(release.jobs), ['build-mac', 'build-win', 'release']);

  for (const job of [...Object.values(ci.jobs), ...Object.values(release.jobs)]) {
    assert.ok(Array.isArray(job.steps) && job.steps.length > 0, 'every job needs steps');
  }
});

test('CI runs the matrix on macOS and Windows without fail-fast', () => {
  const job = ci.jobs.build;

  assert.deepEqual(job.strategy.matrix.os, ['macos-latest', 'windows-latest']);
  assert.equal(String(job.strategy['fail-fast']), 'false', 'one platform must not cancel the other');
  assert.equal(job['runs-on'], '${{ matrix.os }}');

  const setup = job.steps.find((step) => String(step.uses ?? '').startsWith('actions/setup-node'));
  assert.ok(setup, 'Node must be installed explicitly');
  assert.equal(String(setup.with['node-version']), '20');
  assert.equal(setup.with.cache, 'npm');
  assert.equal(setup.with['cache-dependency-path'], 'daemon/package-lock.json');
});

test('CI triggers on every directory whose change can break it', () => {
  for (const trigger of ['push', 'pull_request']) {
    const paths = ci.on[trigger].paths;
    for (const required of [
      'daemon/**', 'plugin/**', 'shared/**', 'tests/**',
      // release-docs.test.cjs validates these two documents, so a change to
      // either must run the suite that checks it.
      'README.md', 'docs/windows-release-checklist.md',
      '.github/workflows/ci.yml', '.github/workflows/release.yml',
    ]) {
      assert.ok(paths.includes(required), `${trigger} must watch ${required}`);
    }
  }
});

test('the root suite is invoked through the sequential runner, never a glob', () => {
  const RUNNER_COMMAND = 'node tests/node/run-tests.cjs';

  for (const [label, job] of [['ci.build', ci.jobs.build], ['release.build-win', release.jobs['build-win']]]) {
    const commands = runSteps(job).map((step) => step.run.trim());
    assert.ok(commands.includes(RUNNER_COMMAND), `${label} must run: ${RUNNER_COMMAND}`);
    assert.ok(commands.includes('npm test'), `${label} must also run the daemon test script`);
  }

  // A shell glob is expanded by bash and passed through verbatim by PowerShell.
  for (const [file, workflow] of [['ci.yml', ci], ['release.yml', release]]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of runSteps(job)) {
        assert.ok(!step.run.includes('*.test.cjs'), `${file} must not glob test files`);
        assert.ok(!/node\s+--test\s/.test(step.run), `${file} must not call node --test directly`);
      }
    }
  }

  // The runner, not the workflow, is what keeps the suites sequential.
  assert.match(read(RUNNER_PATH), /--test-concurrency=1/);
});

test('the daemon script the workflows call is the one package.json defines', () => {
  assert.equal(pkg.scripts.test, 'npm run test:node');
  assert.equal(pkg.scripts['test:node'], 'node ../tests/node/run-tests.cjs');
  assert.equal(pkg.scripts.build, 'npm run build:main && npm run build:preload && npm run build:renderer');
});

test('the executable-bit check runs on macOS only', () => {
  const steps = runSteps(ci.jobs.build).filter((step) => /(^|\s)test\s+-x\s/.test(step.run));
  assert.equal(steps.length, 1, 'exactly one step checks the executable bit');
  assert.equal(steps[0].if, "runner.os == 'macOS'", 'test -x does not exist in PowerShell');
});

test('hooks.json is validated with Node, not Python', () => {
  const steps = runSteps(ci.jobs.build).filter((step) => step.run.includes('hooks.json'));
  assert.equal(steps.length, 1);
  assert.match(steps[0].run, /^node\s/, 'the Windows runner has no guaranteed python3');
  assert.equal(steps[0].if, undefined, 'hooks.json must be validated on both platforms');

  // No step may invoke Python. A comment explaining why is not an invocation,
  // so the ban applies to the scripts, not to the file text.
  for (const [file, workflow] of [['ci.yml', ci], ['release.yml', release]]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of runSteps(job)) {
        assert.ok(
          !/(^|[\s;&|(])python[0-9.]*\s/.test(step.run),
          `${file} must not depend on a Python interpreter`,
        );
      }
    }
  }
});

test('no step that can run on Windows assumes a POSIX shell', () => {
  const FORBIDDEN = [
    [/(^|[\s;&|(])test\s+-[a-zA-Z]\b/, 'test -x / test -S'],
    [/(^|[\s;&|(])rm\s/, 'rm'],
    [/(^|[\s;&|(])cat\s/, 'cat'],
    [/(^|[\s;&|(])mkdir\s/, 'mkdir'],
    [/(^|[\s;&|(])nc\s/, 'nc'],
    [/(^|[\s;&|(])(sed|grep|find|xargs|sha256sum|chmod|touch|cp|mv|ls)\s/, 'POSIX coreutils'],
    [/date\s+\+/, 'date +format'],
    [/\$\(/, 'POSIX command substitution'],
    [/(^|\s)set\s+-[eux]/, 'set -e'],
    [/^\s*#!/m, 'shebang'],
  ];

  let checked = 0;
  for (const [file, workflow] of [['ci.yml', ci], ['release.yml', release]]) {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of runSteps(job)) {
        if (!stepRunsOnWindows(job, step)) continue;
        checked += 1;
        for (const [pattern, label] of FORBIDDEN) {
          assert.ok(
            !pattern.test(step.run),
            `${file} / ${jobName} / "${step.name ?? step.run}" uses ${label} on Windows`,
          );
        }
      }
    }
  }

  assert.ok(checked >= 8, 'the Windows-executed steps must actually have been inspected');
});

test('no Windows step opts into a shell the platform does not own', () => {
  // Selecting `shell: bash` would make Git Bash available on the Windows
  // runner and quietly reintroduce every POSIX assumption the check above
  // forbids, so a Windows-capable step must use the platform default.
  for (const [file, workflow] of [['ci.yml', ci], ['release.yml', release]]) {
    assert.equal(workflow.defaults, undefined, `${file} must not set a workflow-wide shell`);

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      assert.equal(job.defaults, undefined, `${file} / ${jobName} must not set a job-wide shell`);

      for (const step of job.steps ?? []) {
        if (!stepRunsOnWindows(job, step)) continue;
        assert.equal(
          step.shell, undefined,
          `${file} / ${jobName} / "${step.name ?? step.run}" must not choose its own shell`,
        );
      }
    }
  }
});

test('a build job cannot fail silently and still release', () => {
  // continue-on-error would let `needs` see a failed build as satisfied, and a
  // release would be published without that platform's artifacts.
  for (const [jobName, job] of Object.entries(release.jobs)) {
    assert.equal(
      job['continue-on-error'], undefined,
      `release.${jobName} must not swallow its own failure`,
    );
  }
  for (const [jobName, job] of Object.entries(ci.jobs)) {
    assert.equal(job['continue-on-error'], undefined, `ci.${jobName} must not swallow its own failure`);
  }
});

test('the POSIX guard would catch a regression', () => {
  // Guards the guard: the macOS-only step is POSIX on purpose, and the check
  // above only passes because that step is correctly excluded.
  const macOnly = runSteps(ci.jobs.build).find((step) => /(^|\s)test\s+-x\s/.test(step.run));
  assert.ok(macOnly);
  assert.equal(stepRunsOnWindows(ci.jobs.build, macOnly), false);

  const withoutGuard = { ...macOnly, if: undefined };
  assert.equal(stepRunsOnWindows(ci.jobs.build, withoutGuard), true);
});

// ---------------------------------------------------------------------------
// Release workflow
// ---------------------------------------------------------------------------

test('the release job cannot run unless both platforms built', () => {
  assert.deepEqual(release.jobs.release.needs, ['build-mac', 'build-win']);
  assert.equal(release.jobs['build-win']['runs-on'], 'windows-latest');
  assert.equal(release.jobs['build-mac']['runs-on'], 'macos-latest');
  assert.deepEqual(release.jobs['build-mac'].strategy.matrix.arch, ['arm64', 'x64']);
});

test('build-win tests, builds and packages x64 before uploading', () => {
  const commands = runSteps(release.jobs['build-win']).map((step) => step.run.trim());

  assert.ok(commands.includes('npm ci'));
  assert.ok(commands.includes('npm run build'));

  const packaging = commands.filter((command) => command.includes('electron-builder'));
  assert.deepEqual(packaging, ['npx electron-builder --win --x64 --publish never']);

  const packagingStep = runSteps(release.jobs['build-win'])
    .find((step) => step.run.includes('electron-builder'));
  assert.equal(packagingStep.env.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
  assert.equal(packagingStep['working-directory'], 'daemon');
});

test('setup and portable are uploaded separately and may not be missing', () => {
  const uploads = (release.jobs['build-win'].steps ?? [])
    .filter((step) => String(step.uses ?? '').startsWith('actions/upload-artifact'));

  assert.equal(uploads.length, 2, 'one upload per artifact family');

  const names = uploads.map((step) => step.with.name);
  assert.equal(new Set(names).size, 2, 'artifact names must not collide');

  const setupName = windowsArtifactName('nsis', pkg.version);
  const portableName = windowsArtifactName('portable', pkg.version);
  assert.notEqual(setupName, portableName);

  const matched = new Set();
  for (const upload of uploads) {
    assert.equal(upload.with['if-no-files-found'], 'error', 'a missing family must fail the job');

    const pattern = upload.with.path;
    assert.equal(typeof pattern, 'string', 'each family is one glob, not a list');
    assert.match(pattern, /\.exe$/);
    assert.ok(pattern.startsWith('daemon/release/'));

    const glob = globToRegExp(path.posix.basename(pattern));
    const hits = [setupName, portableName].filter((name) => glob.test(name));
    assert.equal(hits.length, 1, `${pattern} must match exactly one family, not ${hits.length}`);
    matched.add(hits[0]);
  }

  assert.deepEqual([...matched].sort(), [portableName, setupName].sort(), 'both families are uploaded');
});

test('the release publishes macOS and Windows artifacts and fails on a missing pattern', () => {
  const publish = release.jobs.release.steps
    .find((step) => String(step.uses ?? '').startsWith('softprops/action-gh-release'));
  assert.ok(publish, 'a release must actually be created');

  const files = publish.with.files.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(files, [
    'artifacts/**/*.dmg',
    'artifacts/**/*.zip',
    'artifacts/**/*.exe',
  ]);
  assert.equal(String(publish.with.fail_on_unmatched_files), 'true');

  // A step must prove every family arrived before the release is created.
  const stepNames = release.jobs.release.steps.map((step) => step.name ?? '');
  const verifyIndex = stepNames.findIndex((name) => /verify/i.test(name));
  const publishIndex = release.jobs.release.steps.indexOf(publish);
  assert.ok(verifyIndex >= 0, 'the release job must verify the downloaded artifacts');
  assert.ok(verifyIndex < publishIndex, 'verification must precede publication');

  const verify = release.jobs.release.steps[verifyIndex];
  for (const family of ['*.dmg', '*-mac.zip', '*-win-x64-setup.exe', '*-win-x64-portable.exe']) {
    assert.ok(verify.run.includes(family), `the check must require ${family}`);
  }
  assert.match(verify.run, /uniq -d/, 'colliding basenames must be detected, not published silently');
});

test('the release body documents both Windows families and SmartScreen', () => {
  const publish = release.jobs.release.steps
    .find((step) => String(step.uses ?? '').startsWith('softprops/action-gh-release'));
  const body = publish.with.body;

  assert.match(body, /-win-x64-setup\.exe/);
  assert.match(body, /-win-x64-portable\.exe/);
  assert.match(body, /SmartScreen/);
  assert.match(body, /%LOCALAPPDATA%\\Programs\\Varie Claude Avatar/);
  assert.match(body, /Apple Silicon/);

  // The macOS x64 artifact carries no architecture suffix, so promising a
  // "-x64.dmg" would send Intel users looking for a file that never exists.
  assert.ok(!body.includes('-x64.dmg'), 'the Intel dmg has no arch suffix');
});

test('only the job that creates the release may write, and no step prints a secret', () => {
  assert.equal(release.permissions.contents, 'read', 'the workflow default is read-only');
  assert.equal(ci.permissions.contents, 'read');

  assert.equal(release.jobs.release.permissions.contents, 'write');
  assert.equal(release.jobs['build-mac'].permissions.contents, 'read');
  assert.equal(release.jobs['build-win'].permissions.contents, 'read');

  for (const [file, workflow] of [['ci.yml', ci], ['release.yml', release]]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of runSteps(job)) {
        assert.ok(!step.run.includes('secrets.'), `${file} must not interpolate a secret into a script`);
        assert.ok(!/echo\s+.*(TOKEN|PASSWORD|CSC_LINK)/.test(step.run), `${file} must not echo a credential`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Documented commands must exist
// ---------------------------------------------------------------------------

/** Every sub-command or event name documentation passes to the hook CLI. */
function citedHookCommands(text) {
  const cited = [];
  const pattern = /varie-avatar-hook\.cjs(?:"|')?\s+([a-z][a-z0-9-]*)/g;
  for (const match of text.matchAll(pattern)) cited.push(match[1]);
  return cited;
}

test('every documented hook CLI invocation is a mode the CLI really has', () => {
  const documents = { README: read(README_PATH), ...Object.fromEntries(
    Object.entries(SKILL_PATHS).map(([name, file]) => [`skills/${name}`, read(file)]),
  ) };

  let total = 0;
  for (const [label, text] of Object.entries(documents)) {
    for (const cited of citedHookCommands(text)) {
      total += 1;
      const parsed = cli.parseArgs([cited]);

      if (parsed.command !== 'event') {
        assert.ok(cli.COMMANDS.has(cited), `${label} cites unknown sub-command ${cited}`);
        continue;
      }

      // Anything that is not a sub-command is sent as an event, so the daemon
      // must be willing to accept the type the CLI would build.
      const built = buildEvent(cited, {}, { cwd: '/x', now: 1, env: {}, pid: 1 });
      assert.ok(
        DAEMON_EVENT_TYPES.has(built.type),
        `${label} documents "${cited}", which the daemon would reject as ${built.type}`,
      );
    }
  }

  assert.ok(total >= 5, 'the documentation must actually cite the CLI');
});

test('status is a real mode precisely because it is not a valid event', () => {
  assert.ok(cli.COMMANDS.has('status'));
  assert.equal(cli.parseArgs(['status']).command, 'status');

  const asEvent = buildEvent('status', {}, { cwd: '/x', now: 1, env: {}, pid: 1 });
  assert.ok(
    !DAEMON_EVENT_TYPES.has(asEvent.type),
    'documenting status as an event would send something the daemon rejects',
  );
});

test('reload-character is documented with the flag it actually parses', () => {
  const built = buildEvent('reload-character', {}, { cwd: '/x', now: 1, env: {}, pid: 1 });
  assert.ok(DAEMON_EVENT_TYPES.has(built.type));
  assert.equal(built.type, 'reload_character');

  for (const [label, file] of [['README', README_PATH], ['skills/set', SKILL_PATHS.set]]) {
    const text = read(file);
    if (!text.includes('reload-character')) continue;
    for (const line of text.split('\n').filter((candidate) => candidate.includes('reload-character'))) {
      if (!line.includes('varie-avatar-hook.cjs')) continue;
      assert.match(line, /--character-id/, `${label}: reload-character needs an id`);
    }
  }

  // The flag the docs show is the one the parser fills.
  assert.equal(cli.parseArgs(['reload-character', '--character-id', 'abc']).characterId, 'abc');
});

test('the tokens the set skill tells the agent to branch on are the ones printed', () => {
  const text = read(SKILL_PATHS.set);
  for (const token of Object.values(cli.RELOAD_TOKENS)) {
    assert.ok(text.includes(token), `the skill must document ${token}`);
  }
  for (const token of Object.values(cli.STATUS_TOKENS)) {
    assert.ok(read(SKILL_PATHS.status).includes(token), `the status skill must document ${token}`);
  }
});

test('the installer entry point the skills document exists and takes --verbose', () => {
  const installer = path.join(REPO_ROOT, 'plugin', 'scripts', 'lib', 'install-daemon.cjs');
  assert.ok(fs.existsSync(installer));
  assert.match(read(installer), /argv\.includes\('--verbose'\)/);

  for (const [name, file] of Object.entries(SKILL_PATHS)) {
    if (name !== 'install') continue;
    const text = read(file);
    assert.match(text, /scripts\/lib\/install-daemon\.cjs" --verbose/, 'POSIX form');
    assert.match(text, /scripts\\lib\\install-daemon\.cjs" --verbose/, 'PowerShell form');
  }
});

// ---------------------------------------------------------------------------
// Skills: no obsolete or non-portable instructions
// ---------------------------------------------------------------------------

test('no skill still tells the agent to poke the socket or hand-build JSON', () => {
  const FORBIDDEN = [
    [/(^|[\s;&|(])nc\s+-/m, 'nc'],
    [/test\s+-[SefdL]\s/, 'a socket/file existence test'],
    [/echo\s+'?\{/, 'JSON built in a shell'],
    [/(^|[\s;&|(])rm\s+-/m, 'rm'],
    [/(^|[\s;&|(])mkdir\s+-p/m, 'mkdir -p'],
    [/(^|[\s;&|(])cat\s+>/m, 'a shell heredoc'],
    [/(^|[\s;&|(])ls\s+-d/m, 'ls -d'],
    [/date\s+\+%s/, 'date +%s'],
    [/curl\s+-[a-zA-Z]/, 'a curl command line'],
    [/\|\s*nc\b/, 'a pipe into nc'],
  ];

  for (const [name, file] of Object.entries(SKILL_PATHS)) {
    const text = read(file);
    for (const [pattern, label] of FORBIDDEN) {
      assert.ok(!pattern.test(text), `skills/${name} still uses ${label}`);
    }
  }
});

test('each skill gives a PowerShell form and never requires Bash on Windows', () => {
  for (const [name, file] of Object.entries(SKILL_PATHS)) {
    const text = read(file);
    assert.match(text, /```powershell/, `skills/${name} must show the PowerShell form`);
    assert.match(text, /\$env:/, `skills/${name} must expand variables the PowerShell way`);
    assert.match(
      text,
      /%LOCALAPPDATA%\\|%USERPROFILE%\\/,
      `skills/${name} must show where things live on Windows`,
    );
    assert.match(text, /~\/\.varie-claude-avatar|\/Applications/, `skills/${name} must keep the macOS paths`);

    // The skills that talk about the application itself must name its location.
    if (name === 'install' || name === 'status') {
      assert.ok(
        text.includes('%LOCALAPPDATA%\\Programs\\Varie Claude Avatar'),
        `skills/${name} must show the Windows installed path`,
      );
    }
  }
});

test('the status skill answers from the daemon, not from a file on disk', () => {
  const text = read(SKILL_PATHS.status);
  assert.match(text, /varie-avatar-hook\.cjs" status/);
  assert.match(text, /RUNNING/);
  assert.match(text, /NOT_RUNNING/);
  assert.match(text, /named pipe/i, 'the Windows endpoint must be described');
  assert.ok(!/test\s+-S/.test(text), 'a socket file outlives a crashed daemon');
});

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

test('the README states the supported platforms and requirements', () => {
  const text = read(README_PATH);

  for (const claim of [
    'Windows 11', 'Windows 10 version 1809', 'Apple Silicon', 'Intel',
    'Node.js 18', '%LOCALAPPDATA%\\Programs\\Varie Claude Avatar',
    'named pipe', 'Unix domain socket', 'SmartScreen', 'NSIS', 'portable',
  ]) {
    assert.ok(text.includes(claim), `the README must document: ${claim}`);
  }

  assert.ok(!/Windows\s*\|\s*Planned/i.test(text), 'Windows is no longer planned');
  assert.ok(!/\bWindows\b[^.\n]{0,30}\bplanned\b/i.test(text), 'no "Windows planned" claim may remain');
  assert.ok(!/(^|[\s;&|(])nc\s+-/m.test(text), 'the README must not tell anyone to use nc');

  // Describing the endpoint in prose is documentation; putting it in a command
  // block is an instruction, and an instruction must run on both platforms.
  for (const block of fencedBlocks(text)) {
    assert.ok(
      !block.includes('/tmp/varie-claude-avatar.sock'),
      'no command block may address the macOS socket directly',
    );
    assert.ok(!/(^|[\s;&|(])nc\s/m.test(block), 'no command block may use nc');
    assert.ok(!/date\s+\+%s/.test(block), 'no command block may build a timestamp with date');
  }
});

test('the README names the artifacts package.json will actually produce', () => {
  const text = read(README_PATH);

  const setup = windowsArtifactName('nsis', '<version>');
  const portable = windowsArtifactName('portable', '<version>');

  assert.ok(text.includes(setup), `the README must name ${setup}`);
  assert.ok(text.includes(portable), `the README must name ${portable}`);
  assert.ok(!text.includes('undefined'), 'no unexpanded macro may reach the README');
});

test('the README describes telemetry and the connections that really happen', () => {
  const text = read(README_PATH);

  assert.match(text, /No telemetry, no analytics, no tracking/i);
  assert.match(text, /GitHub Releases/, 'the installer downloads from GitHub Releases');
  assert.match(text, /Varie/, 'character data comes from Varie');
});

test('Windows v1 limits are documented and match the adapter selection', () => {
  const text = read(README_PATH);

  assert.match(text, /only dismisses the notification/i);
  assert.match(text, /does not focus a terminal/i);
  assert.match(text, /never sends approval input/i);

  // The code must agree: macOS gets the real adapter, everything else the inert one.
  const adapter = read(ADAPTER_PATH);
  const darwinGuard = adapter.indexOf("platform === 'darwin'");
  const macAdapter = adapter.indexOf('new MacOSTerminalActions');
  assert.ok(darwinGuard >= 0, 'the adapter must branch on the platform');
  assert.ok(macAdapter > darwinGuard, 'the macOS adapter must sit behind the darwin guard');
  assert.match(adapter, /return new UnsupportedTerminalActions\(\);/);

  // No document may promise Windows terminal focus or approval.
  for (const [label, file] of [['README', README_PATH], ...Object.entries(SKILL_PATHS).map(
    ([name, skill]) => [`skills/${name}`, skill],
  )]) {
    const document = read(file);
    assert.ok(
      !/Windows[^.\n]{0,80}(focus(es)? the terminal|sends? the approval)/i.test(document),
      `${label} must not claim Windows can drive the terminal`,
    );
  }
});

// ---------------------------------------------------------------------------
// Clean-VM checklist
// ---------------------------------------------------------------------------

const checklist = read(CHECKLIST_PATH);

function checklistSection(startPattern, endPattern) {
  const start = checklist.search(startPattern);
  assert.ok(start >= 0, `section not found: ${startPattern}`);
  const rest = checklist.slice(start);
  const end = rest.slice(1).search(endPattern);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

test('the checklist keeps Windows 10 and Windows 11 in separate sections', () => {
  assert.match(checklist, /^## 3\. Windows 10 version 1809 or newer, x64$/m);
  assert.match(checklist, /^## 4\. Windows 11 x64$/m);

  const win10 = checklistSection(/^## 3\. Windows 10/m, /^## 4\. Windows 11/m);
  const win11 = checklistSection(/^## 4\. Windows 11/m, /^## 5\./m);

  assert.ok(win10.length > 1000 && win11.length > 1000, 'neither section may be a stub');
  assert.ok(!win10.includes('## 4.'), 'the Windows 10 section must end before Windows 11');
});

test('every required acceptance item appears in both VM sections', () => {
  const win10 = checklistSection(/^## 3\. Windows 10/m, /^## 4\. Windows 11/m);
  const win11 = checklistSection(/^## 4\. Windows 11/m, /^## 5\./m);

  const REQUIRED = [
    /Clean install/i,
    /with `\/S`/,
    /%LOCALAPPDATA%\\Programs\\Varie Claude Avatar/,
    /SessionStart hook/,
    /session_start/,
    /session_end/,
    /reload_character/,
    /Two Claude Code sessions/i,
    /transparent/i,
    /always-on-top/i,
    /Drag repositions/i,
    /Scale \*\*S\*\*/,
    /Scale \*\*M\*\*/,
    /Scale \*\*L\*\*/,
    /Minimize/i,
    /Tray → \*\*Show\*\*/,
    /Tray → \*\*Hide\*\*/,
    /Tray → \*\*Quit\*\*/,
    /stats panel/i,
    /bundle downloads/i,
    /loads from cache/i,
    /relaunches it/i,
    /\.installing` lock/,
    /portable `\.exe` runs/i,
    /Uninstall from Settings/i,
    /is \*\*retained\*\*/,
    /SmartScreen/,
    /dismisses it and does nothing else/i,
    /not\*\* focus or raise/i,
    /not\*\* send approval input/i,
    /named pipe exists/i,
  ];

  for (const pattern of REQUIRED) {
    assert.match(win10, pattern, `Windows 10 section is missing ${pattern}`);
    assert.match(win11, pattern, `Windows 11 section is missing ${pattern}`);
  }
});

test('the checklist has its metadata, hash, evidence and outcome sections', () => {
  for (const heading of [
    /^## 1\. Release Candidate Metadata$/m,
    /^## 2\. Artifact SHA-256$/m,
    /^## 5\. Evidence Attached$/m,
    /^## 6\. Anomalies and Outcome$/m,
  ]) {
    assert.match(checklist, heading);
  }

  const evidence = checklistSection(/^## 5\. Evidence Attached/m, /^## 6\./m);
  for (const artefact of ['debug.log', 'hook.log', 'install.log', 'Screenshot', 'SHA-256']) {
    assert.ok(evidence.includes(artefact), `evidence must include ${artefact}`);
  }
  assert.match(evidence, /^### Windows 10$/m);
  assert.match(evidence, /^### Windows 11$/m);

  const hashes = checklistSection(/^## 2\. Artifact SHA-256/m, /^## 3\./m);
  assert.ok(hashes.includes(windowsArtifactName('nsis', '<version>')));
  assert.ok(hashes.includes(windowsArtifactName('portable', '<version>')));
});

test('no checklist box is ticked in advance', () => {
  const ticked = checklist.split('\n').filter((line) => /^\s*-\s*\[[^ \]]\]/.test(line));
  assert.deepEqual(ticked, [], 'a pre-ticked box would claim an unperformed test');

  // The plain ballot boxes used for the free-form fields must be empty too.
  assert.ok(!/[\u2611\u2612\u2713\u2714]/.test(checklist), 'no box may be pre-marked');

  const boxes = checklist.split('\n').filter((line) => /^\s*-\s*\[ \]/.test(line));
  assert.ok(boxes.length > 100, 'the checklist must actually contain the acceptance items');
});

test('the checklist does not claim any automated gate already passed', () => {
  assert.ok(!/\bCI (passed|green)\b/i.test(checklist));
  assert.ok(!/\ball tests pass(ed)?\b/i.test(checklist));
  assert.match(checklist, /Automated gates/i, 'it must say where automated results live instead');
});
