#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getIpcEndpoint } = require('../../shared/ipc-endpoint.cjs');
const { parseHookInput, buildEvent, MAX_STDIN_BYTES } = require('./lib/event.cjs');
const { sendEvent } = require('./lib/transport.cjs');
const {
  ensureDaemon: ensureDaemonLifecycle,
  probeEndpoint,
} = require('./lib/daemon-lifecycle.cjs');

/**
 * Sub-commands that are not hook events.
 *
 * They exist for the plugin skills, which need a real answer rather than a
 * fire-and-forget event: hooks.json never invokes them. Neither reads stdin and
 * neither starts or installs anything.
 */
const COMMANDS = new Set(['status', 'reload-character']);

// A person is waiting for `status`, so it can afford more than the 250 ms a
// hook allows -- but it stays bounded: the skill waits for this process to exit.
const STATUS_PROBE_TIMEOUT_MS = 750;

// The exact tokens the sub-commands print. A skill branches on these, so they
// are part of the contract and must stay stable.
const STATUS_TOKENS = Object.freeze({ RUNNING: 'RUNNING', NOT_RUNNING: 'NOT_RUNNING' });
const RELOAD_TOKENS = Object.freeze({
  SENT: 'RELOAD_SENT',
  FAILED: 'RELOAD_FAILED',
  MISSING_ID: 'MISSING_CHARACTER_ID',
});

// Long option names, mapped to the field each one fills.
const NAMED_OPTIONS = Object.freeze({
  tool: 'tool',
  message: 'message',
  'character-id': 'characterId',
});

/**
 * Appends a diagnostic line to the local hook log.
 *
 * Callers pass an error CODE, never free-form text derived from stdin: the hook
 * payload must never reach the log.
 */
function logWarning(message) {
  try {
    const logDir = path.join(os.homedir(), '.varie-claude-avatar');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'hook.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] [WARN] ${message}\n`);
  } catch {
    // Never throw from the logger.
  }
}

/**
 * Writes one contract token on stdout.
 *
 * Sub-commands print exactly one line and nothing else, so a skill can read the
 * answer without parsing prose.
 */
function defaultPrint(text) {
  process.stdout.write(`${text}\n`);
}

/** Reduces any thrown value to a short, payload-free identifier. */
function errorCode(error) {
  if (!error) return 'unknown';
  return error.code || error.name || 'Error';
}

/**
 * Parses the argument vector.
 *
 * The first positional argument is either a sub-command (`command` names it) or
 * a hook event name; `command` is 'event' for every hook invocation.
 *
 * `--tool` and `--message` remain supported because the deprecated Bash
 * wrappers still forward them; hooks.json passes neither.
 */
function parseArgs(argv = []) {
  const options = {
    command: 'event',
    eventName: 'unknown',
    ensure: false,
    tool: undefined,
    message: undefined,
    characterId: undefined,
  };
  let sawEventName = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') continue;

    if (arg === '--ensure') {
      options.ensure = true;
      continue;
    }

    const named = /^--(tool|message|character-id)(?:=(.*))?$/.exec(arg);
    if (named) {
      const field = NAMED_OPTIONS[named[1]];
      if (named[2] !== undefined) {
        options[field] = named[2];
        continue;
      }

      const next = argv[index + 1];
      // A flag where the character ID should be means the ID was omitted:
      // reload-character must refuse rather than transport a nonsense value and
      // silently swallow the flag. The deprecated --tool/--message wrappers keep
      // their original, more permissive behaviour.
      const consumable = typeof next === 'string'
        && (field !== 'characterId' || !next.startsWith('--'));
      if (consumable) {
        options[field] = next;
        index += 1;
      }
      continue;
    }

    if (!sawEventName && !arg.startsWith('-')) {
      options.eventName = arg;
      sawEventName = true;
      if (COMMANDS.has(arg)) options.command = arg;
    }
  }

  return options;
}

/**
 * Reads the hook payload from a stream, capping it at MAX_STDIN_BYTES.
 *
 * The stream is injectable so the CLI can be tested without a real process.
 * Resolves `{ text, oversize }`; an oversized payload is dropped, never kept.
 */
function readStdin(deps = {}) {
  const stdin = deps.stdin ?? process.stdin;
  const maxBytes = deps.maxStdinBytes ?? MAX_STDIN_BYTES;

  if (stdin.isTTY) return Promise.resolve({ text: '', oversize: false });

  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    let oversize = false;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      resolve({
        text: oversize ? '' : Buffer.concat(chunks).toString('utf8'),
        oversize,
      });
    };

    stdin.on('data', (chunk) => {
      if (oversize) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        oversize = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    });

    stdin.on('end', finish);
    stdin.on('error', finish);
    stdin.on('close', finish);
  });
}

/**
 * Boundary for the cross-platform daemon lifecycle.
 *
 * `--ensure` routes through this seam, which probes the endpoint and, when
 * needed, launches the installed application or hands over to the detached
 * installer. Every collaborator is forwarded so the whole path stays
 * injectable; it resolves to 'running', 'launched' or 'installing' and never
 * throws.
 */
async function ensureDaemon(info = {}) {
  return ensureDaemonLifecycle(info);
}

/**
 * Boundary for the daemon liveness probe.
 *
 * `status` routes through this seam, which opens one short-lived connection to
 * the shared endpoint and releases it. It never launches, installs or writes
 * anything, and it never throws.
 */
async function probeDaemon(endpoint, options = {}) {
  return probeEndpoint(endpoint, options);
}

/**
 * `status` sub-command.
 *
 * Answers whether the daemon is listening on this user's endpoint, using the
 * same bounded probe the lifecycle uses. It reads no stdin, starts nothing,
 * sends no event, and prints exactly one token.
 */
