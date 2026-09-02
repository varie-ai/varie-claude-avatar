const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPOSITORY = 'varie-ai/varie-claude-avatar';
const RELEASE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

const APP_NAME = 'Varie Claude Avatar';
const WINDOWS_EXECUTABLE = `${APP_NAME}.exe`;
const MACOS_BUNDLE = `${APP_NAME}.app`;

// GitHub rejects requests without a User-Agent, and a real one makes the
// traffic attributable.
const USER_AGENT = 'varie-claude-avatar-installer (+https://github.com/varie-ai/varie-claude-avatar)';
const GITHUB_API_ACCEPT = 'application/vnd.github+json';

// Two separate allowlists: the release API and the asset CDN are different
// trust domains, and neither may stand in for the other.
const RELEASE_API_HOSTS = new Set(['api.github.com']);
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com']);

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 60000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

const STATE_DIR_NAME = '.varie-claude-avatar';
const LOCK_FILE_NAME = '.installing';
const INSTALL_LOG_NAME = 'install.log';

// The asset name comes from an untrusted release document, so it never reaches
// the filesystem: the download always lands on a fixed local name.
const LOCAL_DOWNLOAD_NAME = { win32: 'installer.exe', darwin: 'app.zip' };

/**
 * Windows asset naming contract.
 *
 * FORWARD DEPENDENCY: these names are produced by the `nsis.artifactName` and
 * `portable.artifactName` settings introduced in Task 6 and published by
 * Task 7. At the Task 4 commit `daemon/package.json` carries no artifactName,
 * so a real release does not yet expose them. Selection is intentionally
 * written against the Task 6 contract and is NOT tolerant of the older default
 * electron-builder names.
 *
 * macOS is untouched by Task 6 and the spec requires the existing ZIP install
 * behaviour to be preserved, so macOS matches "a .zip, with arm64 separating
 * Apple Silicon from Intel".
 */
const WINDOWS_SETUP_SUFFIX = (arch) => `-win-${arch}-setup.exe`;

const SUPPORTED_ARCHITECTURES = {
  win32: new Set(['x64']),
  darwin: new Set(['x64', 'arm64']),
};

function installError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses a URL and accepts it only when it is plain HTTPS on one of the given
 * hosts, with no credentials and no custom port.
 */
function assertTrustedUrl(rawUrl, allowedHosts = DOWNLOAD_HOSTS) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw installError('URL is not valid', 'E_UNTRUSTED_HOST');
  }

  if (parsed.protocol !== 'https:') {
    throw installError('URL must use HTTPS', 'E_UNTRUSTED_HOST');
  }
  if (parsed.username || parsed.password) {
    throw installError('URL must not carry credentials', 'E_UNTRUSTED_HOST');
  }
  if (parsed.port) {
    throw installError('URL must not use a custom port', 'E_UNTRUSTED_HOST');
  }
  if (!allowedHosts.has(parsed.hostname)) {
    throw installError(`Host ${parsed.hostname} is not allowed for this request`, 'E_UNTRUSTED_HOST');
  }

  return parsed;
}

function matchesPlatformAsset(name, platform, arch) {
  const lower = name.toLowerCase();

  if (platform === 'win32') {
    // The portable build is never installable: it is a stand-alone executable.
    return lower.endsWith(WINDOWS_SETUP_SUFFIX(arch));
  }

  if (!lower.endsWith('.zip')) return false;
  return arch === 'arm64' ? lower.includes('arm64') : !lower.includes('arm64');
}

/**
 * Picks the single asset that can install this platform/architecture.
 * Throws a coded error rather than guessing.
 */
