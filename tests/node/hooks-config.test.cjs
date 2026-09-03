const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildEvent } = require('../../plugin/scripts/lib/event.cjs');

const HOOKS_PATH = path.join(__dirname, '..', '..', 'plugin', 'hooks', 'hooks.json');
const HOOK_SCRIPT_ARG = '${CLAUDE_PLUGIN_ROOT}/scripts/varie-avatar-hook.cjs';

// Claude Code hook timeouts are expressed in SECONDS.
const SESSION_START_TIMEOUT_SECONDS = 5;
const DEFAULT_TIMEOUT_SECONDS = 1;

// Every handler that must exist in hooks.json, in file order, with the CLI
// event argument it has to pass and the wire event type the daemon receives.
const EXPECTED_HANDLERS = [
  { event: 'SessionStart', matcher: undefined, cliEvent: 'session-start', ensure: true, wireType: 'session_start' },
  { event: 'SessionEnd', matcher: undefined, cliEvent: 'session-end', ensure: false, wireType: 'session_end' },
  { event: 'PreToolUse', matcher: 'Bash|Write|Edit', cliEvent: 'approval-needed', ensure: false, wireType: 'approval_needed' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion', cliEvent: 'question', ensure: false, wireType: 'question' },
  { event: 'PostToolUse', matcher: 'Bash|Write|Edit', cliEvent: 'tool-complete', ensure: false, wireType: 'tool_complete' },
  { event: 'PostToolUse', matcher: 'ExitPlanMode', cliEvent: 'plan-complete', ensure: false, wireType: 'plan_complete' },
  { event: 'PostToolUse', matcher: 'AskUserQuestion', cliEvent: 'question-complete', ensure: false, wireType: 'question_complete' },
  { event: 'PermissionRequest', matcher: 'ExitPlanMode', cliEvent: 'approval-needed', ensure: false, wireType: 'approval_needed' },
  { event: 'SubagentStart', matcher: undefined, cliEvent: 'subagent-start', ensure: false, wireType: 'subagent_start' },
  { event: 'Stop', matcher: undefined, cliEvent: 'stop', ensure: false, wireType: 'stop' },
  { event: 'SubagentStop', matcher: undefined, cliEvent: 'subagent-stop', ensure: false, wireType: 'subagent_stop' },
  { event: 'UserPromptSubmit', matcher: undefined, cliEvent: 'user-prompt', ensure: false, wireType: 'user_prompt' },
  { event: 'Notification', matcher: 'idle_prompt', cliEvent: 'notification', ensure: false, wireType: 'notification' },
];

const LEGACY_WRAPPERS = ['varie-avatar-notify', 'ensure-daemon-running', 'install-daemon', 'extract_summary.py'];
const SHELL_METACHARACTERS = ['&&', '||', '|', '>', '<', ';', '`', '$(', '\n'];

function readRaw() {
  return fs.readFileSync(HOOKS_PATH, 'utf8');
}

/** Flattens hooks.json into the ordered list of concrete command handlers. */
function enumerateHandlers(config) {
  const handlers = [];
  for (const [event, groups] of Object.entries(config.hooks)) {
    assert.ok(Array.isArray(groups), `${event} must hold an array of matcher groups`);
    for (const group of groups) {
      assert.ok(Array.isArray(group.hooks), `${event} group must hold a hooks array`);
      for (const handler of group.hooks) {
        handlers.push({ event, matcher: group.matcher, handler });
      }
    }
  }
  return handlers;
}

test('hooks.json is valid JSON with a hooks object', () => {
  const config = JSON.parse(readRaw());
  assert.equal(typeof config.hooks, 'object');
  assert.ok(config.hooks !== null && !Array.isArray(config.hooks));
});

test('hooks.json declares exactly the expected handlers in order', () => {
  const handlers = enumerateHandlers(JSON.parse(readRaw()));
  assert.equal(handlers.length, EXPECTED_HANDLERS.length,
    `expected ${EXPECTED_HANDLERS.length} handlers, found ${handlers.length}`);

  handlers.forEach((entry, index) => {
    const expected = EXPECTED_HANDLERS[index];
    assert.equal(entry.event, expected.event, `handler ${index} event`);
    assert.equal(entry.matcher, expected.matcher, `handler ${index} matcher`);
  });
});

test('every handler uses exec form with the literal CLAUDE_PLUGIN_ROOT placeholder', () => {
  const handlers = enumerateHandlers(JSON.parse(readRaw()));

  handlers.forEach((entry, index) => {
    const expected = EXPECTED_HANDLERS[index];
    const { handler } = entry;
    const label = `${entry.event}[${expected.matcher ?? '*'}]`;

    assert.equal(handler.type, 'command', `${label} type`);
    assert.equal(handler.command, 'node', `${label} command`);
    assert.ok(Array.isArray(handler.args), `${label} must use an args array`);
    assert.equal(handler.args[0], HOOK_SCRIPT_ARG,
      `${label} args[0] must be the literal placeholder path, got ${JSON.stringify(handler.args[0])}`);
    assert.equal(handler.args[1], expected.cliEvent, `${label} CLI event argument`);

    const expectedArgs = [HOOK_SCRIPT_ARG, expected.cliEvent];
    if (expected.ensure) expectedArgs.push('--ensure');
    assert.deepEqual(handler.args, expectedArgs, `${label} full argument vector`);

    assert.equal(handler.shell, undefined, `${label} must not request a shell`);
  });
});

test('SessionStart waits 5 seconds and every other handler waits 1 second', () => {
  const handlers = enumerateHandlers(JSON.parse(readRaw()));

  handlers.forEach((entry, index) => {
    const expected = EXPECTED_HANDLERS[index];
    const label = `${entry.event}[${expected.matcher ?? '*'}]`;
    const expectedTimeout = entry.event === 'SessionStart'
      ? SESSION_START_TIMEOUT_SECONDS
      : DEFAULT_TIMEOUT_SECONDS;
    assert.equal(entry.handler.timeout, expectedTimeout,
      `${label} timeout must be ${expectedTimeout} seconds`);
  });
});

test('hooks.json references no legacy wrapper script', () => {
  const raw = readRaw();
  for (const wrapper of LEGACY_WRAPPERS) {
    assert.ok(!raw.includes(wrapper), `hooks.json must not reference ${wrapper}`);
  }
});

test('hooks.json contains no shell interpolation or shell metacharacters', () => {
  const handlers = enumerateHandlers(JSON.parse(readRaw()));

  for (const { event, handler } of handlers) {
    const strings = [handler.command, ...(handler.args ?? [])];
    for (const value of strings) {
      assert.equal(typeof value, 'string', `${event} argument must be a string`);
      assert.ok(!value.includes('$TOOL_NAME'), `${event} must not interpolate $TOOL_NAME`);
      assert.ok(!value.includes('$MESSAGE'), `${event} must not interpolate $MESSAGE`);
      for (const meta of SHELL_METACHARACTERS) {
        assert.ok(!value.includes(meta),
          `${event} argument ${JSON.stringify(value)} must not contain ${JSON.stringify(meta)}`);
      }
    }
  }
});

test('only session-start requests daemon bootstrap with --ensure', () => {
  const handlers = enumerateHandlers(JSON.parse(readRaw()));

  handlers.forEach((entry, index) => {
    const expected = EXPECTED_HANDLERS[index];
    const hasEnsure = entry.handler.args.includes('--ensure');
    assert.equal(hasEnsure, expected.ensure,
      `${entry.event} --ensure presence must be ${expected.ensure}`);
  });
});

test('each declared CLI event maps to the expected wire event type', () => {
  const handlers = enumerateHandlers(JSON.parse(readRaw()));

  handlers.forEach((entry, index) => {
    const expected = EXPECTED_HANDLERS[index];
    const event = buildEvent(entry.handler.args[1], {}, { cwd: '/repo', now: 1 });
    assert.equal(event.type, expected.wireType,
      `${expected.cliEvent} must map to ${expected.wireType}`);
    assert.equal(event.protocolVersion, 1);
  });
});
