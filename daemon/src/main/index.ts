import { app, BrowserWindow, Tray, Menu, screen, nativeImage, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SocketServer } from './socket-server';
import { SessionTracker } from './session-tracker';
import { StatsTracker } from './stats-tracker';
import { MouseTracker } from './mouse-tracker';
import {
  createTerminalActionService,
  registerTerminalActionIpc,
} from './terminal-actions/create-terminal-actions';
import type { TerminalActionService } from './terminal-actions/terminal-action-service';

// Handle EPIPE errors globally - occurs when launching terminal closes
// This prevents the "A JavaScript error occurred in the main process" dialog
process.on('uncaughtException', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
    // Silently ignore EPIPE - stdout/stderr pipe closed
    return;
  }
  // Re-throw other errors
  throw error;
});

process.stdout?.on?.('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
});

process.stderr?.on?.('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
});

// File-based logging for debugging
const LOG_FILE = path.join(app.getPath('userData'), 'debug.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_LOG_AGE_DAYS = 7;

// Track if stdout is still available (becomes unavailable after launching terminal closes)
let stdoutAvailable = true;

function log(level: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] [${level}] ${args.map(a =>
    typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
  ).join(' ')}\n`;

  // Only try console.log if stdout is still available
  if (stdoutAvailable) {
    try {
      console.log(message.trim());
    } catch (e) {
      // EPIPE error - stdout pipe closed (launching terminal closed)
      stdoutAvailable = false;
    }
  }

  // Always write to file log
  fs.appendFileSync(LOG_FILE, message);
}

// Initialize log with rotation and cleanup
function initLog(): void {
  const userDataPath = app.getPath('userData');

  // Rotate if log too large
  if (fs.existsSync(LOG_FILE)) {
    try {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        const rotatedPath = LOG_FILE.replace('.log', `.${Date.now()}.log`);
        fs.renameSync(LOG_FILE, rotatedPath);
      }
    } catch (err) {
      // Ignore rotation errors
    }
  }

  // Delete old rotated logs
  try {
    const files = fs.readdirSync(userDataPath);
    const now = Date.now();
    for (const file of files) {
      if (file.match(/debug\.\d+\.log$/)) {
        const filePath = path.join(userDataPath, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000) {
          fs.unlinkSync(filePath);
        }
      }
    }
  } catch (err) {
    // Ignore cleanup errors
  }

  fs.writeFileSync(LOG_FILE, `=== Varie Claude Avatar Debug Log ===\nStarted: ${new Date().toISOString()}\nLog file: ${LOG_FILE}\n\n`);
  log('INFO', 'App starting...');
  log('INFO', 'Electron version:', process.versions.electron);
  log('INFO', 'Chrome version:', process.versions.chrome);
  log('INFO', 'Node version:', process.versions.node);
  log('INFO', 'Platform:', process.platform, process.arch);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let socketServer: SocketServer | null = null;
let sessionTracker: SessionTracker | null = null;
let terminalActions: TerminalActionService | null = null;
let statsTracker: StatsTracker | null = null;
let mouseTracker: MouseTracker | null = null;

const WINDOW_SIZE = { width: 360, height: 618 }; // 540px character + 78px notification area
const WINDOW_MARGIN = 20;
const NOTIFICATION_HEADER_HEIGHT = 108; // Space reserved for notifications above character

// Character loading
const CONFIG_DIR = path.join(os.homedir(), '.varie-claude-avatar');
const CHARACTERS_DIR = path.join(CONFIG_DIR, 'characters');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_CHARACTER_ID = 'beatriz_4e17b3271c2b';
// Legacy fallback — only used when config.json has no modelUrls (e.g. cold start with default character).
// New character-set operations save backend-provided URLs to config.json directly.
const CDN_BASE_FALLBACK = 'https://varie.ai/models/custom';

interface ModelUrls {
  fullUrl: string | null;
  baseUrl: string | null;
}

interface CharacterConfig {
  activeCharacter: string;
  characterName?: string;
  publicModelStatus?: string;
  modelUrls?: ModelUrls;
  scale?: number;
}

function readCharacterConfig(): CharacterConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (err) {
    log('WARN', 'Failed to read config.json:', err);
  }
  return { activeCharacter: DEFAULT_CHARACTER_ID };
}

function getActiveCharacterId(): string {
  return readCharacterConfig().activeCharacter || DEFAULT_CHARACTER_ID;
}

let currentScale = 1.0;

function readScale(): number {
  return readCharacterConfig().scale || 1.0;
}

function saveScale(scale: number): void {
  try {
    const config = readCharacterConfig();
    config.scale = scale;
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    log('WARN', 'Failed to save scale:', err);
  }
}

function getScaledSize(): { width: number; height: number } {
  return {
    width: Math.round(WINDOW_SIZE.width * currentScale),
    height: Math.round(WINDOW_SIZE.height * currentScale),
  };
}

interface BundleTarget {
  url: string;
  cacheName: string;
}

/**
 * Build ordered list of bundle URLs to try.
 * Prefers backend-provided URLs from config; falls back to legacy CDN construction.
 */
function getBundleTargets(characterId: string, config: CharacterConfig): BundleTarget[] {
  const modelUrls = config.activeCharacter === characterId ? config.modelUrls : undefined;

  // If backend-provided URLs exist, use them
  if (modelUrls && (modelUrls.fullUrl || modelUrls.baseUrl)) {
    const targets: BundleTarget[] = [];
    if (modelUrls.fullUrl) {
      targets.push({ url: modelUrls.fullUrl, cacheName: 'full_avatar.varie' });
    }
    if (modelUrls.baseUrl) {
      targets.push({ url: modelUrls.baseUrl, cacheName: 'base_avatar.varie' });
    }
    return targets;
  }

  // Legacy fallback: construct URLs from character ID (pre-ISSUE-006 configs / default character)
  log('WARN', `No modelUrls in config for ${characterId}, using legacy CDN fallback`);
  const modelStatus = config.activeCharacter === characterId ? config.publicModelStatus : undefined;
  if (modelStatus === 'base_ready') {
    return [{ url: `${CDN_BASE_FALLBACK}/${characterId}/model/public/base_avatar.varie`, cacheName: 'base_avatar.varie' }];
  }
  return [
    { url: `${CDN_BASE_FALLBACK}/${characterId}/model/public/full_avatar.varie`, cacheName: 'full_avatar.varie' },
    { url: `${CDN_BASE_FALLBACK}/${characterId}/model/public/base_avatar.varie`, cacheName: 'base_avatar.varie' },
  ];
}

async function loadCharacterBundle(characterId: string): Promise<Buffer> {
  const cacheDir = path.join(CHARACTERS_DIR, characterId);
  const config = readCharacterConfig();
  const targets = getBundleTargets(characterId, config);

  log('INFO', `Loading character ${characterId} (targets: ${targets.map(t => t.cacheName).join(', ')})`);

  // Check local cache first
  for (const target of targets) {
    const cachePath = path.join(cacheDir, target.cacheName);
    if (fs.existsSync(cachePath)) {
      log('INFO', `Loading character ${characterId} from cache (${target.cacheName})`);
      return fs.readFileSync(cachePath);
    }
  }

  // Fetch from URL
  for (const target of targets) {
    log('INFO', `Fetching character ${characterId}: ${target.url}`);

    try {
      const response = await fetch(target.url);
      if (!response.ok) {
        log('WARN', `Fetch for ${target.cacheName} failed: ${response.status}`);
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Cache locally
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, target.cacheName), buffer);
      log('INFO', `Cached character ${characterId}/${target.cacheName} (${buffer.length} bytes)`);

      return buffer;
    } catch (err) {
      log('WARN', `Fetch for ${target.cacheName} error:`, err);
      continue;
    }
  }

  throw new Error(`No model available for character ${characterId}`);
}

function createWindow(): void {
  log('INFO', 'Creating window...');

  // Read saved scale
  currentScale = readScale();
  log('INFO', 'Scale:', currentScale);

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  log('INFO', 'Screen size:', screenWidth, 'x', screenHeight);

  const scaledSize = getScaledSize();

  // Position in bottom-right corner
  const x = screenWidth - scaledSize.width - WINDOW_MARGIN;
  const y = screenHeight - scaledSize.height - WINDOW_MARGIN;
  log('INFO', 'Window position:', x, y);

  const windowConfig = {
    width: scaledSize.width,
    height: scaledSize.height,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  };
  log('INFO', 'Window config:', windowConfig);

  mainWindow = new BrowserWindow(windowConfig);
  log('INFO', 'BrowserWindow created');

  // NOTE: We intentionally do NOT call setIgnoreMouseEvents here.
  // This allows the window to receive mouse events for dragging.
  // The tradeoff is that clicks on transparent areas won't pass through to apps behind.
  // See: https://github.com/electron/electron/issues/23042
  log('INFO', 'Window mouse events enabled (no setIgnoreMouseEvents)');

  // Load the renderer
  const htmlPath = path.join(__dirname, '../renderer/index.html');
  log('INFO', 'Loading HTML:', htmlPath);
  mainWindow.loadFile(htmlPath);

  // Log renderer events
  mainWindow.webContents.on('did-finish-load', () => {
    log('INFO', 'Renderer: did-finish-load');
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    log('ERROR', 'Renderer: did-fail-load', errorCode, errorDescription);
  });

  mainWindow.webContents.on('crashed', () => {
    log('ERROR', 'Renderer: CRASHED');
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log('ERROR', 'Renderer: render-process-gone', details);
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levelStr = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] || 'LOG';
    log(`RENDERER:${levelStr}`, message);
  });

  // Prevent window from being closed, hide instead
  mainWindow.on('close', (event) => {
    log('INFO', 'Window close event');
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  log('INFO', 'Window setup complete');
}

/**
 * Locates the Windows tray icon inside the app bundle.
 *
 * Resolution is anchored to the app directory, never to process.cwd(), so it
 * works both from a source checkout and from the packaged app (where the file
 * lives inside app.asar).
 */
function resolveWindowsTrayIconPath(): string {
  const candidates = [
    path.join(app.getAppPath(), 'assets', 'icon.ico'),
    path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    path.join(process.resourcesPath || '', 'assets', 'icon.ico'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable candidate: keep looking.
    }
  }

  return candidates[0];
}

function createTray(): void {
  // Windows needs a real multi-resolution icon; macOS keeps its existing
  // template image behaviour unchanged.
  const icon = process.platform === 'win32'
    ? nativeImage.createFromPath(resolveWindowsTrayIconPath())
    : nativeImage.createEmpty();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Avatar',
      click: () => mainWindow?.show(),
    },
    {
      label: 'Hide Avatar',
      click: () => mainWindow?.hide(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Varie Claude Avatar');
  tray.setContextMenu(contextMenu);
}

function pushStatsUpdate(): void {
  if (!statsTracker || !mainWindow) return;
  mainWindow.webContents.send('stats-update', statsTracker.getStats());
}

function startServices(): void {
  sessionTracker = new SessionTracker();
  // Clean up stale sessions from previous runs
  sessionTracker.cleanupStaleSessions();
  log('INFO', 'Cleaned up stale sessions');

  statsTracker = new StatsTracker(sessionTracker);

  socketServer = new SocketServer(
    sessionTracker,
    (event) => {
      if (event.type === 'reload_character') {
        // Extract character ID from event metadata, or re-read from config
        const characterId = (event.metadata?.characterId as string) || getActiveCharacterId();
        log('INFO', 'Reload character requested:', characterId);
        mainWindow?.webContents.send('load-character', characterId);
      } else {
        // Forward all other events to renderer
        mainWindow?.webContents.send('claude-event', event);

        // Track sessions and push stats updates
        if (event.type === 'session_start') {
          const project = (event.metadata?.project as string) || '';
          statsTracker?.recordSession(project);
          pushStatsUpdate();
        } else if (event.type === 'session_end') {
          pushStatsUpdate();
        }
      }
    }
  );
  socketServer.start();

  // Start global mouse tracking for eye gaze
  mouseTracker = new MouseTracker(16); // ~60fps
  mouseTracker.start((position) => {
    // Send mouse position to renderer for eye tracking
    mainWindow?.webContents.send('mouse-position', position);
  }, mainWindow || undefined);
}

// IPC handlers
ipcMain.on('set-ignore-mouse-events', (_, ignore: boolean, options?: { forward: boolean }) => {
  log('INFO', 'IPC: set-ignore-mouse-events', ignore, options);
  mainWindow?.setIgnoreMouseEvents(ignore, options);
});

// Renderer logging
ipcMain.on('renderer-log', (_, level: string, ...args: unknown[]) => {
  log(`RENDERER:${level}`, ...args);
});

// Character loading IPC
ipcMain.handle('get-active-character-id', () => {
  return getActiveCharacterId();
});

ipcMain.handle('load-character-bundle', async (_, characterId: string) => {
  try {
    const buffer = await loadCharacterBundle(characterId);
    return buffer;
  } catch (err) {
    log('ERROR', `Failed to load character bundle ${characterId}:`, err);
    throw err;
  }
});

// Stats IPC
ipcMain.handle('get-stats', () => {
  return statsTracker?.getStats() ?? { active: 0, today: 0, week: 0, topProjects: [] };
});

ipcMain.handle('reset-stats', () => {
  sessionTracker?.cleanupStaleSessions();
  return statsTracker?.getStats() ?? { active: 0, today: 0, week: 0, topProjects: [] };
});

// Window control: quit app
ipcMain.on('quit-app', () => {
  log('INFO', 'Quit requested from renderer');
  app.isQuitting = true;
  app.quit();
});

// Window minimize state
let isMinimized = false;
const MINIMIZED_HEIGHT = 102; // Just notification area

function toggleWindowMinimize(): void {
  if (!mainWindow) return;

  isMinimized = !isMinimized;
  const fullHeight = Math.round(WINDOW_SIZE.height * currentScale);
  const newHeight = isMinimized ? MINIMIZED_HEIGHT : fullHeight;

  // Get current position and size
  const [x, y] = mainWindow.getPosition();
  const [currentWidth, currentHeight] = mainWindow.getSize();

  // Adjust Y to keep bottom anchored
  const newY = y + (currentHeight - newHeight);

  mainWindow.setBounds({
    x,
    y: newY,
    width: currentWidth,
    height: newHeight,
  });

  // Notify renderer
  mainWindow.webContents.send('minimize-state', isMinimized);
  log('INFO', 'Window minimized:', isMinimized);
}

// Window control: toggle minimize
ipcMain.on('toggle-minimize', () => {
  toggleWindowMinimize();
});

// Scale controls
ipcMain.handle('get-scale', () => {
  return currentScale;
});

ipcMain.on('set-scale', (_, scale: number) => {
  if (![0.8, 1.0, 1.2].includes(scale) || !mainWindow) return;

  log('INFO', 'Setting scale:', scale);
  currentScale = scale;

  const newWidth = Math.round(WINDOW_SIZE.width * scale);
  const newHeight = Math.round(WINDOW_SIZE.height * scale);

  // Anchor bottom-right: adjust position so bottom-right corner stays put
  const [oldX, oldY] = mainWindow.getPosition();
  const [oldWidth, oldHeight] = mainWindow.getSize();
  const newX = oldX + (oldWidth - newWidth);
  const newY = oldY + (oldHeight - newHeight);

  mainWindow.setBounds({ x: newX, y: newY, width: newWidth, height: newHeight });

  // Save and notify renderer
  saveScale(scale);
  mainWindow.webContents.send('scale-changed', scale);

  log('INFO', `Window resized to ${newWidth}x${newHeight}`);
});

// Extend app type to include isQuitting
declare module 'electron' {
  interface App {
    isQuitting?: boolean;
  }
}

app.whenReady().then(() => {
  initLog();
  log('INFO', 'App ready');

  createWindow();
  createTray();
  startServices();

  // One service instance for the whole lifecycle; the platform decides the
  // adapter, and Windows gets the inert one.
  terminalActions = createTerminalActionService(process.platform, {
    log: (level, message) => log(level, message),
  });
  registerTerminalActionIpc({
    ipcMain,
    service: terminalActions,
    findSession: (sessionId: string) => sessionTracker?.getSession(sessionId),
  });

  app.on('activate', () => {
    log('INFO', 'App activate event');
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  socketServer?.stop();
  mouseTracker?.stop();
});

// Handle single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
    }
  });
}
