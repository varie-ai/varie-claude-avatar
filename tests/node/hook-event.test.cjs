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
      cwd: 'C:\\work\\avatar',
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

test('parseHookInput accepts a JSON object and returns the validated fields', () => {
  const result = parseHookInput('{"session_id":"s","tool_name":"Bash","tool_input":{"command":"ls"}}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    session_id: 's',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
});

test('parseHookInput treats absent stdin as a valid empty object', () => {
  for (const empty of ['', '   ', '\n\t ']) {
    const result = parseHookInput(empty);
    assert.equal(result.ok, true, `${JSON.stringify(empty)} must be accepted`);
    assert.deepEqual(result.value, {});
  }
});

test('parseHookInput rejects malformed JSON distinguishably from an empty object', () => {
  const result = parseHookInput('not json');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'malformed');
  assert.equal(result.value, undefined);

  const emptyObject = parseHookInput('{}');
  assert.equal(emptyObject.ok, true);
  assert.deepEqual(emptyObject.value, {});
});

test('parseHookInput rejects JSON primitives', () => {
  for (const primitive of ['null', 'true', 'false', '42', '"a string"']) {
    const result = parseHookInput(primitive);
    assert.equal(result.ok, false, `${primitive} must be rejected`);
    assert.equal(result.reason, 'not_object', `${primitive} rejection reason`);
  }
});

test('parseHookInput rejects JSON arrays', () => {
  const result = parseHookInput('[{"tool_name":"Bash"}]');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_object');
});

