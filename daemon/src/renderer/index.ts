/**
 * Renderer Entry Point
 *
 * Handles character rendering and notification display.
 * This is the main script that runs in the Electron renderer process.
 */

import { SpineCharacter } from './character/spine-character';
import { NotificationManager } from './notifications/notification-manager';

interface ClaudeEvent {
  type: 'session_start' | 'session_end' | 'approval_needed' | 'tool_complete' | 'stop' | 'subagent_stop' | 'user_prompt' | 'notification' | 'attention' | 'question' | 'plan_complete' | 'question_complete';
  sessionId?: string;
  tool?: string;
  message?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

class App {
  private character: SpineCharacter | null = null;
  private notifications: NotificationManager;
  private characterContainer: HTMLElement;
  private activeCharacterId: string = 'vespera_b02d095ae396';
  private currentScale: number = 1.0;

  constructor() {
    this.characterContainer = document.getElementById('character-container') as HTMLElement;
    this.notifications = new NotificationManager(
      document.getElementById('notification-container') as HTMLElement
    );

    this.init();
  }

  private async init(): Promise<void> {
    console.log('[App] Initializing...');

    const api = (window as any).electronAPI;

    // Set up event listeners from main process (if available)
    if (api) {
      api.onClaudeEvent((event: ClaudeEvent) => {
        this.handleClaudeEvent(event);
      });

      // Listen for character reload events (from socket reload_character)
      api.onLoadCharacter((characterId: string) => {
        console.log('[App] Received load-character event:', characterId);
        this.loadCharacterById(characterId);
      });

      // Listen for scale changes — CSS transform scaling (no WebGL buffer recreation)
      api.onScaleChanged((scale: number) => {
        console.log('[App] Scale changed:', scale);
        this.currentScale = scale;
        this.characterContainer.style.height = `${Math.round(540 * scale)}px`;
        this.character?.setScale(scale);
      });

      // Apply initial scale to character container
      this.currentScale = await api.getScale();
      if (this.currentScale !== 1.0) {
        this.characterContainer.style.height = `${Math.round(540 * this.currentScale)}px`;
      }
    }

    // Set up mouse tracking for eye gaze
    this.setupMouseTracking();

    // Load active character (from config or default)
    try {
      const characterId = api ? await api.getActiveCharacterId() : 'vespera_b02d095ae396';
      console.log('[App] Active character:', characterId);
      await this.loadCharacterById(characterId);
    } catch (err) {
      console.error('[App] Failed to get active character, loading default:', err);
      await this.loadCharacterById('vespera_b02d095ae396');
    }

    console.log('[App] Initialization complete');
  }

  private async loadCharacterById(characterId: string): Promise<void> {
    try {
      console.log('[App] Loading character:', characterId);
      this.activeCharacterId = characterId;

      const api = (window as any).electronAPI;
      if (!api) {
        console.error('[App] No electronAPI available');
        return;
      }

      // Get character bundle from main process (cached or CDN)
      const buffer = await api.loadCharacterBundle(characterId);
      const blob = new Blob([buffer]);
      const url = URL.createObjectURL(blob);

      try {
        if (!this.character) {
          this.character = new SpineCharacter(this.characterContainer);
        }
        await this.character.load(url);
        this.character.setScale(this.currentScale);
        console.log('[App] Character loaded successfully:', characterId);
      } finally {
        URL.revokeObjectURL(url);
      }

    } catch (err) {
      console.error('[App] Failed to load character:', err);
      this.notifications.show({
        type: 'info',
        title: 'Error',
        body: `Failed to load character: ${(err as Error).message}`,
      });
    }
  }

  private setupMouseTracking(): void {
    // Use global mouse tracking from main process (Electron)
    if (typeof window !== 'undefined' && (window as any).electronAPI?.onMousePosition) {
      (window as any).electronAPI.onMousePosition((position: {
        relativeX: number;
        relativeY: number;
        normalizedX: number;
        normalizedY: number;
      }) => {
        if (this.character && this.character.isLoaded()) {
          // Use relative position (distance from overlay window center)
          this.character.setLookTarget(position.relativeX, position.relativeY);
        }
      });
      console.log('[App] Using global screen mouse tracking');
    } else {
      // Fallback: local mouse tracking (for browser testing)
      document.addEventListener('mousemove', (e) => {
        if (this.character && this.character.isLoaded()) {
          const rect = this.characterContainer.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
          const y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
          this.character.setLookTarget(x, -y);
        }
      });
      console.log('[App] Using local window mouse tracking (browser mode)');
    }
  }

