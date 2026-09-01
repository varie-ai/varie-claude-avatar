const path = require('node:path');

const MAX_STDIN_BYTES = 1024 * 1024; // 1 MiB
const MAX_SUMMARY_LENGTH = 150;

function parseHookInput(text) {
  if (typeof text !== 'string') return {};
  if (Buffer.byteLength(text, 'utf8') > MAX_STDIN_BYTES) return {};
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
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
  const now = context.now ?? Date.now();
  const cwd = context.cwd ?? process.cwd();
  const projectPath = cwd;
  const project = extractFileBasename(projectPath) || 'root';
  const terminal = context.terminal ?? undefined;
  const env = context.env ?? process.env;

  const sessionId =
    hookInput.session_id ||
    context.sessionId ||
    env.CLAUDE_SESSION_ID ||
    (context.pid !== undefined ? String(context.pid) : String(process.pid));

  let eventType = (eventName || 'unknown').replaceAll('-', '_');
  let tool = hookInput.tool_name || context.tool || undefined;
  let summary = '';

  if (typeof hookInput.message === 'string') {
    summary = hookInput.message;
  }

  if (tool === 'Bash') {
    const cmd = hookInput.tool_input && typeof hookInput.tool_input === 'object'
      ? hookInput.tool_input.command
      : undefined;
    summary = normalizeCommand(cmd);
  } else if (tool === 'Write' || tool === 'Edit') {
    const fp = hookInput.tool_input && typeof hookInput.tool_input === 'object'
      ? hookInput.tool_input.file_path
      : undefined;
    summary = extractFileBasename(fp);
  } else if (tool === 'ExitPlanMode') {
    tool = 'Plan';
    summary = 'Plan requires approval';
  }

  if (eventType === 'subagent_start' && hookInput.agent_type === 'Plan') {
    eventType = 'approval_needed';
    tool = 'Plan';
    summary = 'Entering plan mode';
  }

  if (eventType === 'notification' && hookInput.notification_type === 'idle_prompt') {
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
    summary: (summary || '').slice(0, MAX_SUMMARY_LENGTH),
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
  parseHookInput,
  buildEvent,
};
