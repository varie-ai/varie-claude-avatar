const net = require('node:net');

function sendOnce(endpoint, event, timeoutMs, netModule = net) {
  return new Promise((resolve, reject) => {
    let socket = null;
    let buffer = '';
    let settled = false;

    const cleanup = () => {
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
        socket = null;
      }
    };

    const safeReject = (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };

    const safeResolve = () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve();
      }
    };

    try {
      socket = netModule.createConnection(endpoint);

      socket.setTimeout(timeoutMs, () => {
        const err = new Error(`Transport acknowledgement timed out after ${timeoutMs}ms`);
        err.code = 'ETIMEDOUT';
        safeReject(err);
      });

      socket.on('error', (err) => {
        safeReject(err);
      });

      socket.on('connect', () => {
        try {
          const payload = JSON.stringify(event) + '\n';
          socket.write(payload);
        } catch (err) {
          safeReject(err);
        }
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\n')) {
          const line = buffer.split('\n')[0].trim();
          try {
            const resp = JSON.parse(line);
            if (resp.status === 'ok') {
              safeResolve();
            } else if (resp.status === 'error' && resp.code === 'unsupported_protocol') {
              const err = new Error('Unsupported protocol version');
              err.code = 'E_PROTOCOL';
              safeReject(err);
            } else {
              const err = new Error(resp.message || resp.code || 'Server returned error');
              err.code = resp.code || 'E_SERVER_ERROR';
              safeReject(err);
            }
          } catch (err) {
            safeReject(err);
          }
        }
      });
    } catch (err) {
      safeReject(err);
    }
  });
}

async function sendEvent(endpoint, event, options = {}) {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 750;
  const delay = options.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const netModule = options.netModule ?? net;

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await sendOnce(endpoint, event, timeoutMs, netModule);
      return;
    } catch (error) {
      lastError = error;
      if (error && error.code === 'E_PROTOCOL') {
        throw error;
      }
      if (attempt + 1 < attempts) {
        await delay(100 * (attempt + 1));
      }
    }
  }

  throw lastError || new Error('Failed to send event');
}

module.exports = {
  sendOnce,
  sendEvent,
};
