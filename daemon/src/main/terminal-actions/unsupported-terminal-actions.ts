import type {
  TerminalActionCapabilities,
  TerminalActionResult,
  TerminalActionService,
} from './terminal-action-service';

/**
 * Adapter for every platform that cannot drive a terminal yet, Windows v1
 * included. It reports no capability and executes nothing: no command, no
 * clipboard write, no input.
 */
export class UnsupportedTerminalActions implements TerminalActionService {
  capabilities(): TerminalActionCapabilities {
    return { focus: false, approve: false };
  }

  async perform(): Promise<TerminalActionResult> {
    return { ok: false, reason: 'unsupported' };
  }
}
