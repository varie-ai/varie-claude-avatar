#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testsDir = __dirname;
const currentScript = path.basename(__filename);

const testFiles = fs.readdirSync(testsDir)
  .filter((file) => file.endsWith('.test.cjs') && file !== currentScript)
  .sort()
  .map((file) => path.join(testsDir, file));

if (testFiles.length === 0) {
  console.error(`No test files found in ${testsDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
} else if (result.status !== null) {
  process.exit(result.status);
} else {
  process.exit(1);
}