test('parseHookInput rejects non-string input', () => {
  const result = parseHookInput(Buffer.from('{}'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'malformed');
});

test('parseHookInput drops fields that are not strings instead of trusting them', () => {
  const result = parseHookInput(JSON.stringify({
    session_id: 12345,
    tool_name: ['Bash'],
    message: { text: 'hi' },
    notification_type: null,
    agent_type: false,
    tool_input: { command: 99, file_path: '/a/b.ts' },
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { tool_input: { file_path: '/a/b.ts' } });
});

test('parseHookInput drops a tool_input that is not a plain object', () => {
  const arrayInput = parseHookInput('{"tool_name":"Bash","tool_input":["ls"]}');
  assert.equal(arrayInput.ok, true);
  assert.deepEqual(arrayInput.value, { tool_name: 'Bash' });

  const stringInput = parseHookInput('{"tool_name":"Bash","tool_input":"ls"}');
  assert.equal(stringInput.ok, true);
  assert.deepEqual(stringInput.value, { tool_name: 'Bash' });
});

test('parseHookInput accepts exactly MAX_STDIN_BYTES and rejects one byte more', () => {
  const envelope = '{"message":"' + '"}';
  const padding = 'x'.repeat(MAX_STDIN_BYTES - envelope.length);
  const exact = '{"message":"' + padding + '"}';
  assert.equal(Buffer.byteLength(exact, 'utf8'), MAX_STDIN_BYTES);

  const accepted = parseHookInput(exact);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.message.length, padding.length);

  const tooLarge = '{"message":"' + padding + 'x"}';
  assert.equal(Buffer.byteLength(tooLarge, 'utf8'), MAX_STDIN_BYTES + 1);

  const rejected = parseHookInput(tooLarge);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'oversize');
});

test('every Task 3 hook event maps to its wire event type', () => {
  const mapping = [
    ['session-start', 'session_start'],
    ['session-end', 'session_end'],
    ['approval-needed', 'approval_needed'],
    ['question', 'question'],
    ['tool-complete', 'tool_complete'],
    ['plan-complete', 'plan_complete'],
    ['question-complete', 'question_complete'],
    ['subagent-start', 'subagent_start'],
    ['stop', 'stop'],
    ['subagent-stop', 'subagent_stop'],
    ['user-prompt', 'user_prompt'],
    ['notification', 'notification'],
  ];

  for (const [cliEvent, wireType] of mapping) {
    const event = buildEvent(cliEvent, {}, { cwd: '/repo', now: 7, sessionId: 's' });
    assert.equal(event.type, wireType, `${cliEvent} must map to ${wireType}`);
    assert.equal(event.protocolVersion, 1);
    assert.equal(event.timestamp, 7);
  }
});

test('project name is derived from Windows and POSIX working directories', () => {
  const windows = buildEvent('stop', {}, { cwd: 'C:\\Users\\dev\\My Project', now: 1, sessionId: 's' });
  assert.equal(windows.metadata.project, 'My Project');
  assert.equal(windows.metadata.projectPath, 'C:\\Users\\dev\\My Project');

  const windowsUnc = buildEvent('stop', {}, { cwd: '\\\\server\\share\\repo', now: 1, sessionId: 's' });
  assert.equal(windowsUnc.metadata.project, 'repo');

  const posix = buildEvent('stop', {}, { cwd: '/home/dev/my-project', now: 1, sessionId: 's' });
  assert.equal(posix.metadata.project, 'my-project');
  assert.equal(posix.metadata.projectPath, '/home/dev/my-project');

  const posixRoot = buildEvent('stop', {}, { cwd: '/', now: 1, sessionId: 's' });
  assert.equal(posixRoot.metadata.project, 'root');
});

test('buildEvent ignores non-string hook fields when called directly', () => {
  const event = buildEvent('approval-needed', {
    session_id: 42,
    tool_name: 7,
    message: { a: 1 },
  }, { cwd: '/repo', now: 1, sessionId: 'ctx', env: {} });

  assert.equal(event.sessionId, 'ctx');
  assert.equal(event.tool, undefined);
  assert.equal(event.metadata.summary, '');
});

// ---------------------------------------------------------------------------
// F2: the stable session identifiers must leave the client.
//
// `cwd` is the working directory of the session. `projectPath` is the display
// value derived from it and is kept for the renderer and for events emitted by
// older clients. A terminal emulator is the window hosting the session -- not
// the shell running inside it -- so it is reported only when something reliable
// identifies it.
// ---------------------------------------------------------------------------

test('the canonical cwd is emitted beside the legacy projectPath', () => {
  const event = buildEvent('session-start', {}, {
    cwd: 'C:\\work\\my repo', now: 1, env: {}, sessionId: 's',
  });

  assert.equal(event.metadata.cwd, 'C:\\work\\my repo');
  assert.equal(
    event.metadata.projectPath,
    'C:\\work\\my repo',
    'projectPath must stay: the renderer and legacy events still read it',
  );
  assert.equal(event.metadata.project, 'my repo');
});

test('cwd falls back to the process working directory, exactly like projectPath', () => {
  const event = buildEvent('stop', {}, { now: 1, env: {}, sessionId: 's' });

  assert.equal(event.metadata.cwd, process.cwd());
  assert.equal(event.metadata.projectPath, process.cwd());
});

test('an explicit terminal wins over every environment indicator', () => {
  const event = buildEvent('stop', {}, {
    cwd: '/repo', now: 1, sessionId: 's', terminal: 'Ghostty',
    env: { TERM_PROGRAM: 'Apple_Terminal', WT_SESSION: '7b1f0f7c-0b6d-4a2f' },
  });

  assert.equal(event.metadata.terminal, 'Ghostty');
});

test('TERM_PROGRAM identifies the terminal on macOS and POSIX, verbatim', () => {
  for (const reported of ['Apple_Terminal', 'iTerm.app', 'vscode', 'WarpTerminal']) {
    const event = buildEvent('stop', {}, {
      cwd: '/repo', now: 1, sessionId: 's', env: { TERM_PROGRAM: reported },
    });

    assert.equal(event.metadata.terminal, reported, 'the emulator names itself; do not rename it');
  }
});

test('WT_SESSION identifies Windows Terminal without publishing its GUID', () => {
  const guid = '7b1f0f7c-0b6d-4a2f-9a4a-1d0e2c3b4a59';
  const event = buildEvent('stop', {}, {
    cwd: 'C:\\repo', now: 1, sessionId: 's', env: { WT_SESSION: guid },
  });

  assert.equal(event.metadata.terminal, 'Windows Terminal');
  assert.ok(
    !JSON.stringify(event).includes(guid),
    'the session GUID is an indicator, not something to put on the wire',
  );
});

test('a self-reported terminal wins over an indicator that must be interpreted', () => {
  // Running inside Windows Terminal, an integrated terminal still sets
  // TERM_PROGRAM; the innermost host that names itself is the real answer.
  const event = buildEvent('stop', {}, {
    cwd: 'C:\\repo', now: 1, sessionId: 's',
    env: { TERM_PROGRAM: 'vscode', WT_SESSION: '7b1f0f7c-0b6d-4a2f' },
  });

  assert.equal(event.metadata.terminal, 'vscode');
});

test('no terminal is invented when nothing reliable identifies one', () => {
  const cases = [
    {},
    { TERM_PROGRAM: '' },
    { TERM_PROGRAM: '   ' },
    { WT_SESSION: '' },
    { WT_SESSION: '  ' },
    { TERM: 'xterm-256color' },
    { SHELL: '/bin/zsh' },
    { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' },
    { TERM_PROGRAM_VERSION: '1.2.3' },
  ];

  for (const env of cases) {
    const event = buildEvent('stop', {}, { cwd: '/repo', now: 1, sessionId: 's', env });

    assert.ok(
      !('terminal' in event.metadata),
      `${JSON.stringify(env)} must not produce a terminal`,
    );
  }
});

test('a shell is never mistaken for a terminal emulator', () => {
  // ComSpec and SHELL name the command interpreter. Using either would label
  // every cmd.exe session as a terminal it may not be running in.
  const event = buildEvent('stop', {}, {
    cwd: 'C:\\repo', now: 1, sessionId: 's',
    env: {
      ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe',
      SHELL: '/bin/bash',
      WT_SESSION: '7b1f0f7c-0b6d-4a2f',
    },
  });

  assert.equal(event.metadata.terminal, 'Windows Terminal', 'only the emulator indicator counts');
});

test('an unusable explicit terminal falls through instead of shadowing the environment', () => {
  for (const terminal of ['', '   ', '\t\n', 42, null, {}, []]) {
    const event = buildEvent('stop', {}, {
      cwd: '/repo', now: 1, sessionId: 's', terminal,
      env: { TERM_PROGRAM: 'Apple_Terminal' },
    });

    assert.equal(
      event.metadata.terminal,
      'Apple_Terminal',
      `${JSON.stringify(terminal)} must not shadow a real indicator`,
    );
  }
});

test('the session id and protocol version are unaffected by the new metadata', () => {
  const explicit = buildEvent('session-start', { session_id: 's-9' }, {
    cwd: '/repo', now: 1, env: {}, pid: 7,
  });
  assert.equal(explicit.sessionId, 's-9');
  assert.equal(explicit.protocolVersion, 1);

  const fallback = buildEvent('session-start', {}, { cwd: '/repo', now: 1, env: {}, pid: 7 });
  assert.equal(fallback.sessionId, '7');
});
