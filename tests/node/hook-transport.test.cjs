const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const { sendEvent } = require('../../plugin/scripts/lib/transport.cjs');

function getUniqueTestEndpoint() {
  const rand = crypto.randomBytes(4).toString('hex');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\vca-transport-test-${process.pid}-${rand}`;
  }
  return path.join('/tmp', `vca-transport-test-${process.pid}-${rand}.sock`);
}

test('sendEvent appends newline and resolves on ok acknowledgement', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  let receivedData = '';

  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      receivedData += chunk.toString();
      if (receivedData.includes('\n')) {
        socket.write(JSON.stringify({ status: 'ok', received: 'session_start' }) + '\n');
      }
    });
  });

  await new Promise((resolve) => server.listen(endpoint, resolve));

  try {
    const event = { protocolVersion: 1, type: 'session_start', sessionId: 's-1', timestamp: 123, metadata: { project: 'p', projectPath: '/p', summary: 'test' } };
    await sendEvent(endpoint, event, { attempts: 1 });
    assert.equal(receivedData, JSON.stringify(event) + '\n');
  } finally {
    server.close();
  }
});

test('sendEvent rejects with code E_PROTOCOL on unsupported_protocol error and does not retry', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  let serverConnections = 0;

  const server = net.createServer((socket) => {
    serverConnections++;
    socket.on('data', () => {
      socket.write(JSON.stringify({ status: 'error', code: 'unsupported_protocol' }) + '\n');
    });
  });

  await new Promise((resolve) => server.listen(endpoint, resolve));

  try {
    const event = { protocolVersion: 99, type: 'session_start', timestamp: 123, metadata: { project: 'p', projectPath: '/p', summary: 'test' } };
    let caughtErr = null;
    try {
      await sendEvent(endpoint, event, { attempts: 3 });
    } catch (err) {
      caughtErr = err;
    }
    assert.ok(caughtErr, 'Expected sendEvent to reject');
    assert.equal(caughtErr.code, 'E_PROTOCOL');
    assert.equal(serverConnections, 1, 'Should not retry on unsupported protocol');
  } finally {
    server.close();
  }
});

test('sendEvent retries bounded times on connection errors and succeeds', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  let attempts = 0;
  const delays = [];

  const fakeNet = {
    createConnection: () => {
      attempts++;
      const emitter = new (require('node:events').EventEmitter)();
      emitter.setTimeout = () => {};
      emitter.write = () => {};
      emitter.destroy = () => {};
      setImmediate(() => {
        if (attempts < 3) {
          const err = new Error('connect ENOENT');
          err.code = 'ENOENT';
          emitter.emit('error', err);
        } else {
          emitter.emit('connect');
          setImmediate(() => {
            emitter.emit('data', Buffer.from(JSON.stringify({ status: 'ok' }) + '\n'));
          });
        }
      });
      return emitter;
    },
  };

  const event = { protocolVersion: 1, type: 'session_start', timestamp: 123, metadata: { project: 'p', projectPath: '/p', summary: 'test' } };
  await sendEvent(endpoint, event, {
    attempts: 3,
    netModule: fakeNet,
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('sendEvent fails after exhausting max retry attempts', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  let attempts = 0;

  const fakeNet = {
    createConnection: () => {
      attempts++;
      const emitter = new (require('node:events').EventEmitter)();
      emitter.setTimeout = () => {};
      emitter.write = () => {};
      emitter.destroy = () => {};
      setImmediate(() => {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        emitter.emit('error', err);
      });
      return emitter;
    },
  };

  const event = { protocolVersion: 1, type: 'session_start', timestamp: 123, metadata: { project: 'p', projectPath: '/p', summary: 'test' } };
  let caught = null;
  try {
    await sendEvent(endpoint, event, {
      attempts: 3,
      netModule: fakeNet,
      delay: () => Promise.resolve(),
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught);
  assert.equal(caught.code, 'ECONNREFUSED');
  assert.equal(attempts, 3);
});

test('sendEvent times out when acknowledgement is not received', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();

  const fakeNet = {
    createConnection: () => {
      const emitter = new (require('node:events').EventEmitter)();
      let timeoutCb = null;
      emitter.setTimeout = (ms, cb) => {
        timeoutCb = cb;
      };
      emitter.write = () => {
        if (timeoutCb) setImmediate(timeoutCb);
      };
      emitter.destroy = () => {};
      setImmediate(() => emitter.emit('connect'));
      return emitter;
    },
  };

  const event = { protocolVersion: 1, type: 'session_start', timestamp: 123, metadata: { project: 'p', projectPath: '/p', summary: 'test' } };
  let caught = null;
  try {
    await sendEvent(endpoint, event, {
      attempts: 1,
      timeoutMs: 50,
      netModule: fakeNet,
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught);
  assert.match(caught.message, /timed out|timeout/i);
});

// --- Bounded transport guarantees (Task 3 correction) -----------------------

function createEmitterSocket() {
  const emitter = new (require('node:events').EventEmitter)();
  emitter.destroyCount = 0;
  emitter.writes = [];
  emitter.setTimeout = () => {};
  emitter.write = (payload) => { emitter.writes.push(payload); return true; };
  emitter.destroy = () => { emitter.destroyCount += 1; };
  return emitter;
}

// Tracks accepted sockets: a Windows named-pipe server keeps `close()` pending
// until every server-side socket is gone, so tests must release them.
function listen(server, endpoint) {
  const sockets = new Set();
  server.trackedSockets = sockets;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
}

function closeServer(server) {
  for (const socket of server.trackedSockets ?? []) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

const SAMPLE_EVENT = {
  protocolVersion: 1,
  type: 'session_start',
  sessionId: 's-bounded',
  timestamp: 1,
  metadata: { project: 'p', projectPath: '/p', summary: 'test' },
};

test('sendEvent honours an absolute deadline while the peer keeps sending data without a newline', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  const timers = new Set();

  const server = net.createServer((socket) => {
    const drip = setInterval(() => {
      if (socket.writable) socket.write('x');
    }, 10);
    timers.add(drip);
    socket.on('close', () => { clearInterval(drip); timers.delete(drip); });
    socket.on('error', () => { clearInterval(drip); timers.delete(drip); });
  });

  await listen(server, endpoint);

  const startedAt = Date.now();
  let caught = null;
  try {
    await sendEvent(endpoint, SAMPLE_EVENT, { attempts: 1, timeoutMs: 150, totalBudgetMs: 400 });
  } catch (err) {
    caught = err;
  } finally {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    await closeServer(server);
  }

  const elapsed = Date.now() - startedAt;
  assert.ok(caught, 'Expected sendEvent to reject on the absolute deadline');
  assert.equal(caught.code, 'ETIMEDOUT');
  assert.ok(elapsed < 1000, `Expected the deadline to bound the wait, took ${elapsed}ms`);
});

test('sendEvent rejects when the acknowledgement buffer overflows', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  let connections = 0;

  const server = net.createServer((socket) => {
    connections += 1;
    socket.on('data', () => {
      socket.write('x'.repeat(64 * 1024));
    });
    socket.on('error', () => {});
  });

  await listen(server, endpoint);

  let caught = null;
  try {
    await sendEvent(endpoint, SAMPLE_EVENT, { attempts: 3, timeoutMs: 500, totalBudgetMs: 900 });
  } catch (err) {
    caught = err;
  } finally {
    await closeServer(server);
  }

  assert.ok(caught, 'Expected sendEvent to reject on acknowledgement overflow');
  assert.equal(caught.code, 'E_ACK_OVERFLOW');
  assert.equal(connections, 1, 'Overflow must not be retried');
});

test('sendEvent does not retry after the payload was written and no acknowledgement arrives', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  let connections = 0;

  const server = net.createServer((socket) => {
    connections += 1;
    socket.on('error', () => {});
  });

  await listen(server, endpoint);

  let caught = null;
  try {
    await sendEvent(endpoint, SAMPLE_EVENT, { attempts: 3, timeoutMs: 80, totalBudgetMs: 600 });
  } catch (err) {
    caught = err;
  } finally {
    await closeServer(server);
  }

  assert.ok(caught);
  assert.equal(caught.code, 'ETIMEDOUT');
  assert.equal(caught.afterWrite, true);
  assert.equal(connections, 1, 'A written payload must never be resent');
});

test('sendEvent does not retry a malformed acknowledgement', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  let connections = 0;

  const server = net.createServer((socket) => {
    connections += 1;
    socket.on('data', () => socket.write('this is not json\n'));
    socket.on('error', () => {});
  });

  await listen(server, endpoint);

  let caught = null;
  try {
    await sendEvent(endpoint, SAMPLE_EVENT, { attempts: 3, timeoutMs: 500, totalBudgetMs: 900 });
  } catch (err) {
    caught = err;
  } finally {
    await closeServer(server);
  }

  assert.ok(caught);
  assert.equal(caught.code, 'E_ACK_MALFORMED');
  assert.equal(connections, 1);
  assert.ok(!/this is not json/.test(caught.message), 'Error must not echo the acknowledgement body');
});

test('sendEvent does not retry an invalid_event server error', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  let connections = 0;

  const server = net.createServer((socket) => {
    connections += 1;
    socket.on('data', () => socket.write(JSON.stringify({ status: 'error', code: 'invalid_event' }) + '\n'));
    socket.on('error', () => {});
  });

  await listen(server, endpoint);

  let caught = null;
  try {
    await sendEvent(endpoint, SAMPLE_EVENT, { attempts: 3, timeoutMs: 500, totalBudgetMs: 900 });
  } catch (err) {
    caught = err;
  } finally {
    await closeServer(server);
  }

  assert.ok(caught);
  assert.equal(caught.code, 'invalid_event');
  assert.equal(connections, 1);
});

test('sendEvent does not retry a connection closed before acknowledgement', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  let connections = 0;

  const server = net.createServer((socket) => {
    connections += 1;
    socket.on('data', () => socket.destroy());
    socket.on('error', () => {});
  });

  await listen(server, endpoint);

  let caught = null;
  try {
    await sendEvent(endpoint, SAMPLE_EVENT, { attempts: 3, timeoutMs: 500, totalBudgetMs: 900 });
  } catch (err) {
    caught = err;
  } finally {
    await closeServer(server);
  }

  assert.ok(caught);
  assert.equal(connections, 1, 'A closed connection after write must not be retried');
});

test('sendEvent does not retry connection errors outside the transient allow list', async () => {
  let attempts = 0;
  const fakeNet = {
    createConnection: () => {
      attempts += 1;
      const socket = createEmitterSocket();
      setImmediate(() => {
        const err = new Error('permission denied');
        err.code = 'EACCES';
        socket.emit('error', err);
      });
      return socket;
    },
  };

  let caught = null;
  try {
    await sendEvent('endpoint', SAMPLE_EVENT, {
      attempts: 3,
      netModule: fakeNet,
      delay: () => Promise.resolve(),
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught);
  assert.equal(caught.code, 'EACCES');
  assert.equal(attempts, 1, 'Only ENOENT/ECONNREFUSED are transient');
});

test('sendEvent stops retrying once the total wall-clock budget is exhausted', async () => {
  let attempts = 0;
  let clock = 0;

  const fakeNet = {
    createConnection: () => {
      attempts += 1;
      const socket = createEmitterSocket();
      setImmediate(() => {
        const err = new Error('connect ENOENT');
        err.code = 'ENOENT';
        socket.emit('error', err);
      });
      return socket;
    },
  };

  let caught = null;
  try {
    await sendEvent('endpoint', SAMPLE_EVENT, {
      attempts: 5,
      totalBudgetMs: 300,
      retryDelayMs: 100,
      netModule: fakeNet,
      now: () => clock,
      delay: (ms) => { clock += ms; return Promise.resolve(); },
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught);
  assert.equal(caught.code, 'ENOENT');
  assert.equal(attempts, 2, 'The budget must cut the retry sequence short');
});

test('sendEvent destroys the socket and clears the deadline timer exactly once', async () => {
  const cleared = [];
  const created = [];
  let socketRef = null;

  const fakeTimers = {
    setTimeout: (fn, ms) => {
      const handle = { fn, ms };
      created.push(handle);
      return handle;
    },
    clearTimeout: (handle) => { cleared.push(handle); },
  };

  const fakeNet = {
    createConnection: () => {
      socketRef = createEmitterSocket();
      setImmediate(() => {
        socketRef.emit('connect');
        setImmediate(() => {
          socketRef.emit('data', Buffer.from(JSON.stringify({ status: 'ok' }) + '\n'));
          // Late noise from the same attempt must not re-settle or re-destroy.
          socketRef.emit('data', Buffer.from('garbage\n'));
          socketRef.emit('error', new Error('late error'));
          socketRef.emit('close');
        });
      });
      return socketRef;
    },
  };

  await sendEvent('endpoint', SAMPLE_EVENT, {
    attempts: 1,
    netModule: fakeNet,
    timers: fakeTimers,
  });

  assert.equal(created.length, 1, 'exactly one deadline timer per attempt');
  assert.deepEqual(cleared, created, 'the deadline timer must be cleared');
  assert.equal(socketRef.destroyCount, 1, 'cleanup must be idempotent');
  assert.equal(socketRef.listenerCount('data'), 0, 'listeners must be removed');
  assert.equal(socketRef.listenerCount('connect'), 0, 'listeners must be removed');
});

test('sendEvent rejects unserializable events without opening a connection', async () => {
  let connections = 0;
  const fakeNet = { createConnection: () => { connections += 1; return createEmitterSocket(); } };

  const circular = { protocolVersion: 1, type: 'stop', timestamp: 1, metadata: {} };
  circular.metadata.self = circular;

  let caught = null;
  try {
    await sendEvent('endpoint', circular, { attempts: 3, netModule: fakeNet, delay: () => Promise.resolve() });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught);
  assert.equal(caught.code, 'E_SERIALIZE');
  assert.equal(connections, 0, 'Serialization must fail before any socket is created');
});

test('a normal hook delivery stays under one second when the daemon never acknowledges', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  const server = net.createServer((socket) => { socket.on('error', () => {}); });
  await listen(server, endpoint);

  const startedAt = Date.now();
  let caught = null;
  try {
    await sendEvent(endpoint, SAMPLE_EVENT);
  } catch (err) {
    caught = err;
  } finally {
    await closeServer(server);
  }

  const elapsed = Date.now() - startedAt;
  assert.ok(caught, 'Expected a rejection');
  assert.ok(elapsed < 1000, `Default transport budget must stay under 1s, took ${elapsed}ms`);
});

test('a missing endpoint exhausts bounded retries in under one second', { timeout: 5000 }, async () => {
  const endpoint = getUniqueTestEndpoint();
  const startedAt = Date.now();

  let caught = null;
  try {
    await sendEvent(endpoint, SAMPLE_EVENT);
  } catch (err) {
    caught = err;
  }

  const elapsed = Date.now() - startedAt;
  assert.ok(caught, 'Expected a rejection for a missing endpoint');
  assert.ok(elapsed < 1000, `Retry sequence must stay under 1s, took ${elapsed}ms`);
});