function selectReleaseAsset(release, platform, arch) {
  if (!isPlainObject(release) || !Array.isArray(release.assets)) {
    throw installError('Release document is not usable', 'E_INVALID_RELEASE');
  }

  const supported = SUPPORTED_ARCHITECTURES[platform];
  if (!supported) {
    throw installError(`Platform ${platform} is not supported`, 'E_UNSUPPORTED_PLATFORM');
  }
  if (!supported.has(arch)) {
    throw installError(`Architecture ${arch} is not supported on ${platform}`, 'E_UNSUPPORTED_ARCH');
  }

  const candidate = release.assets.find((asset) => (
    isPlainObject(asset)
    && typeof asset.name === 'string'
    && typeof asset.browser_download_url === 'string'
    && matchesPlatformAsset(asset.name, platform, arch)
  ));

  if (!candidate) {
    throw installError(`No installable asset for ${platform}/${arch}`, 'E_NO_ASSET');
  }

  // An asset must be served from the download hosts, never from the API host.
  assertTrustedUrl(candidate.browser_download_url, DOWNLOAD_HOSTS);

  return { name: candidate.name, url: candidate.browser_download_url };
}

/**
 * Issues a GET and follows at most MAX_REDIRECTS hops, re-validating the host
 * against `allowedHosts` at every hop, and resolves with the final 200
 * response. Every request carries an application User-Agent.
 */
function openResponse(startUrl, deps = {}) {
  const httpGet = deps.httpGet ?? https.get;
  const allowedHosts = deps.allowedHosts ?? DOWNLOAD_HOSTS;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const headers = { 'User-Agent': USER_AGENT, ...(deps.headers ?? {}) };

  return new Promise((resolve, reject) => {
    let redirects = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    const visit = (currentUrl) => {
      let parsed;
      try {
        parsed = assertTrustedUrl(currentUrl, allowedHosts);
      } catch (error) {
        fail(error);
        return;
      }

      let request;
      try {
        request = httpGet(parsed.toString(), { headers }, (response) => {
          const status = response.statusCode;
          const location = response.headers && response.headers.location;

          if (status >= 300 && status < 400 && location) {
            if (typeof response.resume === 'function') response.resume();
            if (redirects >= maxRedirects) {
              fail(installError(`More than ${maxRedirects} redirects`, 'E_TOO_MANY_REDIRECTS'));
              return;
            }
            redirects += 1;
            let next;
            try {
              next = new URL(location, parsed).toString();
            } catch {
              fail(installError('Redirect location is not a valid URL', 'E_UNTRUSTED_HOST'));
              return;
            }
            visit(next);
            return;
          }

          if (status !== 200) {
            if (typeof response.resume === 'function') response.resume();
            fail(installError(`Unexpected HTTP status ${status}`, 'E_HTTP_STATUS'));
            return;
          }

          succeed(response);
        });
      } catch (error) {
        fail(error);
        return;
      }

      if (request && typeof request.on === 'function') {
        request.on('error', fail);
      }
      if (request && typeof request.setTimeout === 'function') {
        request.setTimeout(timeoutMs, () => {
          if (typeof request.destroy === 'function') request.destroy();
          fail(installError(`Request timed out after ${timeoutMs}ms`, 'E_TIMEOUT'));
        });
      }
    };

    visit(startUrl);
  });
}

function destroyQuietly(stream) {
  try {
    if (stream && typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy();
  } catch {
    // best effort
  }
}

/**
 * Streams an asset to disk.
 *
 * The transfer goes through stream pipeline, so backpressure is honoured and
 * every stream is destroyed when any of them fails. A response that ends before
 * the transfer completed is reported as incomplete, never as a good download.
 */
async function downloadAsset(url, destPath, deps = {}) {
  const createWriteStream = deps.createWriteStream ?? fs.createWriteStream;
  const response = await openResponse(url, { ...deps, allowedHosts: DOWNLOAD_HOSTS });

  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });

  const sink = createWriteStream(destPath);

  try {
    await pipeline(response, counter, sink);
  } catch (error) {
    destroyQuietly(response);
    destroyQuietly(counter);
    destroyQuietly(sink);
    if (error && error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      throw installError('Download ended before the asset was complete', 'E_DOWNLOAD_INCOMPLETE');
    }
    throw error;
  }

  if (bytes === 0) {
    throw installError('Downloaded asset was empty', 'E_EMPTY_DOWNLOAD');
  }

  return bytes;
}

