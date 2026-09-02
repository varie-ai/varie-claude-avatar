const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const APP_NAME = 'Varie Claude Avatar';
const WINDOWS_EXECUTABLE = `${APP_NAME}.exe`;
const MACOS_BUNDLE = `${APP_NAME}.app`;

// The daemon must never make Claude Code wait: probe briefly, then give up.
const LAUNCH_TIMEOUT_MS = 5000;
const PROBE_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 250;

const DETACHED_SPAWN_OPTIONS = Object.freeze({
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

/** Repository `daemon/` directory, used only for the source-checkout fallback. */
const DEFAULT_DAEMON_ROOT = path.resolve(__dirname, '..', '..', '..', 'daemon');
const INSTALLER_ENTRY = path.join(__dirname, 'install-daemon.cjs');

function errorCode(error) {
  if (!error) return 'unknown';
  return error.code || error.name || 'Error';
}

function defaultExists(candidate) {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

/**
 * Opens a short-lived connection to decide whether the daemon is already up.
 * Never throws and never leaves a socket or timer behind.
 */
function probeEndpoint(endpoint, options = {}) {
  const netModule = options.netModule ?? net;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const timers = options.timers ?? { setTimeout, clearTimeout };

  return new Promise((resolve) => {
    let socket = null;
    let deadline = null;
    let settled = false;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (deadline !== null) {
        timers.clearTimeout(deadline);
        deadline = null;
      }
      const target = socket;
      socket = null;
      if (target) {
        target.removeAllListeners();
        target.on('error', () => {});
        target.destroy();
      }
    };

    const settle = (answered) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(answered);
    };

    deadline = timers.setTimeout(() => settle(false), timeoutMs);

    try {
      socket = netModule.createConnection(endpoint);
    } catch {
      settle(false);
      return;
    }

    socket.on('connect', () => settle(true));
    socket.on('error', () => settle(false));
    socket.on('close', () => settle(false));
  });
}

/**
 * Polls the endpoint until it answers or the bounded deadline expires.
 * Returns whether the daemon answered; it never throws.
 */
async function waitForEndpoint(endpoint, options = {}) {
  const probe = options.probe ?? ((target) => probeEndpoint(target, options));
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? LAUNCH_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? PROBE_INTERVAL_MS;

  const deadline = now() + timeoutMs;

  for (;;) {
    let answered = false;
    try {
      answered = await probe(endpoint);
    } catch {
      answered = false;
    }
    if (answered) return true;

    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await delay(Math.min(intervalMs, remaining));
  }
}

/**
 * Chooses what to start, preferring a real installation over a source checkout.
 * Returns null when nothing launchable exists, which means "install instead".
 * Only the two supported platforms are considered; Linux is out of scope.
 */
function resolveLaunchTarget(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const daemonRoot = options.daemonRoot ?? DEFAULT_DAEMON_ROOT;
  const exists = options.exists ?? defaultExists;

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    if (typeof localAppData === 'string' && localAppData) {
      const executable = path.join(localAppData, 'Programs', APP_NAME, WINDOWS_EXECUTABLE);
      if (exists(executable)) {
        return { kind: 'installed', command: executable, args: [] };
      }
    }
  } else if (platform === 'darwin') {
    // macOS locations are always POSIX, even when this module is exercised
    // from a Windows host.
    const candidates = [
      path.posix.join('/Applications', MACOS_BUNDLE),
      path.posix.join(homedir, 'Applications', MACOS_BUNDLE),
    ];
    for (const bundle of candidates) {
      if (exists(bundle)) {
        // `open -g -j` keeps the overlay in the background, exactly as before.
        return { kind: 'installed', command: '/usr/bin/open', args: ['-g', '-j', bundle] };
      }
    }
  } else {
    return null;
  }

  const electron = platform === 'win32'
    ? path.join(daemonRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(daemonRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const bundle = path.join(daemonRoot, 'dist', 'main', 'index.js');

  // A source checkout only counts when Electron is installed AND the main
  // process has actually been built; otherwise starting it would just fail.
  if (exists(electron) && exists(bundle)) {
    return { kind: 'dev', command: electron, args: [daemonRoot] };
  }

  return null;
}

/** Fire-and-forget installer: detached, silent, never awaited by a hook. */
function startInstaller(deps = {}) {
  const spawn = deps.spawn ?? childProcess.spawn;
  const execPath = deps.execPath ?? process.execPath;
  const child = spawn(execPath, [INSTALLER_ENTRY], DETACHED_SPAWN_OPTIONS);
  if (child && typeof child.unref === 'function') child.unref();
}

/**
 * Makes the daemon available for this session.
 *
 * Returns 'running' when the endpoint already answered, 'launched' when an
 * application was started (whether or not it answered within the deadline), and
 * 'installing' when the work was handed over to the detached installer.
 *
 * It never throws: a hook must not fail because the avatar is unavailable.
 */
async function ensureDaemon(options = {}) {
  const endpoint = options.endpoint ?? require('../../../shared/ipc-endpoint.cjs').getIpcEndpoint();
  const probe = options.probe ?? ((target) => probeEndpoint(target, options));
  const spawn = options.spawn ?? childProcess.spawn;
  const install = options.install ?? (async () => startInstaller(options));
  const wait = options.waitForEndpoint ?? ((target) => waitForEndpoint(target, { ...options, probe }));
  const log = options.log ?? (() => {});

  try {
    if (await probe(endpoint)) return 'running';
  } catch (error) {
    log(`daemon probe failed (${errorCode(error)})`);
  }

  const target = resolveLaunchTarget(options);

  if (target) {
    try {
      const child = spawn(target.command, target.args, DETACHED_SPAWN_OPTIONS);
      if (child && typeof child.unref === 'function') child.unref();
      await wait(endpoint);
      return 'launched';
    } catch (error) {
      // The application exists but could not be started: fall through and let
      // the installer repair the installation.
      log(`daemon launch failed (${errorCode(error)})`);
    }
  }

  try {
    await install({ endpoint, reason: target ? 'launch_failed' : 'not_installed' });
  } catch (error) {
    log(`daemon installation could not be started (${errorCode(error)})`);
  }

  return 'installing';
}

module.exports = {
  APP_NAME,
  WINDOWS_EXECUTABLE,
  MACOS_BUNDLE,
  LAUNCH_TIMEOUT_MS,
  PROBE_INTERVAL_MS,
  DETACHED_SPAWN_OPTIONS,
  probeEndpoint,
  waitForEndpoint,
  resolveLaunchTarget,
  startInstaller,
  ensureDaemon,
};
