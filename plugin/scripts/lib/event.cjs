const MAX_STDIN_BYTES = 1024 * 1024; // 1 MiB
const MAX_SUMMARY_LENGTH = 150;

/**
 * Reasons `parseHookInput` refuses stdin. A rejection is always
 * `{ ok: false, reason }` and therefore distinguishable from the valid but
 * empty payload `{ ok: true, value: {} }`.
 */
const REJECTION_REASONS = Object.freeze({
  OVERSIZE: 'oversize',
  MALFORMED: 'malformed',
  NOT_OBJECT: 'not_object',
});

// Top-level hook fields the client actually consumes. Anything else in the
// payload is dropped so it can never reach an event, a log, or the daemon.
const STRING_FIELDS = ['session_id', 'tool_name', 'message', 'notification_type', 'agent_type'];

// Values read out of `tool_input`, validated as strings.
const TOOL_INPUT_STRING_FIELDS = ['command', 'file_path'];

/**
 * Environment variables that identify the terminal emulator hosting a session:
 * the window, never the shell running inside it.
 *
 * TERM_PROGRAM is set by the emulator itself and already carries its name, so
 * it is reported verbatim and comes first: an integrated terminal running
 * inside another one is the innermost host, and it is the one that names
 * itself. WT_SESSION only proves Windows Terminal is present -- its value is a
 * session GUID -- so the name is a constant and the GUID never reaches the wire.
 *
 * Deliberately excluded: ComSpec and SHELL name a command interpreter, and TERM
 * describes terminfo capabilities. Neither identifies an emulator.
 */
const TERMINAL_INDICATORS = Object.freeze([
  { variable: 'TERM_PROGRAM', name: (value) => value },
  { variable: 'WT_SESSION', name: () => 'Windows Terminal' },
]);

/** A stable identifier is usable only when it is a string with content. */
function usableString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Identifies the terminal emulator, or nothing at all.
 *
 * Precedence: an explicit value from the caller, then the first reliable
 * environment indicator, then undefined. A terminal is never invented, and an
 * unusable explicit value falls through instead of hiding a real indicator.
 */
function resolveTerminal(explicit, env) {
  const provided = usableString(explicit);
  if (provided !== undefined) return provided;

  const source = isPlainObject(env) ? env : {};
  for (const indicator of TERMINAL_INDICATORS) {
    const raw = usableString(source[indicator.variable]);
    if (raw !== undefined) return indicator.name(raw);
  }

  return undefined;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value) {
  return typeof value === 'string' ? value : undefined;
}

function reject(reason) {
  return { ok: false, reason };
}

/** Keeps only the whitelisted fields, and only when they are strings. */
function validateHookInput(parsed) {
  const value = {};

  for (const field of STRING_FIELDS) {
    const candidate = asString(parsed[field]);
    if (candidate !== undefined) value[field] = candidate;
  }

  if (isPlainObject(parsed.tool_input)) {
    const toolInput = {};
    for (const field of TOOL_INPUT_STRING_FIELDS) {
      const candidate = asString(parsed.tool_input[field]);
      if (candidate !== undefined) toolInput[field] = candidate;
    }
    if (Object.keys(toolInput).length > 0) value.tool_input = toolInput;
  }

  return { ok: true, value };
}

/**
 * Parses Claude Code hook stdin.
 *
 * Returns `{ ok: true, value }` only for a JSON object (arrays and primitives
 * are refused) that fits in MAX_STDIN_BYTES, or for absent stdin, which is a
 * valid empty payload. Otherwise returns `{ ok: false, reason }`.
 */
function parseHookInput(text) {
  if (typeof text !== 'string') return reject(REJECTION_REASONS.MALFORMED);
  if (Buffer.byteLength(text, 'utf8') > MAX_STDIN_BYTES) return reject(REJECTION_REASONS.OVERSIZE);
  if (!text.trim()) return { ok: true, value: {} };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reject(REJECTION_REASONS.MALFORMED);
  }

  if (!isPlainObject(parsed)) return reject(REJECTION_REASONS.NOT_OBJECT);

  return validateHookInput(parsed);
}

function extractFileBasename(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return '';
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

function normalizeCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return '';
  return command.trim().replace(/\s+/g, ' ').slice(0, MAX_SUMMARY_LENGTH);
}

function buildEvent(eventName, hookInput = {}, context = {}) {
  const input = isPlainObject(hookInput) ? hookInput : {};
  const now = context.now ?? Date.now();
  const cwd = context.cwd ?? process.cwd();
  const projectPath = cwd;
  const project = extractFileBasename(projectPath) || 'root';
  const env = context.env ?? process.env;
  const terminal = resolveTerminal(context.terminal, env);

  const sessionId =
    asString(input.session_id) ||
    context.sessionId ||
    env.CLAUDE_SESSION_ID ||
    (context.pid !== undefined ? String(context.pid) : String(process.pid));

  let eventType = (eventName || 'unknown').replaceAll('-', '_');
  let tool = asString(input.tool_name) || context.tool || undefined;
  let summary = asString(input.message) || '';

  const toolInput = isPlainObject(input.tool_input) ? input.tool_input : {};

  if (tool === 'Bash') {
    summary = normalizeCommand(toolInput.command);
  } else if (tool === 'Write' || tool === 'Edit') {
    summary = extractFileBasename(toolInput.file_path);
  } else if (tool === 'ExitPlanMode') {
    tool = 'Plan';
    summary = 'Plan requires approval';
  }

  if (eventType === 'subagent_start' && input.agent_type === 'Plan') {
    eventType = 'approval_needed';
    tool = 'Plan';
    summary = 'Entering plan mode';
  }

  if (eventType === 'notification' && input.notification_type === 'idle_prompt') {
    eventType = 'attention';
    summary = 'Claude needs attention!';
  }

  if (eventType === 'question') {
    tool = 'Question';
    summary = 'Claude has a question for you';
  } else if (eventType === 'plan_complete') {
    tool = 'Plan';
    summary = 'Plan requires approval';
  } else if (eventType === 'question_complete') {
    tool = 'Question';
    summary = 'Claude has a question for you';
  }

  const metadata = {
    project,
    projectPath,
    // The canonical working directory of the session. projectPath carries the
    // same value and stays: the renderer reads it, and so do events emitted by
    // clients older than this release.
    cwd,
    summary: summary.slice(0, MAX_SUMMARY_LENGTH),
  };
  if (terminal !== undefined) {
    metadata.terminal = terminal;
  }

  const event = {
    protocolVersion: 1,
    type: eventType,
    sessionId,
    timestamp: now,
    metadata,
  };
  if (tool !== undefined) {
    event.tool = tool;
  }

  return event;
}

module.exports = {
  MAX_STDIN_BYTES,
  MAX_SUMMARY_LENGTH,
  REJECTION_REASONS,
  parseHookInput,
  buildEvent,
};
