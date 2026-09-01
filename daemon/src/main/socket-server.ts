import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionTracker } from './session-tracker';
import { getIpcEndpoint } from '../../../shared/ipc-endpoint.cjs';

export interface ClaudeEvent {
  protocolVersion?: number;
  type: 'session_start' | 'session_end' | 'approval_needed' | 'tool_complete' |
    'stop' | 'subagent_stop' | 'user_prompt' | 'notification' | 'attention' |
    'reload_character' | 'question' | 'plan_complete' | 'question_complete';
  sessionId?: string;
  tool?: string;
  message?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

const VALID_EVENT_TYPES = new Set([
  'session_start', 'session_end', 'approval_needed', 'tool_complete',
  'stop', 'subagent_stop', 'user_prompt', 'notification', 'attention',
  'reload_character', 'question', 'plan_complete', 'question_complete'
]);

const MAX_FRAME_SIZE = 1024 * 1024; // 1 MiB

type EventCallback = (event: ClaudeEvent) => void;

export class SocketServer {
  private server: net.Server | null = null;
  private socketPath: string;

  constructor(
    private sessionTracker: SessionTracker,
    private onEvent: (event: ClaudeEvent) => void,
    testEndpoint?: string,
    private disableConfigWrite = false
  ) {
    this.socketPath = testEndpoint ?? getIpcEndpoint();
  }

  getEndpoint(): string {
    return this.socketPath;
  }

  start(): void {
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    this.server = net.createServer((socket) => {
      let rawBuffer = Buffer.alloc(0);
      let overflowed = false;

      socket.on('data', (data: Buffer) => {
        if (overflowed) return;

        rawBuffer = Buffer.concat([rawBuffer, data]);

        let newlineIndex;
        while ((newlineIndex = rawBuffer.indexOf(10)) !== -1) {
          if (newlineIndex > MAX_FRAME_SIZE) {
            overflowed = true;
            socket.write(JSON.stringify({ status: 'error', code: 'message_too_large' }) + '\n', () => socket.destroy());
            return;
          }

          const frameBuffer = rawBuffer.subarray(0, newlineIndex);
          rawBuffer = rawBuffer.subarray(newlineIndex + 1);

          const lineStr = frameBuffer.toString('utf8').trim();
          if (lineStr) {
            this.handleMessage(lineStr, socket);
          }
        }

        if (rawBuffer.length > MAX_FRAME_SIZE) {
          overflowed = true;
          socket.write(JSON.stringify({ status: 'error', code: 'message_too_large' }) + '\n', () => socket.destroy());
        }
      });

      socket.on('error', (err) => {
        console.error('Socket error:', err);
      });
    });

    this.server.listen(this.socketPath, () => {
      if (process.platform !== 'win32') {
        fs.chmodSync(this.socketPath, 0o777);
      }
      this.writeSocketInfo();
    });

    this.server.on('error', (err) => {
      console.error('Server error:', err);
    });
  }

  stop(): void {
    this.server?.close();
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
  }

  private handleMessage(message: string, socket: net.Socket): void {
    let event: any;
    try {
      event = JSON.parse(message);
    } catch (err) {
      socket.write(JSON.stringify({ status: 'error', code: 'invalid_json' }) + '\n');
      return;
    }

    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      socket.write(JSON.stringify({ status: 'error', code: 'invalid_event' }) + '\n');
      return;
    }

    if ('protocolVersion' in event && event.protocolVersion !== null) {
      if (event.protocolVersion !== 1) {
        socket.write(JSON.stringify({ status: 'error', code: 'unsupported_protocol' }) + '\n');
        return;
      }
    } else if ('protocolVersion' in event && event.protocolVersion === null) {
      socket.write(JSON.stringify({ status: 'error', code: 'unsupported_protocol' }) + '\n');
      return;
    }

    if (!event.type || typeof event.type !== 'string' || !VALID_EVENT_TYPES.has(event.type)) {
      socket.write(JSON.stringify({ status: 'error', code: 'invalid_event' }) + '\n');
      return;
    }
    if (event.sessionId !== undefined && typeof event.sessionId !== 'string') {
      socket.write(JSON.stringify({ status: 'error', code: 'invalid_event' }) + '\n');
      return;
    }
    if (event.tool !== undefined && typeof event.tool !== 'string') {
      socket.write(JSON.stringify({ status: 'error', code: 'invalid_event' }) + '\n');
      return;
    }
    if (event.message !== undefined && typeof event.message !== 'string') {
      socket.write(JSON.stringify({ status: 'error', code: 'invalid_event' }) + '\n');
      return;
    }
    if (event.timestamp !== undefined && (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp))) {
      socket.write(JSON.stringify({ status: 'error', code: 'invalid_event' }) + '\n');
      return;
    }
    if (event.metadata !== undefined && (!event.metadata || typeof event.metadata !== 'object' || Array.isArray(event.metadata))) {
      socket.write(JSON.stringify({ status: 'error', code: 'invalid_event' }) + '\n');
      return;
    }

    const typedEvent = event as ClaudeEvent;
    typedEvent.timestamp = typeof typedEvent.timestamp === 'number' ? typedEvent.timestamp : Date.now();

    try {
      let autoRegistered = false;
      if (typedEvent.sessionId && typedEvent.type !== 'session_end' && typedEvent.type !== 'session_start') {
        if (!this.sessionTracker.getSession(typedEvent.sessionId)) {
          this.sessionTracker.addSession(typedEvent.sessionId, typedEvent.metadata);
          autoRegistered = true;
        }
      }

      switch (typedEvent.type) {
        case 'session_start':
          if (typedEvent.sessionId) this.sessionTracker.addSession(typedEvent.sessionId, typedEvent.metadata);
          break;
        case 'session_end':
          if (typedEvent.sessionId) this.sessionTracker.removeSession(typedEvent.sessionId);
          break;
        case 'approval_needed':
          if (typedEvent.sessionId) this.sessionTracker.addPendingApproval(typedEvent.sessionId, typedEvent.tool || 'unknown');
          break;
        case 'tool_complete':
          if (typedEvent.sessionId) this.sessionTracker.clearPendingApproval(typedEvent.sessionId);
          break;
      }

      if (autoRegistered) {
        this.onEvent({
          type: 'session_start',
          sessionId: typedEvent.sessionId,
          timestamp: typedEvent.timestamp,
          metadata: typedEvent.metadata,
        });
      }

      this.onEvent(typedEvent);
      
      if (socket.writable) {
        socket.write(JSON.stringify({ status: 'ok', received: typedEvent.type }) + '\n');
      }
    } catch (err) {
      console.error('Event listener exception:', err);
      if (socket.writable) {
        socket.write(JSON.stringify({ status: 'error', code: 'internal_error' }) + '\n');
      }
    }
  }

  private writeSocketInfo(): void {
    if (this.disableConfigWrite) return;
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
