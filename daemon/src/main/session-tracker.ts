import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** A stable identifier is usable only when it is a string with content. */
function usableString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Working directory of a session.
 *
 * Precedence: the canonical `cwd`, then the legacy `projectPath` that older
 * clients are the only ones to send, then nothing. An unusable canonical value
 * never shadows a usable legacy one, so `cwd: ''` cannot erase a real path.
 */
function resolveCwd(metadata?: Record<string, unknown>): string | undefined {
  return usableString(metadata?.cwd) ?? usableString(metadata?.projectPath);
}

export interface Session {
  id: string;
  startedAt: number;
  terminal?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
}

export interface PendingApproval {
  sessionId: string;
  tool: string;
  requestedAt: number;
}

export interface SessionState {
  sessions: Session[];
  pendingApprovals: PendingApproval[];
  lastUpdated: number;
}

export class SessionTracker {
  private state: SessionState;
  private statePath: string;

  /**
   * `configDir` exists so tests can point a tracker at a temporary directory.
   * The default is the real per-user state directory, unchanged.
   */
  constructor(configDir: string = path.join(os.homedir(), '.varie-claude-avatar')) {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    this.statePath = path.join(configDir, 'state.json');

    // Load existing state or create new
    this.state = this.loadState();
  }

  private loadState(): SessionState {
    try {
      if (fs.existsSync(this.statePath)) {
        const data = fs.readFileSync(this.statePath, 'utf-8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.error('Failed to load state:', err);
    }

    return {
      sessions: [],
      pendingApprovals: [],
      lastUpdated: Date.now(),
    };
  }

  private saveState(): void {
    this.state.lastUpdated = Date.now();
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('Failed to save state:', err);
    }
  }

  addSession(id: string, metadata?: Record<string, unknown>): void {
    // Remove existing session with same ID
    this.state.sessions = this.state.sessions.filter(s => s.id !== id);

    this.state.sessions.push({
      id,
      startedAt: Date.now(),
      terminal: usableString(metadata?.terminal),
      cwd: resolveCwd(metadata),
      metadata,
    });

    this.saveState();
  }

  removeSession(id: string): void {
    this.state.sessions = this.state.sessions.filter(s => s.id !== id);
    this.state.pendingApprovals = this.state.pendingApprovals.filter(a => a.sessionId !== id);
    this.saveState();
  }

  getSession(id: string): Session | undefined {
    return this.state.sessions.find(s => s.id === id);
  }

  getAllSessions(): Session[] {
    return [...this.state.sessions];
  }

  getActiveSessions(): Session[] {
    // Consider sessions older than 24h as stale
    const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;
    return this.state.sessions.filter(s => s.startedAt > staleThreshold);
  }

  addPendingApproval(sessionId: string, tool: string): void {
    // Remove existing approval for same session
    this.state.pendingApprovals = this.state.pendingApprovals.filter(
      a => a.sessionId !== sessionId
    );

    this.state.pendingApprovals.push({
      sessionId,
      tool,
      requestedAt: Date.now(),
    });

    this.saveState();
  }

  clearPendingApproval(sessionId: string): void {
    this.state.pendingApprovals = this.state.pendingApprovals.filter(
      a => a.sessionId !== sessionId
    );
    this.saveState();
  }

  getPendingApprovals(): PendingApproval[] {
    return [...this.state.pendingApprovals];
  }

  hasPendingApprovals(): boolean {
    return this.state.pendingApprovals.length > 0;
  }

  cleanupStaleSessions(): void {
    // On daemon startup, clear ALL sessions. When the daemon restarts the
    // socket connection breaks, so previous sessions are effectively dead.
    // Only sessions that send session_start to this daemon instance are active.
    const hadData = this.state.sessions.length > 0 || this.state.pendingApprovals.length > 0;

    this.state.sessions = [];
    this.state.pendingApprovals = [];

    if (hadData) {
      this.saveState();
    }
  }
}