  private handleClaudeEvent(event: ClaudeEvent): void {
    console.log('[App] Received Claude event:', JSON.stringify(event));

    switch (event.type) {
      case 'approval_needed':
        this.notifications.show({
          type: 'approval',
          title: 'Approval Needed',
          body: `${event.tool || 'Action'} requires approval`,
          tool: event.tool || '',
          sessionId: event.sessionId,
          metadata: {
            project: (event.metadata?.project as string) || undefined,
            summary: (event.metadata?.summary as string) || undefined,
            commandSummary: (event.metadata?.commandSummary as string) || undefined,
            filePath: (event.metadata?.filePath as string) || undefined,
          },
        });
        // Randomly choose between curious (?) and surprised (!)
        const approvalExpressions = ['curious', 'surprised'];
        const expr = approvalExpressions[Math.floor(Math.random() * approvalExpressions.length)];
        this.character?.setExpression(expr);
        this.character?.setSpeaking(true);
        // Speaking duration: 1500ms base (+50%), with 30% variance (1050-1950ms)
        const approvalSpeakDuration = 1500 * (0.7 + Math.random() * 0.6);
        setTimeout(() => this.character?.setSpeaking(false), approvalSpeakDuration);
        // Clear expression after 3 seconds
        setTimeout(() => this.character?.clearExpression(), 3000);
        break;

      case 'tool_complete':
        // Dismiss matching approval notification by tool + projectPath + summary (sessionIds differ between events)
        const completedTool = event.tool || '';
        const completedSummary = (event.metadata?.summary as string) || (event.metadata?.commandSummary as string) || '';
        const completedProjectPath = (event.metadata?.projectPath as string) || '';
        if (completedTool) {
          this.notifications.dismissByToolAndSummary(completedTool, completedSummary, completedProjectPath);
        }
        this.character?.setExpression('happy');
        setTimeout(() => this.character?.clearExpression(), 2000);
        break;

      case 'stop':
        const projectName = (event.metadata?.project as string) || '';
        this.notifications.show({
          type: 'complete',
          title: 'Task Complete',
          body: projectName ? `${projectName}: Claude finished` : 'Claude finished',
          sessionId: event.sessionId,
        });
        this.character?.setExpression('happy');
        this.character?.setSpeaking(true);
        // Speaking duration: 2250ms base (+50%), with 30% variance (1575-2925ms)
        const stopSpeakDuration = 2250 * (0.7 + Math.random() * 0.6);
        setTimeout(() => {
          this.character?.setSpeaking(false);
          this.character?.clearExpression();
        }, stopSpeakDuration);
        break;

      case 'session_start':
        console.log('[App] Session started:', event.sessionId);
        break;

      case 'session_end':
        if (event.sessionId) {
          this.notifications.dismissBySession(event.sessionId);
        }
        break;

      case 'notification':
        // Skip showing transient notification if there's ANY pending approval
        // (Claude sends focus reminders which would duplicate the approval notification)
        if (this.notifications.hasAnyPendingApproval()) {
          console.log('[App] Skipping notification - already have pending approval');
          break;
        }
        // Treat as attention notification - show project + "Claude needs attention!"
        const notifProject = (event.metadata?.project as string) || '';
        this.notifications.show({
          type: 'attention',
          title: notifProject,
          body: 'Claude needs attention!',
          sessionId: event.sessionId,
        });
        // Show curious expression
        this.character?.setExpression('curious');
        setTimeout(() => this.character?.clearExpression(), 2000);
        break;

      case 'subagent_stop':
        // Subagent finished - brief happy expression, no notification (too noisy)
        this.character?.setExpression('happy');
        setTimeout(() => this.character?.clearExpression(), 1500);
        break;

      case 'user_prompt':
        // User submitted a prompt - dismiss any attention notifications
        this.notifications.dismissByType('attention');
        // Show "thinking" expression
        this.character?.setExpression('curious');
        // Clear after a short time (Claude will send other events as it works)
        setTimeout(() => this.character?.clearExpression(), 2000);
        break;

      case 'attention':
        // Claude needs user attention (idle_prompt) - show brief notification
        // Skip if there's already a pending approval notification
        if (this.notifications.hasAnyPendingApproval()) {
          console.log('[App] Skipping attention notification - already have pending approval');
          break;
        }
        const attentionProject = (event.metadata?.project as string) || '';
        const attentionBody = (event.metadata?.summary as string) || 'Claude needs attention!';
        this.notifications.show({
          type: 'info',
          title: attentionProject,
          body: attentionProject ? `${attentionProject}: ${attentionBody}` : attentionBody,
          sessionId: event.sessionId,
        });
        // Show curious expression briefly
        this.character?.setExpression('curious');
        setTimeout(() => this.character?.clearExpression(), 2000);
        break;

      case 'question':
        // Claude is asking the user a question (AskUserQuestion tool)
        const questionProject = (event.metadata?.project as string) || '';
        this.notifications.show({
          type: 'question',
          title: questionProject || 'Question',
          body: (event.metadata?.summary as string) || 'Claude has a question for you',
          sessionId: event.sessionId,
        });
        // Show curious expression
        this.character?.setExpression('curious');
        this.character?.setSpeaking(true);
        const questionSpeakDuration = 1500 * (0.7 + Math.random() * 0.6);
        setTimeout(() => this.character?.setSpeaking(false), questionSpeakDuration);
        setTimeout(() => this.character?.clearExpression(), 3000);
        break;

      case 'plan_complete':
        // Plan was approved/rejected - dismiss plan notification
        this.notifications.dismissByType('plan');
        this.character?.setExpression('happy');
        setTimeout(() => this.character?.clearExpression(), 2000);
        break;

      case 'question_complete':
        // Question was answered - dismiss question notification
        this.notifications.dismissByType('question');
        this.character?.setExpression('happy');
        setTimeout(() => this.character?.clearExpression(), 2000);
        break;
    }
  }
}

// Window controls - show when mouse is above character area
function initWindowControls(): void {
  const controls = document.getElementById('window-controls');
  const characterContainer = document.getElementById('character-container');
  const btnMinimize = document.getElementById('btn-minimize');
  const btnClose = document.getElementById('btn-close');

  if (!controls) return;

  let hideTimeout: ReturnType<typeof setTimeout> | null = null;
  let controlsVisible = false;

  const showControls = () => {
    if (controlsVisible) return;
    controlsVisible = true;
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    controls.classList.add('visible');
  };

  const hideControls = () => {
    if (!controlsVisible) return;
    controlsVisible = false;
    hideTimeout = setTimeout(() => {
      controls.classList.remove('visible');
    }, 500); // Delay before hiding
  };

  // Keep controls visible when hovering over them
  controls.addEventListener('mouseenter', () => {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  });

  // Use global mouse tracking to detect when above character
  // Character container is 450px at bottom, window is 515px
  // Show controls when mouse is in top ~15% of window (above character's head)
  const CHARACTER_TOP_THRESHOLD = 0.15;

  if ((window as any).electronAPI?.onMousePosition) {
    (window as any).electronAPI.onMousePosition((position: {
      isInWindow: boolean;
      windowRelativeY: number;
    }) => {
      if (position.isInWindow && position.windowRelativeY < CHARACTER_TOP_THRESHOLD) {
        showControls();
      } else if (!controls.matches(':hover')) {
        hideControls();
      }
    });
  }

  // Close button
  btnClose?.addEventListener('click', () => {
    (window as any).electronAPI?.quit();
  });

  // Minimize button
  btnMinimize?.addEventListener('click', () => {
    (window as any).electronAPI?.toggleMinimize();
  });

  // Scale dropdown
  const btnScale = document.getElementById('btn-scale');
  const scaleMenu = document.getElementById('scale-menu');
  const scaleOptions = document.querySelectorAll('.scale-option');

  btnScale?.addEventListener('click', (e) => {
    e.stopPropagation();
    scaleMenu?.classList.toggle('open');
  });

  // Close dropdown when clicking elsewhere
  document.addEventListener('click', () => {
    scaleMenu?.classList.remove('open');
  });

  scaleOptions.forEach((option) => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      const scale = parseFloat((option as HTMLElement).dataset.scale || '1.0');
      (window as any).electronAPI?.setScale(scale);
      // Update active state
      scaleOptions.forEach((o) => o.classList.remove('active'));
      option.classList.add('active');
      scaleMenu?.classList.remove('open');
    });
  });

  // Set initial active state from saved scale
  if ((window as any).electronAPI?.getScale) {
    (window as any).electronAPI.getScale().then((scale: number) => {
      scaleOptions.forEach((o) => {
        const optScale = parseFloat((o as HTMLElement).dataset.scale || '1.0');
        o.classList.toggle('active', optScale === scale);
      });
    });
  }

  // Listen for minimize state changes
  if ((window as any).electronAPI?.onMinimizeState) {
    (window as any).electronAPI.onMinimizeState((minimized: boolean) => {
      characterContainer?.classList.toggle('hidden', minimized);
      document.getElementById('app')?.classList.toggle('minimized', minimized);
      if (btnMinimize) {
        btnMinimize.textContent = minimized ? '+' : '−';
        btnMinimize.title = minimized ? 'Expand' : 'Minimize';
      }
    });
  }
}

