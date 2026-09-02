#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function findTestFiles(dir = __dirname, exclude = [path.basename(__filename)], fsModule = fs) {
  const entries = fsModule.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.cjs') && !exclude.includes(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(dir, name));
}

function runTests(options = {}) {
  const dir = options.dir ?? __dirname;
  const exclude = options.exclude ?? [path.basename(__filename)];
  const fsModule = options.fs ?? fs;
  const execPath = options.execPath ?? process.execPath;
  const spawnFn = options.spawnSync ?? spawnSync;
  const exitFn = options.exit ?? ((code) => process.exit(code));
  const killFn = options.kill ?? ((pid, sig) => process.kill(pid, sig));
  const targetPid = options.pid ?? process.pid;
  const logError = options.logError ?? console.error;

  const testFiles = findTestFiles(dir, exclude, fsModule);

  if (testFiles.length === 0) {
    logError(`No test files found in ${dir}`);
    exitFn(1);
    return;
  }

  // --test-concurrency=1 keeps suites strictly sequential: hook transport and
  // socket-server tests bind real endpoints and must not race each other.
  const result = spawnFn(execPath, ['--test', '--test-concurrency=1', ...testFiles], {
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error) {
    logError(result.error);
    exitFn(1);
    return;
  }

  if (result.signal) {
    killFn(targetPid, result.signal);
  } else if (result.status !== null && result.status !== undefined) {
    exitFn(result.status);
  } else {
    exitFn(1);
  }
}

if (require.main === module) {
  runTests();
}

module.exports = {
  findTestFiles,
  runTests,
};
