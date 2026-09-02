const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DAEMON_DIR = path.join(REPO_ROOT, 'daemon');
const PKG_PATH = path.join(DAEMON_DIR, 'package.json');
const ICO_PATH = path.join(DAEMON_DIR, 'assets', 'icon.ico');
const INDEX_TS = path.join(DAEMON_DIR, 'src', 'main', 'index.ts');

// Reading configuration and sources only: no Electron, no packaging, no
// installer is ever started by this suite.
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

const REQUIRED_ICO_SIZES = [16, 32, 48, 64, 128, 256];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parses the ICO container: header plus directory entries. */
function parseIco(buffer) {
  assert.ok(buffer.length > 6, 'the ICO must not be empty');

  const reserved = buffer.readUInt16LE(0);
  const type = buffer.readUInt16LE(2);
  const count = buffer.readUInt16LE(4);

  assert.equal(reserved, 0, 'ICONDIR.reserved must be 0');
  assert.equal(type, 1, 'ICONDIR.type must be 1 (icon)');
  assert.ok(count > 0, 'the ICO must declare at least one image');
  assert.ok(buffer.length >= 6 + count * 16, 'the directory must fit in the file');

  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const widthByte = buffer[offset];
    const heightByte = buffer[offset + 1];
    entries.push({
      width: widthByte === 0 ? 256 : widthByte,
      height: heightByte === 0 ? 256 : heightByte,
      planes: buffer.readUInt16LE(offset + 4),
      bitCount: buffer.readUInt16LE(offset + 6),
      bytesInRes: buffer.readUInt32LE(offset + 8),
      imageOffset: buffer.readUInt32LE(offset + 12),
    });
  }

  return { count, entries };
}

/** Reads the real pixel size out of an embedded frame, PNG or BMP/DIB. */
function readFrameSize(payload) {
  if (payload.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return {
      kind: 'png',
      width: payload.readUInt32BE(16),
      height: payload.readUInt32BE(20),
    };
  }

  // BITMAPINFOHEADER: height counts the image plus its AND mask.
  const headerSize = payload.readUInt32LE(0);
  assert.equal(headerSize, 40, 'an uncompressed frame must carry a BITMAPINFOHEADER');
  return {
    kind: 'bmp',
    width: payload.readInt32LE(4),
    height: payload.readInt32LE(8) / 2,
  };
}

function readIco() {
  assert.ok(fs.existsSync(ICO_PATH), `${ICO_PATH} must exist`);
  return fs.readFileSync(ICO_PATH);
}

function readIndexSource() {
  return fs.readFileSync(INDEX_TS, 'utf8');
}

/** Drops comments so a structural assertion cannot be satisfied by prose. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Returns the body of a top-level function declaration. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `${name} must be a complete declaration`);
  return source.slice(start, end + 2);
}

// --- electron-builder Windows configuration ---------------------------------

test('the Windows build points at the real ICO icon', () => {
  assert.equal(pkg.build.win.icon, 'assets/icon.ico');
});

test('both Windows targets are declared explicitly for x64', () => {
  assert.deepEqual(pkg.build.win.target, [
    { target: 'nsis', arch: ['x64'] },
    { target: 'portable', arch: ['x64'] },
  ]);

  for (const entry of pkg.build.win.target) {
    assert.equal(typeof entry, 'object', 'a bare string target would inherit the host architecture');
    assert.deepEqual(entry.arch, ['x64'], `${entry.target} must pin x64`);
  }
});

test('the NSIS installer is per-user and one-click and keeps user data', () => {
  assert.equal(pkg.build.nsis.oneClick, true);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
});

test('the installer artifact name is deterministic', () => {
  assert.equal(pkg.build.nsis.artifactName, '${productName}-${version}-win-${arch}-setup.${ext}');
});

test('the portable artifact name is deterministic', () => {
  assert.equal(pkg.build.portable.artifactName, '${productName}-${version}-win-${arch}-portable.${ext}');
});

test('the two artifact names are distinct and cannot expand to undefined', () => {
  const setup = pkg.build.nsis.artifactName;
  const portable = pkg.build.portable.artifactName;

  assert.notEqual(setup, portable);
  assert.ok(setup.includes('-setup.'));
  assert.ok(portable.includes('-portable.'));

  // Every macro used must be a value electron-builder can actually resolve.
  const RESOLVABLE = new Set(['productName', 'version', 'arch', 'ext']);
  for (const template of [setup, portable]) {
    const macros = [...template.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
    assert.ok(macros.length > 0);
    for (const macro of macros) {
      assert.ok(RESOLVABLE.has(macro), `\${${macro}} is not a resolvable macro`);
    }
    assert.ok(!template.includes('undefined'));
  }

  assert.equal(typeof pkg.build.productName, 'string');
  assert.ok(pkg.build.productName.length > 0);
  assert.equal(typeof pkg.version, 'string');
  assert.ok(/^\d+\.\d+\.\d+/.test(pkg.version), 'version must be resolvable');
});

test('the macOS packaging configuration is untouched', () => {
  assert.deepEqual(pkg.build.mac, {
    category: 'public.app-category.utilities',
    target: ['dmg', 'zip'],
    icon: 'assets/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: true,
  });
});

test('the packaged files list carries the bundles and the runtime icon only', () => {
  const files = pkg.build.files;
  assert.ok(Array.isArray(files));

  assert.ok(files.includes('dist/**/*'), 'the built bundles must ship');
  assert.ok(files.includes('node_modules/**/*'), 'runtime dependencies must ship');
  assert.ok(
    files.includes('assets/icon.ico'),
    'the tray icon must be readable from the packaged app',
  );

  for (const pattern of files) {
    assert.ok(!pattern.startsWith('src/'), `${pattern} would ship sources`);
    assert.ok(!pattern.includes('release'), `${pattern} would ship build output`);
    assert.ok(!pattern.includes('iconset'), `${pattern} would ship unused artwork`);
  }
});

