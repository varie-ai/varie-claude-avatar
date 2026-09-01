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
