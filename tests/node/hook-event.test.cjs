const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildEvent, parseHookInput, MAX_STDIN_BYTES, MAX_SUMMARY_LENGTH } = require('../../plugin/scripts/lib/event.cjs');

test('Bash summary preserves quotes and collapses whitespace', () => {
  const event = buildEvent('approval-needed', {
    session_id: 's-1',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "hello world"\n&& git push' },
  }, { cwd: 'C:\\work\\avatar', terminal: 'Windows Terminal', now: 42 });

  assert.deepEqual(event, {
    protocolVersion: 1,
    type: 'approval_needed',
    sessionId: 's-1',
    tool: 'Bash',
    timestamp: 42,
    metadata: {
      project: 'avatar',
      projectPath: 'C:\\work\\avatar',
      summary: 'git commit -m "hello world" && git push',
      terminal: 'Windows Terminal',
    },
  });
});

test('Windows Write path returns only the file name', () => {
  const event = buildEvent('approval-needed', {
    session_id: 's-2',
    tool_name: 'Write',
    tool_input: { file_path: 'C:\\repo\\src\\index.ts' },
  }, { cwd: 'C:\\repo', now: 43 });

  assert.equal(event.metadata.summary, 'index.ts');
  assert.equal(event.tool, 'Write');
});

test('POSIX Edit path returns only the file name', () => {
  const event = buildEvent('approval-needed', {
    session_id: 's-2',
    tool_name: 'Edit',
    tool_input: { file_path: '/a/b/c/d/component.tsx' },
  }, { cwd: '/repo', now: 43 });

  assert.equal(event.metadata.summary, 'component.tsx');
  assert.equal(event.tool, 'Edit');
});

test('idle notification maps to attention', () => {
  const event = buildEvent('notification', {
    session_id: 's-3',
    notification_type: 'idle_prompt',
    message: 'Waiting',
  }, { cwd: '/repo', now: 44 });

  assert.equal(event.type, 'attention');
  assert.equal(event.metadata.summary, 'Claude needs attention!');
});

test('ExitPlanMode maps to Plan tool and summary', () => {
  const event = buildEvent('approval-needed', {
    session_id: 's-4',
    tool_name: 'ExitPlanMode',
  }, { cwd: '/repo', now: 45 });

  assert.equal(event.tool, 'Plan');
  assert.equal(event.metadata.summary, 'Plan requires approval');
});

test('SubagentStart with Plan agent type maps to approval_needed', () => {
  const event = buildEvent('subagent-start', {
    session_id: 's-5',
    agent_type: 'Plan',
  }, { cwd: '/repo', now: 46 });

  assert.equal(event.type, 'approval_needed');
  assert.equal(event.tool, 'Plan');
  assert.equal(event.metadata.summary, 'Entering plan mode');
});

test('question event and AskUserQuestion tool map to Question', () => {
  const event1 = buildEvent('question', {
    session_id: 's-6',
  }, { cwd: '/repo', now: 47 });
  assert.equal(event1.type, 'question');
  assert.equal(event1.tool, 'Question');
  assert.equal(event1.metadata.summary, 'Claude has a question for you');

  const event2 = buildEvent('question-complete', {
    session_id: 's-6',
  }, { cwd: '/repo', now: 48 });
  assert.equal(event2.type, 'question_complete');
  assert.equal(event2.tool, 'Question');
  assert.equal(event2.metadata.summary, 'Claude has a question for you');
});

test('plan-complete event maps to Plan tool', () => {
  const event = buildEvent('plan-complete', {
    session_id: 's-7',
  }, { cwd: '/repo', now: 49 });
  assert.equal(event.type, 'plan_complete');
  assert.equal(event.tool, 'Plan');
  assert.equal(event.metadata.summary, 'Plan requires approval');
});

test('command summary longer than 150 chars truncates to 150', () => {
  const longCmd = 'echo ' + 'a'.repeat(200);
  const event = buildEvent('approval-needed', {
    session_id: 's-8',
    tool_name: 'Bash',
    tool_input: { command: longCmd },
  }, { cwd: '/repo', now: 50 });

  assert.equal(event.metadata.summary.length, MAX_SUMMARY_LENGTH);
  assert.equal(event.metadata.summary, longCmd.slice(0, 150));
});

test('command with quoted URL is preserved intact without shell mangling', () => {
  const cmd = 'curl -s "https://varie.ai/api/character-create/public/discover?limit=20"';
  const event = buildEvent('approval-needed', {
    session_id: 's-9',
    tool_name: 'Bash',
    tool_input: { command: cmd },
  }, { cwd: '/repo', now: 51 });

  assert.equal(event.metadata.summary, cmd);
});

test('command with backslashes and pipes preserved', () => {
  const cmd = 'grep -r "pattern" /path/to/dir\\ with\\ spaces | cat > output.log';
  const event = buildEvent('approval-needed', {
    session_id: 's-10',
    tool_name: 'Bash',
    tool_input: { command: cmd },
  }, { cwd: '/repo', now: 52 });

  assert.equal(event.metadata.summary, cmd);
});

test('sessionId fallback hierarchy works correctly', () => {
  // 1. hookInput session_id
  const e1 = buildEvent('session-start', { session_id: 'input-sid' }, { sessionId: 'ctx-sid', env: { CLAUDE_SESSION_ID: 'env-sid' }, pid: 999 });
  assert.equal(e1.sessionId, 'input-sid');

  // 2. context sessionId
  const e2 = buildEvent('session-start', {}, { sessionId: 'ctx-sid', env: { CLAUDE_SESSION_ID: 'env-sid' }, pid: 999 });
  assert.equal(e2.sessionId, 'ctx-sid');

  // 3. env CLAUDE_SESSION_ID
  const e3 = buildEvent('session-start', {}, { env: { CLAUDE_SESSION_ID: 'env-sid' }, pid: 999 });
  assert.equal(e3.sessionId, 'env-sid');

  // 4. pid fallback
  const e4 = buildEvent('session-start', {}, { pid: 999, env: {} });
  assert.equal(e4.sessionId, '999');
});

test('parseHookInput parses valid JSON and handles malformed input gracefully', () => {
  assert.deepEqual(parseHookInput('{"tool_name":"Bash"}'), { tool_name: 'Bash' });
  assert.deepEqual(parseHookInput(''), {});
  assert.deepEqual(parseHookInput('not json'), {});
});

test('parseHookInput rejects input exceeding MAX_STDIN_BYTES (1 MiB)', () => {
  const hugeText = '{"a":"' + 'x'.repeat(MAX_STDIN_BYTES + 10) + '"}';
  assert.deepEqual(parseHookInput(hugeText), {});
});