async function runStatus(deps = {}) {
  const endpointFn = deps.getIpcEndpoint ?? getIpcEndpoint;
  const probe = deps.probeDaemon ?? probeDaemon;
  const print = deps.print ?? defaultPrint;
  const log = deps.log ?? logWarning;
  const timeoutMs = deps.probeTimeoutMs ?? STATUS_PROBE_TIMEOUT_MS;

  let running = false;
  try {
    running = await probe(endpointFn(), { timeoutMs });
  } catch (error) {
    // An unreachable daemon and a broken probe are the same answer for a user.
    log(`Status probe failed (${errorCode(error)})`);
    running = false;
  }

  print(running ? STATUS_TOKENS.RUNNING : STATUS_TOKENS.NOT_RUNNING);
  return { command: 'status', running, delivered: false, rejected: false };
}

/**
 * `reload-character --character-id <id>` sub-command.
 *
 * Sends one `reload_character` event carrying the identifier in
 * `metadata.characterId`, which is what the daemon reads. The identifier is
 * transported as data inside a JSON event: it is never interpolated into a
 * command line, a shell or a log message.
 *
 * An empty identifier is refused before anything is opened -- the daemon would
 * silently fall back to the already active character, which is not what the
 * caller asked for. Surrounding whitespace is trimmed because it can only come
 * from a quoting accident; the daemon compares identifiers literally.
 */
async function runReloadCharacter(options = {}, deps = {}) {
  const endpointFn = deps.getIpcEndpoint ?? getIpcEndpoint;
  const buildFn = deps.buildEvent ?? buildEvent;
  const sendFn = deps.sendEvent ?? sendEvent;
  const print = deps.print ?? defaultPrint;
  const log = deps.log ?? logWarning;

  const characterId = typeof options.characterId === 'string' ? options.characterId.trim() : '';

  if (!characterId) {
    log('Refused reload-character without a character id');
    print(RELOAD_TOKENS.MISSING_ID);
    return {
      command: 'reload-character',
      delivered: false,
      rejected: true,
      reason: 'missing_character_id',
    };
  }

  const event = buildFn('reload-character', {}, deps.context ?? {});
  event.metadata = { ...event.metadata, characterId };

  try {
    await sendFn(endpointFn(), event);
  } catch (error) {
    log(`Failed to deliver reload_character (${errorCode(error)})`);
    print(RELOAD_TOKENS.FAILED);
    return { command: 'reload-character', delivered: false, rejected: false };
  }

  print(RELOAD_TOKENS.SENT);
  return { command: 'reload-character', delivered: true, rejected: false };
}

/** Applies the wrapper fallbacks; values coming from stdin always win. */
function applyArgumentFallbacks(hookInput, options) {
  const input = { ...hookInput };
  if (input.tool_name === undefined && typeof options.tool === 'string') {
    input.tool_name = options.tool;
  }
  if (input.message === undefined && typeof options.message === 'string') {
    input.message = options.message;
  }
  return input;
}

/**
 * Hook entry point. Every collaborator is injectable so the CLI is testable
 * without sockets or child processes. Always reports exit code 0: an avatar
 * failure must never block Claude Code.
 */
async function main(deps = {}) {
  const argv = deps.argv ?? process.argv.slice(2);
  const readStdinFn = deps.readStdin ?? readStdin;
  const parseFn = deps.parseHookInput ?? parseHookInput;
  const buildFn = deps.buildEvent ?? buildEvent;
  const sendFn = deps.sendEvent ?? sendEvent;
  const endpointFn = deps.getIpcEndpoint ?? getIpcEndpoint;
  const ensureFn = deps.ensureDaemon ?? ensureDaemon;
  const log = deps.log ?? logWarning;
  const setExitCode = deps.setExitCode ?? ((code) => { process.exitCode = code; });

  const options = parseArgs(argv);

  // Sub-commands answer a question; they never read stdin, so an inherited
  // pipe that is never closed cannot make them hang.
  if (options.command !== 'event') {
    try {
      return options.command === 'status'
        ? await runStatus(deps)
        : await runReloadCharacter(options, deps);
    } finally {
      setExitCode(0);
    }
  }

  try {
    const stdinResult = await readStdinFn(deps);
    const parsed = stdinResult.oversize
      ? { ok: false, reason: 'oversize' }
      : parseFn(stdinResult.text);

    if (!parsed.ok) {
      // No event is invented for refused input, and the payload is not logged.
      log(`Rejected hook input for '${options.eventName}' (${parsed.reason})`);
      return { delivered: false, rejected: true, reason: parsed.reason };
    }

    const endpoint = endpointFn();

    if (options.ensure) {
      try {
        await ensureFn({ eventName: options.eventName, endpoint, log });
      } catch (error) {
        log(`Daemon bootstrap failed for '${options.eventName}' (${errorCode(error)})`);
      }
    }

    const hookInput = applyArgumentFallbacks(parsed.value, options);
    const event = buildFn(options.eventName, hookInput, deps.context ?? {});
    await sendFn(endpoint, event);

    return { delivered: true, rejected: false };
  } catch (error) {
    log(`Failed to deliver hook event '${options.eventName}' (${errorCode(error)})`);
    return { delivered: false, rejected: false };
  } finally {
    setExitCode(0);
  }
}

if (require.main === module) {
  main().finally(() => process.exit(0));
}

module.exports = {
  COMMANDS,
  STATUS_PROBE_TIMEOUT_MS,
  STATUS_TOKENS,
  RELOAD_TOKENS,
  parseArgs,
  readStdin,
  ensureDaemon,
  probeDaemon,
  runStatus,
  runReloadCharacter,
  main,
};
