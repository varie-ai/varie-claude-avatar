const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { findTestFiles, runTests } = require('./run-tests.cjs');

test('findTestFiles discovers sorted .test.cjs files and excludes runner and directories', () => {
  const fakeFs = {
    readdirSync: (_dir, _opts) => [
      { name: 'z-last.test.cjs', isFile: () => true },
      { name: 'run-tests.cjs', isFile: () => true },
      { name: 'a-first.test.cjs', isFile: () => true },
      { name: 'dir.test.cjs', isFile: () => false },
      { name: 'helper.cjs', isFile: () => true },
    ],
  };

  const files = findTestFiles('/fake/tests', ['run-tests.cjs'], fakeFs);
  assert.deepEqual(files, [
    path.join('/fake/tests', 'a-first.test.cjs'),
    path.join('/fake/tests', 'z-last.test.cjs'),
  ]);
});

test('runTests logs error and exits 1 if no test files found', () => {
  let exitCode = null;
  const loggedErrors = [];
  const fakeFs = {
    readdirSync: () => [],
  };

  runTests({
    dir: '/empty/dir',
    fs: fakeFs,
    exit: (code) => { exitCode = code; },
    logError: (msg) => loggedErrors.push(msg),
  });

  assert.equal(exitCode, 1);
  assert.equal(loggedErrors.length, 1);
  assert.match(loggedErrors[0], /No test files found/);
});

test('runTests spawns process.execPath with explicit arguments and no shell', () => {
  let spawnArgs = null;
  let exitCode = null;
  const fakeFs = {
    readdirSync: () => [
      { name: 'sample.test.cjs', isFile: () => true },
    ],
  };
  const fakeSpawn = (execPath, args, options) => {
    spawnArgs = { execPath, args, options };
    return { status: 0, signal: null, error: null };
  };

  runTests({
    dir: '/fake/tests',
    execPath: '/path/to/custom-node',
    fs: fakeFs,
    spawnSync: fakeSpawn,
    exit: (code) => { exitCode = code; },
  });

  assert.equal(spawnArgs.execPath, '/path/to/custom-node');
  assert.deepEqual(spawnArgs.args, ['--test', path.join('/fake/tests', 'sample.test.cjs')]);
  assert.equal(spawnArgs.options.stdio, 'inherit');
  assert.equal(spawnArgs.options.windowsHide, true);
  assert.equal(spawnArgs.options.shell, undefined);
  assert.equal(exitCode, 0);
});

test('runTests handles spawn error', () => {
  let exitCode = null;
  const loggedErrors = [];
  const fakeFs = {
    readdirSync: () => [
      { name: 'sample.test.cjs', isFile: () => true },
    ],
  };
  const fakeSpawn = () => ({ status: null, signal: null, error: new Error('spawn failed') });

  runTests({
    dir: '/fake/tests',
    fs: fakeFs,
    spawnSync: fakeSpawn,
    exit: (code) => { exitCode = code; },
    logError: (err) => loggedErrors.push(err),
  });

  assert.equal(exitCode, 1);
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0].message, 'spawn failed');
});

test('runTests propagates non-zero exit status', () => {
  let exitCode = null;
  const fakeFs = {
    readdirSync: () => [
      { name: 'sample.test.cjs', isFile: () => true },
    ],
  };
  const fakeSpawn = () => ({ status: 42, signal: null, error: null });

  runTests({
    dir: '/fake/tests',
    fs: fakeFs,
    spawnSync: fakeSpawn,
    exit: (code) => { exitCode = code; },
  });

  assert.equal(exitCode, 42);
});

test('runTests propagates signal via injected kill handler without terminating process', () => {
  let killCalledWith = null;
  let exitCalled = false;
  const fakeFs = {
    readdirSync: () => [
      { name: 'sample.test.cjs', isFile: () => true },
    ],
  };
  const fakeSpawn = () => ({ status: null, signal: 'SIGINT', error: null });

  runTests({
    dir: '/fake/tests',
    pid: 1234,
    fs: fakeFs,
    spawnSync: fakeSpawn,
    kill: (pid, sig) => { killCalledWith = { pid, sig }; },
    exit: () => { exitCalled = true; },
  });

  assert.deepEqual(killCalledWith, { pid: 1234, sig: 'SIGINT' });
  assert.equal(exitCalled, false);
});

test('runTests falls back to exit code 1 when status and signal are null', () => {
  let exitCode = null;
  const fakeFs = {
    readdirSync: () => [
      { name: 'sample.test.cjs', isFile: () => true },
    ],
  };
  const fakeSpawn = () => ({ status: null, signal: null, error: null });

  runTests({
    dir: '/fake/tests',
    fs: fakeFs,
    spawnSync: fakeSpawn,
    exit: (code) => { exitCode = code; },
  });

  assert.equal(exitCode, 1);
});
