const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const REPOSITORY = 'varie-ai/varie-claude-avatar';
const RELEASE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

const APP_NAME = 'Varie Claude Avatar';
const WINDOWS_EXECUTABLE = `${APP_NAME}.exe`;
const MACOS_BUNDLE = `${APP_NAME}.app`;

// Downloads are accepted only from GitHub over HTTPS.
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'api.github.com']);
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 60000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

const STATE_DIR_NAME = '.varie-claude-avatar';
const LOCK_FILE_NAME = '.installing';

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
 * Parses a URL and accepts it only when it is plain HTTPS on a GitHub host,
 * with no credentials and no custom port.
 */
function assertTrustedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw installError('Asset URL is not a valid URL', 'E_UNTRUSTED_HOST');
  }

  if (parsed.protocol !== 'https:') {
    throw installError('Asset URL must use HTTPS', 'E_UNTRUSTED_HOST');
  }
  if (parsed.username || parsed.password) {
    throw installError('Asset URL must not carry credentials', 'E_UNTRUSTED_HOST');
  }
  if (parsed.port) {
    throw installError('Asset URL must not use a custom port', 'E_UNTRUSTED_HOST');
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw installError('Asset URL host is not a GitHub release host', 'E_UNTRUSTED_HOST');
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

  assertTrustedUrl(candidate.browser_download_url);

  return { name: candidate.name, url: candidate.browser_download_url };
}

/**
 * Issues a GET and follows at most MAX_REDIRECTS hops, re-validating the host
 * at every hop, and resolves with the final 200 response.
 */
function openResponse(startUrl, deps = {}) {
  const httpGet = deps.httpGet ?? https.get;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

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
        parsed = assertTrustedUrl(currentUrl);
      } catch (error) {
        fail(error);
        return;
      }

      let request;
      try {
        request = httpGet(parsed.toString(), (response) => {
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

/** Streams an asset to disk and refuses an empty payload. */
async function downloadAsset(url, destPath, deps = {}) {
  const createWriteStream = deps.createWriteStream ?? fs.createWriteStream;
  const response = await openResponse(url, deps);

  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const sink = createWriteStream(destPath);
    if (typeof sink.on === 'function') sink.on('error', fail);

    response.on('error', fail);
    response.on('data', (chunk) => {
      bytes += chunk.length;
      sink.write(chunk);
    });
    response.on('end', () => {
      sink.end(() => {
        if (settled) return;
        if (bytes === 0) {
          fail(installError('Downloaded asset was empty', 'E_EMPTY_DOWNLOAD'));
          return;
        }
        settled = true;
        resolve(bytes);
      });
    });
  });
}

/** Fetches the latest release document, bounded in size. */
async function fetchLatestRelease(deps = {}) {
  const response = await openResponse(deps.releaseUrl ?? RELEASE_API_URL, deps);

  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    response.on('error', reject);
    response.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) {
        reject(installError('Release document is too large', 'E_RELEASE_TOO_LARGE'));
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

function readLockOwner(fsModule, lockPath) {
  let raw;
  try {
    raw = fsModule.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  const pid = Number.parseInt(String(raw).trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Creates the lock file with exclusive creation, so two hooks racing to
 * install cannot both win. A lock whose owner is gone (or unreadable) is
 * recovered exactly once.
 */
function acquireLock(lockPath, deps = {}) {
  const fsModule = deps.fs ?? fs;
  const pid = deps.pid ?? process.pid;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fsModule.openSync(lockPath, 'wx');
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;

      const owner = readLockOwner(fsModule, lockPath);
      if (owner !== null && isProcessAlive(owner)) {
        throw installError(`Installation already running (pid ${owner})`, 'E_LOCKED');
      }

      try {
        fsModule.unlinkSync(lockPath);
      } catch {
        // Another process recovered it first; the next attempt decides.
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
    const downloadPath = path.join(tmpDir, asset.name);
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

if (require.main === module) {
  const logFile = path.join(os.homedir(), STATE_DIR_NAME, 'install.log');
  const record = (message) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      // Never throw from the logger.
    }
  };

  installDaemon({ log: record })
    .catch((error) => record(`installation failed (${(error && error.code) || 'unknown'})`))
    .finally(() => process.exit(0));
}

module.exports = {
  RELEASE_API_URL,
  ALLOWED_HOSTS,
  MAX_REDIRECTS,
  APP_NAME,
  WINDOWS_EXECUTABLE,
  MACOS_BUNDLE,
  assertTrustedUrl,
  selectReleaseAsset,
  openResponse,
  downloadAsset,
  fetchLatestRelease,
  acquireLock,
  installDaemon,
};
