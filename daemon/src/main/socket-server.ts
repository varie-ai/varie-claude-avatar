import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionTracker } from './session-tracker';

export interface ClaudeEvent {
  type: 'session_start' | 'session_end' | 'approval_needed' | 'tool_complete' | 'stop' | 'subagent_stop' | 'user_prompt' | 'notification' | 'attention' | 'reload_character';
  sessionId?: string;
  tool?: string;
  message?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

type EventCallback = (event: ClaudeEvent) => void;

export class SocketServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private sessionTracker: SessionTracker;
  private onEvent: EventCallback;

  constructor(sessionTracker: SessionTracker, onEvent: EventCallback) {
    this.sessionTracker = sessionTracker;
    this.onEvent = onEvent;

    // Socket path - use /tmp on macOS/Linux
    this.socketPath = process.platform === 'win32'
      ? '\\\\.\\pipe\\varie-claude-avatar'
      : '/tmp/varie-claude-avatar.sock';
  }

  start(): void {
    // Clean up existing socket file
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    this.server = net.createServer((socket) => {
      let buffer = '';

      socket.on('data', (data) => {
        buffer += data.toString();

        // Process complete JSON messages (newline-delimited)
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            this.handleMessage(line.trim(), socket);
          }
        }
      });

      socket.on('error', (err) => {
        console.error('Socket error:', err);
      });
    });

    this.server.listen(this.socketPath, () => {
      console.log(`Socket server listening on ${this.socketPath}`);

      // Make socket accessible
      if (process.platform !== 'win32') {
        fs.chmodSync(this.socketPath, 0o777);
      }
    });

    this.server.on('error', (err) => {
      console.error('Server error:', err);
    });

    // Write socket path to known location for CLI to find
    this.writeSocketInfo();
  }

  stop(): void {
    this.server?.close();
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
  }

  private handleMessage(message: string, socket: net.Socket): void {
    try {
      const event = JSON.parse(message) as ClaudeEvent;
      event.timestamp = event.timestamp || Date.now();

      console.log('Received event:', event.type, event.sessionId);

      // Auto-register unknown sessions (handles missed session_start,
      // e.g. daemon launched mid-session after background install,
      // or daemon restarted while sessions were active)
      let autoRegistered = false;
      if (event.sessionId && event.type !== 'session_end' && event.type !== 'session_start') {
        if (!this.sessionTracker.getSession(event.sessionId)) {
          console.log('Auto-registering unknown session:', event.sessionId);
          this.sessionTracker.addSession(event.sessionId, event.metadata);
          autoRegistered = true;
        }
      }

      // Update session tracker
      switch (event.type) {
        case 'session_start':
          if (event.sessionId) {
            this.sessionTracker.addSession(event.sessionId, event.metadata);
          }
          break;
        case 'session_end':
          if (event.sessionId) {
            this.sessionTracker.removeSession(event.sessionId);
          }
          break;
        case 'approval_needed':
          if (event.sessionId) {
            this.sessionTracker.addPendingApproval(event.sessionId, event.tool || 'unknown');
          }
          break;
        case 'tool_complete':
          if (event.sessionId) {
            this.sessionTracker.clearPendingApproval(event.sessionId);
          }
          break;
      }

      // If session was auto-registered, emit synthetic session_start
      // so stats tracker records it and UI updates active count
      if (autoRegistered) {
        this.onEvent({
          type: 'session_start',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          metadata: event.metadata,
        });
      }

      // Notify renderer
      this.onEvent(event);

      // Send acknowledgment
      socket.write(JSON.stringify({ status: 'ok', received: event.type }) + '\n');
    } catch (err) {
      console.error('Failed to parse message:', err);
      socket.write(JSON.stringify({ status: 'error', message: 'Invalid JSON' }) + '\n');
    }
  }

  private writeSocketInfo(): void {
    const configDir = path.join(os.homedir(), '.varie-claude-avatar');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const infoPath = path.join(configDir, 'daemon.json');
    fs.writeFileSync(infoPath, JSON.stringify({
      socketPath: this.socketPath,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }, null, 2));
  }
}
