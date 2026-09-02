import { execFile as nodeExecFile } from 'child_process';
import type {
  TerminalAction,
  TerminalActionCapabilities,
  TerminalActionResult,
  TerminalActionService,
} from './terminal-action-service';

const OSASCRIPT = '/usr/bin/osascript';

export type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  callback: ExecFileCallback
) => unknown;

export interface MacOSTerminalActionsDeps {
  /** Injected so tests never run a real program. */
  execFile?: ExecFileFn;
  writeClipboard?: (text: string) => void;
  log?: (level: string, message: string) => void;
}

const defaultExecFile: ExecFileFn = (file, args, callback) =>
  nodeExecFile(file, args as string[], (error, stdout, stderr) => {
    callback(error, String(stdout ?? ''), String(stderr ?? ''));
  });

function defaultWriteClipboard(text: string): void {
  // Loaded lazily so the adapter stays testable without Electron.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { clipboard } = require('electron') as { clipboard: { writeText(value: string): void } };
  clipboard.writeText(text);
}

// The terminal is discovered by AppleScript itself; no caller-supplied value is
// ever interpolated into the script.
function buildScript(sendReturn: boolean): string {
  const approval = sendReturn
    ? '\n      -- Send Enter to approve (Claude Code default)\n      keystroke return\n'
    : '';

  return `
    tell application "System Events"
      set termApps to {"iTerm2", "iTerm", "Terminal"}
      set foundApp to ""
      repeat with appName in termApps
        if exists (application process appName) then
          set foundApp to appName as string
          exit repeat
        end if
      end repeat

      if foundApp is "" then
        set foundApp to "Terminal"
      end if

      -- Activate the terminal and bring to front
      tell application foundApp
        activate
        delay 0.15
      end tell
${approval}    end tell
  `;
}

const TERMINAL_MISSING_PATTERNS: readonly RegExp[] = [
  /-600\b/,
  /isn.?t running/i,
  /can.?t get application process/i,
];

const AUTOMATION_DENIED_PATTERNS: readonly RegExp[] = [
  /-1743\b/,
  /-25211\b/,
  /not authorized/i,
  /not allowed/i,
  /assistive access/i,
  /accessibilit/i,
];

/**
 * Classifies an osascript failure.
 *
 * Anything unrecognised is reported as automation_denied: on macOS a failing
 * System Events script is overwhelmingly a permission problem, and the caller
 * only ever sees this reason, never the raw text.
 */
function classifyFailure(detail: string): 'terminal_not_found' | 'automation_denied' {
  if (AUTOMATION_DENIED_PATTERNS.some((pattern) => pattern.test(detail))) {
    return 'automation_denied';
  }
  if (TERMINAL_MISSING_PATTERNS.some((pattern) => pattern.test(detail))) {
    return 'terminal_not_found';
  }
  return 'automation_denied';
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Existing macOS behaviour, moved out of index.ts unchanged: copy 'y' to the
 * clipboard as a fallback, bring the terminal to the front, and press Enter for
 * an approval. Focus performs the same activation without sending any input.
 */
export class MacOSTerminalActions implements TerminalActionService {
  private readonly execFile: ExecFileFn;
  private readonly writeClipboard: (text: string) => void;
  private readonly log: (level: string, message: string) => void;

  constructor(deps: MacOSTerminalActionsDeps = {}) {
    this.execFile = deps.execFile ?? defaultExecFile;
    this.writeClipboard = deps.writeClipboard ?? defaultWriteClipboard;
    this.log = deps.log ?? (() => {});
  }

  capabilities(): TerminalActionCapabilities {
    return { focus: true, approve: true };
  }

  async perform(action: TerminalAction, sessionId: string): Promise<TerminalActionResult> {
    if (action === 'approve') {
      try {
        this.writeClipboard('y');
      } catch (error) {
        this.log('WARN', `Clipboard fallback failed: ${describe(error)}`);
      }
    }

    try {
      await this.runScript(buildScript(action === 'approve'));
      this.log('INFO', `Terminal ${action} performed for session ${sessionId}`);
      return { ok: true };
    } catch (error) {
      const detail = describe(error);
      // The detail stays local; the caller only receives a stable reason.
      this.log('WARN', `Terminal ${action} failed: ${detail}`);
      return { ok: false, reason: classifyFailure(detail) };
    }
  }

  private runScript(script: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        // Argument vector only: no shell, no concatenated command string.
        this.execFile(OSASCRIPT, ['-e', script], (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(stderr ? `${error.message} ${stderr}` : error.message));
            return;
          }
          resolve();
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
