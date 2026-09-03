const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const esbuild = require('../../daemon/node_modules/esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socket-server-test-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

let SocketServer;
try {
  const outFile = path.join(tempDir, 'socket-server.js');
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../../daemon/src/main/socket-server.ts')],
    bundle: true,
    platform: 'node',
    external: ['electron'],
    outfile: outFile,
    format: 'cjs',
  });
  SocketServer = require(outFile).SocketServer;
} catch (e) {
  fs.rmSync(tempDir, { recursive: true, force: true });
  throw e;
}

function getUniqueTestEndpoint() {
  const rand = crypto.randomBytes(4).toString('hex');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\vca-test-${process.pid}-${rand}`;
  }
  return path.join('/tmp', `vca-test-${process.pid}-${rand}.sock`);
}

async function connectWithRetry(endpoint, onConnect, netModule = net) {
  return new Promise((resolve, reject) => {
    let retries = 10;
    let timer;
    let timeoutTimer;
    let ended = false;
    let activeClient = null;

    const cleanup = () => {
      ended = true;
      clearTimeout(timer);
      clearTimeout(timeoutTimer);
      if (activeClient) {
        activeClient.destroy();
        activeClient = null;
      }
    };

    const safeReject = (err) => {
      if (!ended) {
        cleanup();
        reject(err);
      }
    };

    const safeResolve = (val) => {
      if (!ended) {
        cleanup();
        resolve(val);
      }
    };

    timeoutTimer = setTimeout(() => {
      safeReject(new Error('connectWithRetry timed out'));
    }, 4500);

    const connect = () => {
      if (ended) return;
      try {
        const client = netModule.createConnection(endpoint);
        activeClient = client;

        client.on('error', (err) => {
          if (activeClient === client) {
            client.destroy();
            activeClient = null;
          } else {
            client.destroy();
          }
          if (ended) return;

          if (err && err.code === 'ENOENT' && retries > 0) {
            retries--;
            timer = setTimeout(connect, 50);
          } else {
            safeReject(err);
          }
        });

        client.on('connect', () => {
          if (ended) return;
          clearTimeout(timer);
          try {
            onConnect(client, safeResolve, safeReject);
          } catch (err) {
            safeReject(err);
          }
        });
      } catch (err) {
        safeReject(err);
      }
    };
    connect();
  });
}

function createFakeTracker() {
  return {
    getSession: () => undefined,
    addSession: () => {},
    removeSession: () => {},
    addPendingApproval: () => {},
    clearPendingApproval: () => {}
  };
}

function createServer(events, tracker = createFakeTracker()) {
  const endpoint = getUniqueTestEndpoint();
  const server = new SocketServer(tracker, (event) => events.push(event), endpoint, true);
  server.start();
  return server;
}

test('SocketServer handles missing protocolVersion as v1 and sends ok', { timeout: 5000 }, async () => {
  const events = [];
  const server = createServer(events);

  try {
    const responses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
        if (data.includes('\n')) client.end();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write('{"type": "session_start", "sessionId": "s-1"}\n');
    });

    assert.equal(events.length, 1);
    assert.equal(responses.length, 1);
    assert.equal(JSON.parse(responses[0]).status, 'ok');
  } finally {
    server.stop();
  }
});

test('SocketServer rejects syntactically invalid JSON', { timeout: 5000 }, async () => {
  const events = [];
  const server = createServer(events);
  try {
    const responses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
        if (data.includes('\n')) client.end();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write('{"type": "bad" \n');
    });
    assert.equal(responses.length, 1);
    assert.equal(JSON.parse(responses[0]).status, 'error');
    assert.equal(JSON.parse(responses[0]).code, 'invalid_json');
  } finally {
    server.stop();
  }
});

test('SocketServer rejects invalid optional fields and verifies zero tracker calls', { timeout: 5000 }, async () => {
  const events = [];
  let addSessionCalls = 0;
  const tracker = createFakeTracker();
  tracker.addSession = () => { addSessionCalls++; };

  const server = createServer(events, tracker);

  try {
    const responses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      let lines = 0;
      client.on('data', chunk => {
        data += chunk.toString();
        lines += (chunk.toString().match(/\n/g) || []).length;
        if (lines === 4) client.end();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write('{"type":"session_start","tool":123}\n');
      client.write('{"type":"session_start","message":123}\n');
      client.write('{"type":"session_start","timestamp":"bad"}\n');
      client.write('{"type":"session_start","metadata":[]}\n');
    });

    assert.equal(events.length, 0);
    assert.equal(addSessionCalls, 0);
    assert.equal(responses.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(JSON.parse(responses[i]).status, 'error');
      assert.equal(JSON.parse(responses[i]).code, 'invalid_event');
    }
  } finally {
    server.stop();
  }
});

test('SocketServer processes two complete messages in the same chunk', { timeout: 5000 }, async () => {
  const events = [];
  const server = createServer(events);

  try {
    const responses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      let lines = 0;
      client.on('data', chunk => {
        data += chunk.toString();
        lines += (chunk.toString().match(/\n/g) || []).length;
        if (lines === 2) client.end();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write('{"type": "session_start"}\n{"type": "session_end"}\n');
    });

    assert.equal(events.length, 2);
    assert.equal(responses.length, 2);
    assert.equal(JSON.parse(responses[0]).received, 'session_start');
    assert.equal(JSON.parse(responses[1]).received, 'session_end');
  } finally {
    server.stop();
  }
});

test('SocketServer handles fragmentation inside a UTF-8 multibyte character', { timeout: 5000 }, async () => {
  const events = [];
  const server = createServer(events);

  try {
    const responses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
        if (data.includes('\n')) client.end();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));

      const payload = Buffer.from('{"type":"session_start","message":"👋"}\n', 'utf8');
      const emojiStart = payload.indexOf(Buffer.from('👋'));

      client.write(payload.subarray(0, emojiStart + 2));
      setTimeout(() => client.write(payload.subarray(emojiStart + 2)), 10);
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].message, '👋');
    assert.equal(JSON.parse(responses[0]).status, 'ok');
  } finally {
    server.stop();
  }
});

test('SocketServer respects exactly 1 MiB limit', { timeout: 5000 }, async () => {
  const events = [];
  const server = createServer(events);

  try {
    const MAX_FRAME_SIZE = 1024 * 1024;
    const basePayload = '{"type":"session_start","message":"';
    const endPayload = '"}';
    const paddingLength = MAX_FRAME_SIZE - basePayload.length - endPayload.length;

    // Exactly 1 MiB valid
    const validMessage = Buffer.from(basePayload + 'A'.repeat(paddingLength) + endPayload + '\n');
    assert.equal(validMessage.length - 1, MAX_FRAME_SIZE);

    const validResponses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
        if (data.includes('\n')) client.end();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write(validMessage);
    });
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(validResponses[0]).status, 'ok');

    // Exactly 1 MiB + 1 byte invalid
    events.length = 0;
    const invalidMessage = Buffer.from(basePayload + 'A'.repeat(paddingLength + 1) + endPayload + '\n');
    assert.equal(invalidMessage.length - 1, MAX_FRAME_SIZE + 1);

    const invalidResponses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write(invalidMessage);
    });

    assert.equal(events.length, 0); // No events dispatched
    assert.equal(invalidResponses.length, 1);
    assert.equal(JSON.parse(invalidResponses[0]).status, 'error');
    assert.equal(JSON.parse(invalidResponses[0]).code, 'message_too_large');
  } finally {
    server.stop();
  }
});

test('SocketServer oversized frame followed by valid frame produces exactly one error', { timeout: 5000 }, async () => {
  const events = [];
  const server = createServer(events);

  try {
    const MAX_FRAME_SIZE = 1024 * 1024;
    const badMessage = '{"type":"session_start","message":"' + 'A'.repeat(MAX_FRAME_SIZE) + '"}\n';
    const goodMessage = '{"type":"session_start","message":"good"}\n';

    const responses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write(badMessage + goodMessage);
    });

    assert.equal(events.length, 0);
    assert.equal(responses.length, 1);
    assert.equal(JSON.parse(responses[0]).status, 'error');
    assert.equal(JSON.parse(responses[0]).code, 'message_too_large');
  } finally {
    server.stop();
  }
});

test('SocketServer rejects multibyte frame chars < 1MB but bytes > 1MB', { timeout: 5000 }, async () => {
  const events = [];
  const server = createServer(events);

  try {
    // 3 bytes per char, 350,000 chars = 1,050,000 bytes > 1 MB, but chars < 1 MB
    const badMessage = Buffer.from('{"type":"session_start","message":"' + '日'.repeat(350000) + '"}\n', 'utf8');

    const responses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write(badMessage);
    });

    assert.equal(events.length, 0);
    assert.equal(responses.length, 1);
    assert.equal(JSON.parse(responses[0]).status, 'error');
    assert.equal(JSON.parse(responses[0]).code, 'message_too_large');
  } finally {
    server.stop();
  }
});

test('SocketServer catches exceptions from tracker', { timeout: 5000 }, async () => {
  const events = [];
  const tracker = createFakeTracker();
  tracker.addSession = () => { throw new Error('Tracker boom'); };

  const server = createServer(events, tracker);

  try {
    const responses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
        if (data.includes('\n')) client.end();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write('{"type":"session_start","sessionId":"s-1"}\n');
    });

    assert.equal(responses.length, 1);
    assert.equal(JSON.parse(responses[0]).status, 'error');
    assert.equal(JSON.parse(responses[0]).code, 'internal_error');
  } finally {
    server.stop();
  }
});

test('SocketServer catches exceptions from onEvent and verifies auto-registration side-effects', { timeout: 5000 }, async () => {
  let eventsCalled = 0;
  const tracker = createFakeTracker();
  let addSessionCalled = false;
  tracker.addSession = () => { addSessionCalled = true; };

  const endpoint = getUniqueTestEndpoint();
  const server = new SocketServer(tracker, () => {
    eventsCalled++;
    throw new Error('onEvent boom');
  }, endpoint, true);
  server.start();

  try {
    const responses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
        if (data.includes('\n')) client.end();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      // A non-start/end event with sessionId will trigger auto-registration, then the onEvent
      client.write('{"type":"approval_needed","sessionId":"s-1","tool":"test"}\n');
    });

    // The auto-registration side effect should have been executed before the onEvent exception
    assert.equal(addSessionCalled, true);

    // eventsCalled will be 1: the exception on synthetic session_start aborts the flow on the first callback,
    // so the original approval_needed event is not reached in onEvent.
    assert.equal(eventsCalled, 1);

    assert.equal(responses.length, 1);
    assert.equal(JSON.parse(responses[0]).status, 'error');
    assert.equal(JSON.parse(responses[0]).code, 'internal_error');
  } finally {
    server.stop();
  }
});

test('connectWithRetry safely handles synchronous throw in createConnection', { timeout: 5000 }, async () => {
  const fakeNet = {
    createConnection: () => {
      throw new Error('synchronous net failure');
    },
  };

  let rejected = false;
  try {
    await connectWithRetry('fake-endpoint', () => {}, fakeNet);
  } catch (err) {
    rejected = true;
    assert.equal(err.message, 'synchronous net failure');
  }
  assert.equal(rejected, true, 'Promise must reject on synchronous throw');
});
