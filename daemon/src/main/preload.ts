import { contextBridge, ipcRenderer } from 'electron';
import type {
  TerminalAction,
  TerminalActionCapabilities,
  TerminalActionResult,
} from './terminal-actions/terminal-action-service';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Receive events from main process
  onClaudeEvent: (callback: (event: unknown) => void) => {
    ipcRenderer.on('claude-event', (_event, data) => callback(data));
  },

  // Receive global mouse position for eye tracking
  onMousePosition: (callback: (position: unknown) => void) => {
    ipcRenderer.on('mouse-position', (_event, data) => callback(data));
  },

  // Request character data
  getCharacterPath: () => ipcRenderer.invoke('get-character-path'),

  // Window controls
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => {
    ipcRenderer.send('set-ignore-mouse-events', ignore, options);
  },

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('save-settings', settings),

  // Terminal actions (capability driven; Windows v1 reports none)
  getTerminalActionCapabilities: () =>
    ipcRenderer.invoke('get-terminal-action-capabilities') as Promise<TerminalActionCapabilities>,
  performTerminalAction: (action: TerminalAction, sessionId: string) =>
    ipcRenderer.invoke('perform-terminal-action', action, sessionId) as Promise<TerminalActionResult>,

  // Window controls
  quit: () => ipcRenderer.send('quit-app'),
  toggleMinimize: () => ipcRenderer.send('toggle-minimize'),

  // Receive minimize state changes
  onMinimizeState: (callback: (minimized: boolean) => void) => {
    ipcRenderer.on('minimize-state', (_event, minimized) => callback(minimized));
  },

  // Scale controls
  getScale: () => ipcRenderer.invoke('get-scale') as Promise<number>,
  setScale: (scale: number) => ipcRenderer.send('set-scale', scale),
  onScaleChanged: (callback: (scale: number) => void) => {
    ipcRenderer.on('scale-changed', (_event, scale) => callback(scale));
  },

  // Character loading
  getActiveCharacterId: () => ipcRenderer.invoke('get-active-character-id') as Promise<string>,
  loadCharacterBundle: (id: string) => ipcRenderer.invoke('load-character-bundle', id) as Promise<Buffer>,
  onLoadCharacter: (callback: (characterId: string) => void) => {
    ipcRenderer.on('load-character', (_event, characterId) => callback(characterId));
  },

  // Stats
  getStats: () => ipcRenderer.invoke('get-stats'),
  resetStats: () => ipcRenderer.invoke('reset-stats'),
  onStatsUpdate: (callback: (stats: unknown) => void) => {
    ipcRenderer.on('stats-update', (_event, stats) => callback(stats));
  },

  // Logging to main process (for debugging)
  log: (level: string, ...args: unknown[]) => ipcRenderer.send('renderer-log', level, ...args),
});

// Type definitions for renderer
declare global {
  interface Window {
    electronAPI: {
      onClaudeEvent: (callback: (event: unknown) => void) => void;
      onMousePosition: (callback: (position: unknown) => void) => void;
      getCharacterPath: () => Promise<string>;
      setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => void;
      getSettings: () => Promise<unknown>;
      saveSettings: (settings: unknown) => Promise<void>;
      getTerminalActionCapabilities: () => Promise<TerminalActionCapabilities>;
      performTerminalAction: (
        action: TerminalAction,
        sessionId: string
      ) => Promise<TerminalActionResult>;
      getActiveCharacterId: () => Promise<string>;
      loadCharacterBundle: (id: string) => Promise<Buffer>;
      onLoadCharacter: (callback: (characterId: string) => void) => void;
      quit: () => void;
      toggleMinimize: () => void;
      onMinimizeState: (callback: (minimized: boolean) => void) => void;
      getScale: () => Promise<number>;
      setScale: (scale: number) => void;
      onScaleChanged: (callback: (scale: number) => void) => void;
      getStats: () => Promise<unknown>;
      resetStats: () => Promise<unknown>;
      onStatsUpdate: (callback: (stats: unknown) => void) => void;
      log: (level: string, ...args: unknown[]) => void;
    };
  }
}
