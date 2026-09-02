#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getIpcEndpoint } = require('../../shared/ipc-endpoint.cjs');
const { parseHookInput, buildEvent, MAX_STDIN_BYTES } = require('./lib/event.cjs');
const { sendEvent } = require('./lib/transport.cjs');

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

/** Reduces any thrown value to a short, payload-free identifier. */
function errorCode(error) {
  if (!error) return 'unknown';
  return error.code || error.name || 'Error';
}

/**
 * Parses the hook argument vector.
 *
 * `--tool` and `--message` remain supported because the deprecated Bash
 * wrappers still forward them; hooks.json passes neither.
 */
function parseArgs(argv = []) {
  const options = { eventName: 'unknown', ensure: false, tool: undefined, message: undefined };
  let sawEventName = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') continue;

    if (arg === '--ensure') {
      options.ensure = true;
      continue;
    }

    const named = /^--(tool|message)(?:=(.*))?$/.exec(arg);
    if (named) {
      if (named[2] !== undefined) {
        options[named[1]] = named[2];
      } else if (typeof argv[index + 1] === 'string') {
        options[named[1]] = argv[index + 1];
        index += 1;
      }
      continue;
    }

    if (!sawEventName && !arg.startsWith('-')) {
      options.eventName = arg;
      sawEventName = true;
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
 * Task 3 only recognizes `--ensure` and routes it through this seam. Probing,
 * launching and installing the daemon are Task 4 work and are deliberately NOT
 * implemented here; this placeholder performs no I/O and never blocks a hook.
 */
async function ensureDaemon() {
  return { ensured: false, reason: 'not_implemented' };
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

    if (options.ensure) {
      try {
        await ensureFn({ eventName: options.eventName });
      } catch (error) {
        log(`Daemon bootstrap failed for '${options.eventName}' (${errorCode(error)})`);
      }
    }

    const hookInput = applyArgumentFallbacks(parsed.value, options);
    const event = buildFn(options.eventName, hookInput, deps.context ?? {});
    await sendFn(endpointFn(), event);

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
  parseArgs,
  readStdin,
  ensureDaemon,
  main,
};