// Stats panel - show session counts and top projects
function initStatsPanel(): void {
  const panel = document.getElementById('stats-panel');
  const pinBtn = document.getElementById('stats-pin');
  if (!panel) return;

  const api = (window as any).electronAPI;
  let hideTimeout: ReturnType<typeof setTimeout> | null = null;
  let panelVisible = false;
  let pinned = false;

  const showPanel = () => {
    if (panelVisible) return;
    panelVisible = true;
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    panel.classList.add('visible');
  };

  const hidePanel = () => {
    if (!panelVisible || pinned) return;
    panelVisible = false;
    hideTimeout = setTimeout(() => {
      panel.classList.remove('visible');
    }, 500);
  };

  // Keep panel visible when hovering over it
  panel.addEventListener('mouseenter', () => {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  });

  panel.addEventListener('mouseleave', () => {
    if (!pinned) {
      hidePanel();
    }
  });

  // Hover detection: same top 15% threshold as window controls
  const CHARACTER_TOP_THRESHOLD = 0.15;

  if (api?.onMousePosition) {
    api.onMousePosition((position: {
      isInWindow: boolean;
      windowRelativeY: number;
    }) => {
      if (position.isInWindow && position.windowRelativeY < CHARACTER_TOP_THRESHOLD) {
        showPanel();
      } else if (!panel.matches(':hover')) {
        hidePanel();
      }
    });
  }

  // Reload button — reset active sessions with confirmation
  const reloadBtn = document.getElementById('stats-reload');
  reloadBtn?.addEventListener('click', () => {
    if (!confirm('Reset active session count to 0?')) return;
    if (api?.resetStats) {
      api.resetStats().then((stats: any) => {
        updateStats(stats);
      });
    }
  });

  // Pin button toggle
  pinBtn?.addEventListener('click', () => {
    pinned = !pinned;
    panel.classList.toggle('pinned', pinned);
    if (pinned) {
      panel.classList.add('visible');
    }
  });

  // Minimize integration: force-show when minimized (handled by CSS, but also track state)
  if (api?.onMinimizeState) {
    api.onMinimizeState((minimized: boolean) => {
      if (minimized) {
        panel.classList.add('visible');
      } else if (!pinned) {
        panel.classList.remove('visible');
        panelVisible = false;
      }
    });
  }

  // Update DOM with stats data
  function updateStats(stats: { active: number; today: number; week: number; topProjects: string[] }): void {
    const activeCount = document.getElementById('stats-active-count');
    const dot = panel?.querySelector('.stats-dot');
    const todayEl = document.getElementById('stats-today');
    const weekEl = document.getElementById('stats-week');
    const projectsEl = document.getElementById('stats-top-projects');

    if (activeCount) activeCount.textContent = `${stats.active} active`;
    if (dot) dot.classList.toggle('inactive', stats.active === 0);
    if (todayEl) todayEl.textContent = `Today: ${stats.today}`;
    if (weekEl) weekEl.textContent = `Week: ${stats.week}`;
    if (projectsEl) {
      projectsEl.textContent = stats.topProjects.length > 0
        ? stats.topProjects.join(' · ')
        : '—';
    }
  }

  // Listen for pushed stats updates
  if (api?.onStatsUpdate) {
    api.onStatsUpdate((stats: any) => {
      updateStats(stats);
    });
  }

  // Initial load
  if (api?.getStats) {
    api.getStats().then((stats: any) => {
      updateStats(stats);
    });
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  console.log('[App] DOM ready, starting app...');
  new App();
  initWindowControls();
  initStatsPanel();
});

// Also try to initialize immediately if DOM is already loaded
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  console.log('[App] DOM already ready, starting app...');
  new App();
  initWindowControls();
  initStatsPanel();
}
