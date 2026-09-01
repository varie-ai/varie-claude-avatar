const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const esbuild = require('../../daemon/node_modules/esbuild');
const fs = require('node:fs');
const path = require('node:path');

// Compile the TS file so we can require it
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../../daemon/src/main/socket-server.ts')],
  bundle: true,
  platform: 'node',
  external: ['electron'],
  outfile: path.join(__dirname, '../../daemon/dist/main/socket-server.js'),
  format: 'cjs',
});

const { SocketServer } = require('../../daemon/dist/main/socket-server.js');

const os = require('node:os');
const originalHomedir = os.homedir;

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

test('SocketServer handles fragmentation and sends ok acknowledgement for valid event', async () => {
  os.homedir = () => path.join(os.tmpdir(), 'Test' + Date.now());
  const events = [];
  const fakeSessionTracker = {
    getSession: () => undefined,
    addSession: () => {},
    removeSession: () => {},
    addPendingApproval: () => {},
    clearPendingApproval: () => {}
  };
  
  const server = new SocketServer(fakeSessionTracker, (event) => events.push(event));
  server.start();
  
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
    os.homedir = originalHomedir;
  }
});

test('SocketServer rejects unknown protocol version without triggering callback', async () => {
  os.homedir = () => path.join(os.tmpdir(), 'Test' + Date.now() + '2');
  const events = [];
  const fakeSessionTracker = {
    getSession: () => undefined,
    addSession: () => {},
    removeSession: () => {},
    addPendingApproval: () => {},
    clearPendingApproval: () => {}
  };
  
  const server = new SocketServer(fakeSessionTracker, (event) => events.push(event));
  server.start();
  
  try {
    const responses = await connectWithRetry(server.getEndpoint(), (client, resolve) => {
      let data = '';
      client.on('data', chunk => {
        data += chunk.toString();
        if (data.includes('\n')) client.end();
      });
      client.on('end', () => resolve(data.split('\n').filter(Boolean)));
      client.write(JSON.stringify({ protocolVersion: 2, type: 'session_start' }) + '\n');
    });
    
    assert.equal(events.length, 0);
    assert.equal(responses.length, 1);
    const resp = JSON.parse(responses[0]);
    assert.equal(resp.status, 'error');
    assert.equal(resp.code, 'unsupported_protocol');
  } finally {
    server.stop();
    os.homedir = originalHomedir;
  }
});
