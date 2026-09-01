import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const daemonDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = resolve(daemonDir, 'dist/renderer');
mkdirSync(rendererDir, { recursive: true });

await build({
  entryPoints: [resolve(daemonDir, 'src/renderer/index.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  outfile: resolve(rendererDir, 'index.js'),
});

copyFileSync(resolve(daemonDir, 'src/renderer/index.html'), resolve(rendererDir, 'index.html'));
copyFileSync(
  resolve(daemonDir, 'src/renderer/character/spine-webgl.js'),
  resolve(rendererDir, 'spine-webgl.js'),
);
