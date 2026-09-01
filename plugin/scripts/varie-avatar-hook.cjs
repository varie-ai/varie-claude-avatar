#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getIpcEndpoint } = require('../../shared/ipc-endpoint.cjs');
const { parseHookInput, buildEvent, MAX_STDIN_BYTES } = require('./lib/event.cjs');
const { sendEvent } = require('./lib/transport.cjs');

function logError(message) {
  try {
    const logDir = path.join(os.homedir(), '.varie-claude-avatar');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'hook.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] [WARN] ${message}\n`);
  } catch {
    // Never throw from logger
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;

    process.stdin.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_STDIN_BYTES) {
        chunks.push(chunk);
      }
    });

    process.stdin.on('end', () => {
      if (totalBytes > MAX_STDIN_BYTES) {
        resolve('');
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });

    process.stdin.on('error', () => {
      resolve('');
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const eventName = args[0] || 'unknown';
  const endpoint = getIpcEndpoint();

  try {
    const rawStdin = await readStdin();
    const hookInput = parseHookInput(rawStdin);
    const event = buildEvent(eventName, hookInput);
    await sendEvent(endpoint, event);
  } catch (err) {
    logError(`Failed to deliver hook event '${eventName}': ${err.message || err}`);
  }

  // Hooks must always exit 0 so they never block Claude Code
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  readStdin,
  main,
};