// --- the ICO container -------------------------------------------------------

test('icon.ico is a real ICO container, not a renamed PNG', () => {
  const buffer = readIco();

  assert.ok(!buffer.subarray(0, 8).equals(PNG_SIGNATURE), 'a renamed PNG is not an ICO');

  const { count } = parseIco(buffer);
  assert.equal(count, REQUIRED_ICO_SIZES.length, 'the ICO must hold exactly six frames');
});

test('icon.ico holds exactly the six required resolutions', () => {
  const { entries } = parseIco(readIco());

  const declared = entries.map((entry) => entry.width).sort((a, b) => a - b);
  assert.deepEqual(declared, REQUIRED_ICO_SIZES);

  for (const entry of entries) {
    assert.equal(entry.width, entry.height, 'every frame must be square');
  }
});

test('every ICO frame has a non-empty payload at a valid offset', () => {
  const buffer = readIco();
  const { entries } = parseIco(buffer);

  for (const entry of entries) {
    assert.ok(entry.bytesInRes > 0, `${entry.width}px frame must not be empty`);
    assert.ok(entry.imageOffset >= 6 + entries.length * 16, `${entry.width}px offset overlaps the directory`);
    assert.ok(
      entry.imageOffset + entry.bytesInRes <= buffer.length,
      `${entry.width}px frame runs past the end of the file`,
    );

    const payload = buffer.subarray(entry.imageOffset, entry.imageOffset + entry.bytesInRes);
    const actual = readFrameSize(payload);

    assert.equal(actual.width, entry.width, `${entry.width}px frame pixel width must match the directory`);
    assert.equal(actual.height, entry.height, `${entry.width}px frame pixel height must match the directory`);
    assert.equal(entry.bitCount, 32, `${entry.width}px frame must keep the alpha channel`);
  }
});

test('the ICO frames do not overlap each other', () => {
  const { entries } = parseIco(readIco());
  const ranges = entries
    .map((entry) => [entry.imageOffset, entry.imageOffset + entry.bytesInRes])
    .sort((a, b) => a[0] - b[0]);

  for (let index = 1; index < ranges.length; index += 1) {
    assert.ok(ranges[index][0] >= ranges[index - 1][1], 'frame payloads must not overlap');
  }
});

// --- tray icon selection -----------------------------------------------------

test('Windows loads the ICO for the tray instead of an empty image', () => {
  const source = readIndexSource();

  assert.match(source, /icon\.ico/, 'the Windows tray must load assets/icon.ico');
  assert.match(source, /process\.platform === 'win32'/);
  assert.match(source, /nativeImage\.createFromPath/);

  const body = functionBody(stripComments(source), 'createTray');
  const guard = body.indexOf("process.platform === 'win32'");
  const fromPath = body.indexOf('nativeImage.createFromPath');
  const empty = body.indexOf('nativeImage.createEmpty()');

  assert.ok(guard >= 0, 'createTray must branch on the platform');
  assert.ok(fromPath > guard, 'the Windows branch must load a real icon');
  assert.ok(
    empty === -1 || empty > guard,
    'an empty image may only be reached on the guarded non-Windows branch',
  );
});

test('macOS keeps its existing tray image behaviour', () => {
  const source = readIndexSource();
  assert.match(source, /nativeImage\.createEmpty\(\)/, 'the macOS path is unchanged');
});

test('the tray icon path is resolved from the app bundle, never from the cwd', () => {
  const source = readIndexSource();

  assert.match(source, /app\.getAppPath\(\)/, 'the packaged app path must drive resolution');
  assert.ok(
    !/process\.cwd\(\)/.test(stripComments(source)),
    'process.cwd() is not the app directory',
  );
});

test('the tray stays module scoped so it cannot be garbage collected', () => {
  const source = readIndexSource();

  assert.match(source, /^let tray: Tray \| null = null;$/m, 'tray must stay a module-level binding');
  assert.ok(!/^\s+(const|let|var) tray\b/m.test(source), 'tray must never be re-declared inside a function');
  assert.match(source, /\btray = new Tray\(/, 'createTray must assign the module binding');
});

// --- nothing generated is tracked --------------------------------------------

test('no build artifact is tracked by git', (t) => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      t.skip('git is not available in this environment');
      return;
    }
    throw error;
  }

  const offenders = tracked
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => (
      line.endsWith('.exe')
      || line.startsWith('daemon/release/')
      || line.startsWith('daemon/dist/')
      || line.includes('node_modules/')
    ));

  assert.deepEqual(offenders, [], 'generated artifacts must stay out of the repository');
});
