const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const esbuild = require('../../daemon/node_modules/esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socket-server-test-'));
const outFile = path.join(tempDir, 'socket-server.js');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../../daemon/src/main/socket-server.ts')],
  bundle: true,
  platform: 'node',
  external: ['electron'],
  outfile: outFile,
  format: 'cjs',
});

const { SocketServer } = require(outFile);

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function getUniqueTestEndpoint() {
  const rand = crypto.randomBytes(4).toString('hex');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\varie-claude-avatar-test-${process.pid}-${rand}`;
  }
  return path.join(os.tmpdir(), `varie-claude-avatar-test-${process.pid}-${rand}.sock`);
}

async function connectWithRetry(endpoint, onConnect) {
  return new Promise((resolve, reject) => {
    let retries = 10;
    const connect = () => {
      const client = net.createConnection(endpoint);
      client.on('error', (err) => {
        if (err.code === 'ENOENT' && retries > 0) {
          retries--;
          setTimeout(connect, 50);
        } else {
          reject(err);
        }
      });
      client.on('connect', () => {
        onConnect(client, resolve, reject);
      });
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

function createServer(events) {
  const endpoint = getUniqueTestEndpoint();
  const server = new SocketServer(createFakeTracker(), (event) => events.push(event), endpoint, true);
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

      const payload = JSON.stringify({ type: 'session_start', sessionId: 's-1' }) + '\n';
      client.write(payload.substring(0, 10));
      setTimeout(() => client.write(payload.substring(10)), 10);
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'session_start');

    assert.equal(responses.length, 1);
    const resp = JSON.parse(responses[0]);
    assert.equal(resp.status, 'ok');
    assert.equal(resp.received, 'session_start');
  } finally {
    server.stop();
  }
});

test('SocketServer rejects unknown protocol version including null without triggering callback', { timeout: 5000 }, async () => {
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
      client.write(JSON.stringify({ protocolVersion: 2, type: 'session_start' }) + '\n');
      client.write(JSON.stringify({ protocolVersion: null, type: 'session_start' }) + '\n');
    });

    assert.equal(events.length, 0);
    assert.equal(responses.length, 2);
    const resp1 = JSON.parse(responses[0]);
    assert.equal(resp1.status, 'error');
    assert.equal(resp1.code, 'unsupported_protocol');
    const resp2 = JSON.parse(responses[1]);
    assert.equal(resp2.status, 'error');
    assert.equal(resp2.code, 'unsupported_protocol');
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

    assert.equal(events.length, 0);
    assert.equal(responses.length, 1);
    const resp = JSON.parse(responses[0]);
    assert.equal(resp.status, 'error');
    assert.equal(resp.code, 'invalid_json');
  } finally {
    server.stop();
  }
});

test('SocketServer rejects {}, [], missing type, unknown type, and type mismatch', { timeout: 5000 }, async () => {
  const events = [];
  const server = createServer(events);

  try {
    const responses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      let lines = 0;
      client.on('data', chunk => {
        data += chunk.toString();
        lines += (chunk.toString().match(/\n/g) || []).length;
        if (lines === 6) client.end();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write('{}\n');
      client.write('[]\n');
      client.write('{"sessionId": "s-1"}\n');
      client.write('{"type": "unknown_event"}\n');
      client.write('{"type": "session_start", "sessionId": 123}\n');
      client.write('null\n');
    });

    assert.equal(events.length, 0);
    assert.equal(responses.length, 6);
    for (let i = 0; i < 6; i++) {
      const resp = JSON.parse(responses[i]);
      assert.equal(resp.status, 'error');
      assert.equal(resp.code, 'invalid_event', 'Response ' + i + ' should be invalid_event');
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
    assert.equal(events[0].type, 'session_start');
    assert.equal(events[1].type, 'session_end');

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
      client.write(payload.subarray(0, payload.length - 3));
      setTimeout(() => client.write(payload.subarray(payload.length - 3)), 10);
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].message, '👋');
    assert.equal(JSON.parse(responses[0]).status, 'ok');
  } finally {
    server.stop();
  }
});

test('SocketServer respects exactly 1 MiB limit and rejects over 1 MiB frame', { timeout: 5000 }, async () => {
  const events = [];
  const server = createServer(events);

  try {
    const MAX_FRAME_SIZE = 1024 * 1024;
    const basePayload = '{"type":"session_start","message":"';
    const endPayload = '"}\n';

    const validMessage = basePayload + 'A'.repeat(MAX_FRAME_SIZE - 200) + endPayload;
    const invalidMessage = basePayload + 'A'.repeat(MAX_FRAME_SIZE + 100);

    const validResponses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
        if (data.includes('\n')) client.end();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write(validMessage);
    });
    assert.equal(JSON.parse(validResponses[0]).status, 'ok');

    const invalidResponses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write(invalidMessage);
    });

    assert.equal(invalidResponses.length, 1);
    assert.equal(JSON.parse(invalidResponses[0]).message, 'message_too_large');
  } finally {
    server.stop();
  }
});
