const net = require('node:net');

const DEFAULT_ATTEMPTS = 3;

// Absolute wall-clock deadline for a single attempt. It is armed once, before
// the connection is opened, and is never rearmed by socket activity.
const DEFAULT_ACK_TIMEOUT_MS = 750;

// Hard ceiling for the whole sendEvent call, retries and back-off included, so
// a 1-second Claude Code hook timeout is never reached.
const DEFAULT_TOTAL_BUDGET_MS = 900;

const DEFAULT_RETRY_DELAY_MS = 100;

// An acknowledgement is a single short JSON line. Anything larger is a broken
// or hostile peer, not a daemon.
const MAX_ACK_BYTES = 4096;

// Transient failures to OPEN the connection. They can only happen before the
// payload is written, so retrying them cannot duplicate an event.
const RETRYABLE_CONNECT_CODES = new Set(['ENOENT', 'ECONNREFUSED']);

// The only daemon error codes this client is willing to surface. An
// acknowledgement is untrusted input: anything outside this closed set becomes
// E_SERVER_ERROR so a peer cannot inject text or newlines into an error or a log.
const SAFE_DAEMON_CODES = new Set([
  'invalid_json',
  'invalid_event',
  'message_too_large',
  'internal_error',
]);

const DEFAULT_TIMERS = { setTimeout, clearTimeout };

/**
 * Only a transient connection-open failure is worth retrying. Once the payload
 * has been written the daemon may already have processed it, so a timeout, a
 * closed connection, a malformed acknowledgement or a server error must fail
 * the delivery instead of duplicating the event.
 */
function isRetryableConnectError(error) {
  if (!error || error.afterWrite === true) return false;
  return RETRYABLE_CONNECT_CODES.has(error.code);
}

function transportError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Performs exactly one delivery attempt: connect, write one newline-delimited
 * event, wait for the acknowledgement line, then release every resource.
 */
function sendOnce(endpoint, event, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const netModule = options.netModule ?? net;
  const timers = options.timers ?? DEFAULT_TIMERS;
  const maxAckBytes = options.maxAckBytes ?? MAX_ACK_BYTES;

  return new Promise((resolve, reject) => {
    let payload;
    try {
      payload = JSON.stringify(event) + '\n';
    } catch {
      reject(transportError('Event could not be serialized', 'E_SERIALIZE'));
      return;
    }

    let socket = null;
    let deadline = null;
    let settled = false;
    let cleaned = false;
    let wrotePayload = false;
    let ackBytes = 0;
    let ackBuffer = '';

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;

      if (deadline !== null) {
        timers.clearTimeout(deadline);
        deadline = null;
      }

      const target = socket;
      socket = null;
      if (target) {
        target.removeAllListeners();
        // Keep a sink listener so a late error from destroy() cannot escape as
        // an unhandled 'error' event.
        target.on('error', () => {});
        target.destroy();
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (wrotePayload) error.afterWrite = true;
      cleanup();
      reject(error);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    deadline = timers.setTimeout(() => {
      fail(transportError(`Transport acknowledgement timed out after ${timeoutMs}ms`, 'ETIMEDOUT'));
    }, timeoutMs);

    try {
      socket = netModule.createConnection(endpoint);
    } catch (error) {
      fail(error);
      return;
    }

    socket.on('error', (error) => {
      fail(error);
    });

    socket.on('close', () => {
      fail(transportError('Transport connection closed before acknowledgement', 'E_CLOSED'));
    });

    socket.on('connect', () => {
      try {
        // Marked BEFORE the call: once write() is entered the daemon may
        // already have received the payload, so even a synchronous transient
        // failure must not be retried.
        wrotePayload = true;
        socket.write(payload);
      } catch (error) {
        if (!error.code) error.code = 'E_WRITE';
        fail(error);
      }
    });

    socket.on('data', (chunk) => {
      if (settled) return;

      ackBytes += chunk.length;
      if (ackBytes > maxAckBytes) {
        fail(transportError(
          `Acknowledgement exceeded ${maxAckBytes} bytes`,
          'E_ACK_OVERFLOW',
        ));
        return;
      }

      ackBuffer += chunk.toString('utf8');
      const newlineIndex = ackBuffer.indexOf('\n');
      if (newlineIndex === -1) return;

      const line = ackBuffer.slice(0, newlineIndex).trim();

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        // Deliberately does not echo the line: acknowledgement bodies never
        // reach an error message or a log.
        fail(transportError('Acknowledgement was not valid JSON', 'E_ACK_MALFORMED'));
        return;
      }

      if (typeof response !== 'object' || response === null || Array.isArray(response)) {
        fail(transportError('Acknowledgement was not a JSON object', 'E_ACK_MALFORMED'));
        return;
      }

      if (response.status === 'ok') {
        succeed();
        return;
      }

      if (response.status !== 'error') {
        fail(transportError('Acknowledgement carried an unrecognized status', 'E_ACK_MALFORMED'));
        return;
      }

      if (response.code === 'unsupported_protocol') {
        fail(transportError('Unsupported protocol version', 'E_PROTOCOL'));
        return;
      }

      // Only a code from the closed set is echoed; it is one of our own
      // literals, never the raw acknowledgement value.
      if (typeof response.code === 'string' && SAFE_DAEMON_CODES.has(response.code)) {
        fail(transportError(`Daemon rejected the event (${response.code})`, response.code));
        return;
      }

      fail(transportError('Daemon rejected the event', 'E_SERVER_ERROR'));
    });
  });
}

/**
 * Sends one event with bounded retries and a bounded total wall-clock cost.
 */
async function sendEvent(endpoint, event, options = {}) {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const totalBudgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const delay = options.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const netModule = options.netModule ?? net;
  const timers = options.timers ?? DEFAULT_TIMERS;
  const now = options.now ?? Date.now;

  const budgetEnd = now() + totalBudgetMs;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remaining = budgetEnd - now();
    if (remaining <= 0) break;

    try {
      await sendOnce(endpoint, event, {
        timeoutMs: Math.min(timeoutMs, remaining),
        netModule,
        timers,
        maxAckBytes: options.maxAckBytes,
      });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableConnectError(error)) throw error;
      if (attempt + 1 >= attempts) break;

      const backoffMs = retryDelayMs * (attempt + 1);
      if (now() + backoffMs >= budgetEnd) break;
      await delay(backoffMs);
    }
  }

  throw lastError || transportError('Failed to send event', 'E_NO_ATTEMPT');
}

module.exports = {
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_TOTAL_BUDGET_MS,
  MAX_ACK_BYTES,
  isRetryableConnectError,
  sendOnce,
  sendEvent,
};
