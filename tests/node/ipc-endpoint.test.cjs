const test = require('node:test');
const assert = require('node:assert/strict');
const { getIpcEndpoint } = require('../../shared/ipc-endpoint.cjs');

test('macOS retains the existing Unix socket', () => {
  assert.equal(getIpcEndpoint('darwin', '/Users/alice'), '/tmp/varie-claude-avatar.sock');
});

test('Windows endpoint is deterministic and user-scoped', () => {
  const first = getIpcEndpoint('win32', 'C:\\Users\\Alice');
  const second = getIpcEndpoint('win32', 'c:\\users\\alice');
  assert.equal(first, second);
  assert.match(first, /^\\\\\.\\pipe\\varie-claude-avatar-[a-f0-9]{12}$/);
});

test('different Windows homes do not share a pipe', () => {
  assert.notEqual(
    getIpcEndpoint('win32', 'C:\\Users\\Alice'),
    getIpcEndpoint('win32', 'C:\\Users\\Bob'),
  );
});
