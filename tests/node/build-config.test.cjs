const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'daemon/package.json'), 'utf8'));

test('renderer build is implemented by a platform-neutral Node script', () => {
  assert.equal(pkg.scripts['build:renderer'], 'node scripts/build-renderer.mjs');
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /mkdir -p|\bcp\s/);
});

test('node tests invoke the test runner script', () => {
  assert.equal(pkg.scripts['test:node'], 'node ../tests/node/run-tests.cjs');
  assert.doesNotMatch(pkg.scripts['test:node'], /\*/);
});