/** Fetches the latest release document from the API host, bounded in size. */
async function fetchLatestRelease(deps = {}) {
  const response = await openResponse(deps.releaseUrl ?? RELEASE_API_URL, {
    ...deps,
    allowedHosts: RELEASE_API_HOSTS,
    headers: { Accept: GITHUB_API_ACCEPT, ...(deps.headers ?? {}) },
  });

  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const fail = (error) => {
      destroyQuietly(response);
      reject(error);
    };
    response.on('error', fail);
    response.on('aborted', () => fail(installError('Release request was aborted', 'E_DOWNLOAD_INCOMPLETE')));
    response.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) {
        fail(installError('Release document is too large', 'E_RELEASE_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  try {
    return JSON.parse(body);
  } catch {
    throw installError('Release document is not valid JSON', 'E_INVALID_RELEASE');
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readLockRaw(fsModule, lockPath) {
  try {
    return fsModule.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

function parseLockOwner(raw) {
  if (raw === null) return null;
  const pid = Number.parseInt(String(raw).trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Creates the lock file with exclusive creation, so two hooks racing to
 * install cannot both win.
 *
 * A stale lock is claimed atomically: it is renamed to a unique quarantine path
 * before being deleted. Losing that rename, or finding different content behind
 * it, means another process got there first, so the lock is re-evaluated and
 * never deleted.
 */
function acquireLock(lockPath, deps = {}) {
  const fsModule = deps.fs ?? fs;
  const pid = deps.pid ?? process.pid;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const uniqueSuffix = deps.uniqueSuffix ?? (() => crypto.randomBytes(6).toString('hex'));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let fd;
    try {
      fd = fsModule.openSync(lockPath, 'wx');
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;

      const raw = readLockRaw(fsModule, lockPath);
      const owner = parseLockOwner(raw);
      if (owner !== null && isProcessAlive(owner)) {
        throw installError(`Installation already running (pid ${owner})`, 'E_LOCKED');
      }

      const quarantine = `${lockPath}.stale-${pid}-${uniqueSuffix()}`;
      try {
        fsModule.renameSync(lockPath, quarantine);
      } catch (renameError) {
        // Someone else claimed it first: re-evaluate, never delete.
        if (renameError && renameError.code === 'ENOENT') continue;
        throw renameError;
      }

      if (readLockRaw(fsModule, quarantine) !== raw) {
        // A different lock appeared between the check and the claim; put it
        // back and let the next attempt judge the new owner.
        try {
          fsModule.renameSync(quarantine, lockPath);
        } catch {
          // The owner already recreated it.
        }
        continue;
      }

      try {
        fsModule.unlinkSync(quarantine);
      } catch {
        // best effort
      }
      continue;
    }

    try {
      fsModule.writeSync(fd, String(pid));
    } finally {
      fsModule.closeSync(fd);
    }

    return {
      pid,
      release() {
        try {
          // Never remove a lock that now belongs to somebody else.
          const currentOwner = parseLockOwner(readLockRaw(fsModule, lockPath));
          if (currentOwner !== null && currentOwner !== pid) return;
          fsModule.unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
      },
    };
  }

  throw installError('Installation lock could not be acquired', 'E_LOCKED');
}

function awaitExit(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      reject(installError(`Installer exited with ${signal ? `signal ${signal}` : `code ${code}`}`, 'E_INSTALLER_EXIT'));
    });
  });
}

/**
 * Downloads and installs the daemon, returning the installed executable path.
 *
 * Every side effect is injectable so the whole flow is testable without a real
 * download or a real process. The lock and the temporary directory are always
 * released, including on failure.
 */
async function installDaemon(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const tmpdir = options.tmpdir ?? os.tmpdir();
  const fsModule = options.fs ?? fs;
  const spawn = options.spawn ?? childProcess.spawn;
  const exists = options.exists ?? ((candidate) => fsModule.existsSync(candidate));
  const fetchRelease = options.fetchRelease ?? (() => fetchLatestRelease(options));
  const log = options.log ?? (() => {});

  const stateDir = path.join(homedir, STATE_DIR_NAME);
  fsModule.mkdirSync(stateDir, { recursive: true });

  // Acquired outside the try: a lock we did not take must never be released.
  const lock = acquireLock(path.join(stateDir, LOCK_FILE_NAME), options);

  let tmpDir = null;
  try {
    const release = await fetchRelease();
    const asset = selectReleaseAsset(release, platform, arch);
    log(`installing ${release.tag_name} (${asset.name})`);

    tmpDir = fsModule.mkdtempSync(path.join(tmpdir, 'varie-avatar-'));

    // asset.name is untrusted input and is never used as a path component.
    const localName = LOCAL_DOWNLOAD_NAME[platform];
    if (!localName) {
      throw installError(`Platform ${platform} is not supported`, 'E_UNSUPPORTED_PLATFORM');
    }
    const downloadPath = path.join(tmpDir, localName);
    await downloadAsset(asset.url, downloadPath, options);

    const installedPath = platform === 'win32'
      ? await runWindowsInstaller(downloadPath, { env, spawn })
      : await runMacosInstaller(downloadPath, { homedir, spawn });

    if (!exists(installedPath)) {
      throw installError('Installer finished but the application is missing', 'E_INSTALL_VERIFICATION');
    }

    log(`installed ${installedPath}`);
    return installedPath;
  } finally {
    lock.release();
    if (tmpDir) {
      try {
        fsModule.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

async function runWindowsInstaller(downloadPath, { env, spawn }) {
  const localAppData = env.LOCALAPPDATA;
  if (typeof localAppData !== 'string' || !localAppData) {
    throw installError('LOCALAPPDATA is not set', 'E_NO_INSTALL_DIR');
  }

  // Argument vector, never a constructed command line.
  const child = spawn(downloadPath, ['/S'], { stdio: 'ignore', windowsHide: true });
  await awaitExit(child);

  return path.join(localAppData, 'Programs', APP_NAME, WINDOWS_EXECUTABLE);
}

async function runMacosInstaller(downloadPath, { homedir, spawn }) {
  const installDir = path.posix.join(homedir, 'Applications');

  const child = spawn('/usr/bin/ditto', ['-x', '-k', downloadPath, installDir], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await awaitExit(child);

  return path.posix.join(installDir, MACOS_BUNDLE);
}

function defaultAppendLog(message) {
  try {
    const logDir = path.join(os.homedir(), STATE_DIR_NAME);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, INSTALL_LOG_NAME), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Never throw from the logger.
  }
}

/**
 * Standalone entry point.
 *
 * `--verbose` mirrors the concise messages on stdout/stderr on top of the log,
 * and a failure sets a non-zero exit code so a human or a script can see it.
 * This never blocks Claude Code: the hook starts the installer detached and
 * does not wait for its exit code.
 */
async function runCli(argv = [], deps = {}) {
  const verbose = argv.includes('--verbose');
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const appendLog = deps.appendLog ?? defaultAppendLog;
  const install = deps.installDaemon ?? installDaemon;
  const setExitCode = deps.setExitCode ?? ((code) => { process.exitCode = code; });

  const log = (message) => {
    appendLog(message);
    if (verbose) stdout.write(`[varie-avatar] ${message}\n`);
  };

  try {
    const installedPath = await install({ ...(deps.installOptions ?? {}), log });
    setExitCode(0);
    return installedPath;
  } catch (error) {
    const code = (error && error.code) || 'unknown';
    appendLog(`installation failed (${code})`);
    if (verbose) stderr.write(`[varie-avatar] installation failed (${code})\n`);
    setExitCode(1);
    return null;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).finally(() => process.exit(process.exitCode ?? 0));
}

module.exports = {
  RELEASE_API_URL,
  RELEASE_API_HOSTS,
  DOWNLOAD_HOSTS,
  USER_AGENT,
  GITHUB_API_ACCEPT,
  MAX_REDIRECTS,
  APP_NAME,
  WINDOWS_EXECUTABLE,
  MACOS_BUNDLE,
  LOCAL_DOWNLOAD_NAME,
  assertTrustedUrl,
  selectReleaseAsset,
  openResponse,
  downloadAsset,
  fetchLatestRelease,
  acquireLock,
  installDaemon,
  runCli,
};
