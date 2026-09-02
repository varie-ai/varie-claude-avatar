import {
  createValidatedTerminalActionService,
  isValidSessionId,
} from './terminal-action-service';
import type {
  TerminalAction,
  TerminalActionResult,
  TerminalActionService,
} from './terminal-action-service';
import { MacOSTerminalActions } from './macos-terminal-actions';
import type { MacOSTerminalActionsDeps } from './macos-terminal-actions';
import { UnsupportedTerminalActions } from './unsupported-terminal-actions';

export * from './terminal-action-service';
export { MacOSTerminalActions } from './macos-terminal-actions';
export { UnsupportedTerminalActions } from './unsupported-terminal-actions';

export type TerminalActionDeps = MacOSTerminalActionsDeps;

/**
 * Picks the adapter for a platform. Only macOS can drive a terminal today;
 * Windows and anything unknown get the inert adapter.
 */
export function selectTerminalActionAdapter(
  platform: string | undefined = process.platform,
  deps: TerminalActionDeps = {}
): TerminalActionService {
  if (platform === 'darwin') {
    return new MacOSTerminalActions(deps);
  }
  return new UnsupportedTerminalActions();
}

/** The composed, runtime-validated service the rest of the app talks to. */
export function createTerminalActionService(
  platform: string | undefined = process.platform,
  deps: TerminalActionDeps = {}
): TerminalActionService {
  return createValidatedTerminalActionService(selectTerminalActionAdapter(platform, deps));
}

/** The narrow slice of ipcMain this boundary needs. */
export interface TerminalActionIpcRegistrar {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ): void;
}

export interface TerminalActionIpcRegistration {
  ipcMain: TerminalActionIpcRegistrar;
  service: TerminalActionService;
  findSession: (sessionId: string) => unknown;
}

// Registration is idempotent per registrar: the handlers must never be added
// twice during the app lifecycle.
const registeredRegistrars = new WeakSet<object>();

/**
 * Registers the two terminal-action channels.
 *
 * Returns false when this registrar already carries them, so a repeated
 * lifecycle event cannot install duplicate handlers.
 */
export function registerTerminalActionIpc(
  registration: TerminalActionIpcRegistration
): boolean {
  const { ipcMain, service, findSession } = registration;

  if (registeredRegistrars.has(ipcMain)) {
    return false;
  }
  registeredRegistrars.add(ipcMain);

  ipcMain.handle('get-terminal-action-capabilities', () => service.capabilities());

  ipcMain.handle(
    'perform-terminal-action',
    async (_event: unknown, action: unknown, sessionId: unknown): Promise<TerminalActionResult> => {
      // An unknown session is refused before the adapter is consulted.
      if (!isValidSessionId(sessionId) || !findSession(sessionId)) {
        return { ok: false, reason: 'session_not_found' };
      }
      return service.perform(action as TerminalAction, sessionId);
    }
  );

  return true;
}
