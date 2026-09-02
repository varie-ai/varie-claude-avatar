/**
 * Terminal-action contract.
 *
 * Windows v1 ships no focus and no approve, but the boundary is stable: a later
 * release can add a Windows adapter behind this same interface without touching
 * the renderer, the preload surface or the IPC channels.
 */

export type TerminalAction = 'focus' | 'approve';

export interface TerminalActionCapabilities {
  focus: boolean;
  approve: boolean;
}

export interface TerminalActionResult {
  ok: boolean;
  reason?: 'unsupported' | 'session_not_found' | 'terminal_not_found' | 'automation_denied';
}

export interface TerminalActionService {
  capabilities(): TerminalActionCapabilities;
  perform(
    action: TerminalAction,
    sessionId: string
  ): Promise<TerminalActionResult>;
}

const TERMINAL_ACTIONS: readonly string[] = ['focus', 'approve'];

/** Runtime guard: the declared type is not a promise about what IPC delivers. */
export function isTerminalAction(value: unknown): value is TerminalAction {
  return typeof value === 'string' && TERMINAL_ACTIONS.includes(value);
}

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const TERMINAL_ACTION_REASONS: readonly string[] = [
  'unsupported',
  'session_not_found',
  'terminal_not_found',
  'automation_denied',
];

/**
 * Runtime guard for the closed reason taxonomy.
 *
 * An adapter is not trusted to honour its declared types: a TypeScript cast is
 * not validation, so anything outside these four strings is refused here.
 */
function isTerminalActionReason(
  value: unknown
): value is NonNullable<TerminalActionResult['reason']> {
  return typeof value === 'string' && TERMINAL_ACTION_REASONS.includes(value);
}

/**
 * Reduces an adapter answer to the exact contract shape, so what crosses IPC is
 * always stable and serializable.
 *
 * Only a reason from the closed taxonomy survives; anything else — an unknown
 * string, a non-string value, or no reason at all — becomes 'unsupported'. The
 * returned object is rebuilt from scratch, so no adapter property travels on.
 */
export function normalizeTerminalActionResult(value: unknown): TerminalActionResult {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as TerminalActionResult;
    if (candidate.ok === true) return { ok: true };
    if (candidate.ok === false) {
      const reason: unknown = candidate.reason;
      return {
        ok: false,
        reason: isTerminalActionReason(reason) ? reason : 'unsupported',
      };
    }
  }
  return { ok: false, reason: 'unsupported' };
}

/**
 * Wraps an adapter with the public boundary: invalid input is refused here and
 * never reaches the adapter, and an adapter that throws cannot escape.
 */
export function createValidatedTerminalActionService(
  adapter: TerminalActionService
): TerminalActionService {
  return {
    capabilities(): TerminalActionCapabilities {
      const capabilities = adapter.capabilities();
      // A fresh object every time: a caller cannot mutate the adapter state.
      return {
        focus: capabilities?.focus === true,
        approve: capabilities?.approve === true,
      };
    },

    async perform(action: TerminalAction, sessionId: string): Promise<TerminalActionResult> {
      const requestedAction: unknown = action;
      const requestedSessionId: unknown = sessionId;

      if (!isTerminalAction(requestedAction)) {
        return { ok: false, reason: 'unsupported' };
      }
      if (!isValidSessionId(requestedSessionId)) {
        return { ok: false, reason: 'session_not_found' };
      }

      try {
        return normalizeTerminalActionResult(
          await adapter.perform(requestedAction, requestedSessionId)
        );
      } catch {
        return { ok: false, reason: 'unsupported' };
      }
    },
  };
}
