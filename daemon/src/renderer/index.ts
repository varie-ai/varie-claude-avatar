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
  private activeCharacterId: string = 'beatriz_4e17b3271c2b';
  private currentScale: number = 1.0;
  private spreadModeEnabled = true;
  private spreadExpressionActive = false;
  private eventExpressionActive = false;

  constructor() {
    this.characterContainer = document.getElementById('character-container') as HTMLElement;
    this.notifications = new NotificationManager(
      document.getElementById('notification-container') as HTMLElement
    );

    // Update expression when notifications change
    this.notifications.setOnDisplayChanged(() => this.updateSpreadExpression());

    this.init();
  }

  /**
   * Update character expression based on how many distinct sessions
   * have visible notifications. Only active in spread mode.
   * Yields to event expressions — only plays when no event expression is active.
   */
  private updateSpreadExpression(): void {
    if (!this.spreadModeEnabled) {
      if (this.spreadExpressionActive) {
        this.character?.clearExpression();
        this.spreadExpressionActive = false;
      }
      return;
    }

    // Don't override an active event expression
    if (this.eventExpressionActive) return;

    const sessionCount = this.notifications.getVisibleSessionCount();

    if (sessionCount >= 5) {
      this.character?.setExpression('sad');
      this.spreadExpressionActive = true;
    } else if (sessionCount >= 3) {
      this.character?.setExpression('angry');
      this.spreadExpressionActive = true;
    } else if (this.spreadExpressionActive) {
      this.character?.clearExpression();
      this.spreadExpressionActive = false;
    }
  }

  /**
   * Set expression for a per-event reaction.
   * - Ignores if another event expression is already playing (no override).
   * - Can override spread expressions (event expressions take priority).
   * - Self-clears after a randomized 2-3s duration.
   * - On clear, lets spread expression reclaim if conditions are met.
   */
  private setEventExpression(expression: string): void {
    // Don't override if another event expression is currently playing
    if (this.eventExpressionActive) return;

    // Event expressions can override spread expressions
    this.spreadExpressionActive = false;
    this.eventExpressionActive = true;
    this.character?.setExpression(expression);

    // Self-clear after randomized 2-3 second duration
    const duration = 2000 + Math.random() * 1000;
    setTimeout(() => {
      this.eventExpressionActive = false;
      // Let spread expression reclaim if conditions are met
      this.updateSpreadExpression();
      // If no spread expression took over, clear
      if (!this.spreadExpressionActive) {
        this.character?.clearExpression();
      }
    }, duration);
  }

  /** Pick a random element from an array. */
  private randomChoice<T>(options: T[]): T {
    return options[Math.floor(Math.random() * options.length)];
  }

  /** Toggle between spread mode (default) and clean/stacked mode. */
  toggleSpreadMode(): void {
    this.spreadModeEnabled = !this.spreadModeEnabled;
    this.notifications.setSpreadMode(this.spreadModeEnabled);
    // Button lights up when in clean/stacked mode (non-default)
    const btn = document.getElementById('btn-spread');
    btn?.classList.toggle('active', !this.spreadModeEnabled);
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
        this.notifications.setScale(scale);
      });

      // Apply initial scale to character container
      this.currentScale = await api.getScale();
      if (this.currentScale !== 1.0) {
        this.characterContainer.style.height = `${Math.round(540 * this.currentScale)}px`;
      }
      this.notifications.setScale(this.currentScale);
    }

    // Spread mode toggle button
    const btnSpread = document.getElementById('btn-spread');
    btnSpread?.addEventListener('click', () => {
      this.toggleSpreadMode();
    });

    // Set up mouse tracking for eye gaze
    this.setupMouseTracking();

    // Load active character (from config or default)
    try {
      const characterId = api ? await api.getActiveCharacterId() : 'beatriz_4e17b3271c2b';
      console.log('[App] Active character:', characterId);
      await this.loadCharacterById(characterId);
    } catch (err) {
      console.error('[App] Failed to get active character, loading default:', err);
      await this.loadCharacterById('beatriz_4e17b3271c2b');
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
        this.setEventExpression(this.randomChoice(['curious', 'surprised']));
        this.character?.setSpeaking(true);
        const approvalSpeakDuration = 1500 * (0.7 + Math.random() * 0.6);
        setTimeout(() => this.character?.setSpeaking(false), approvalSpeakDuration);
        break;

      case 'tool_complete':
        // Dismiss matching approval notification by tool + projectPath + summary (sessionIds differ between events)
        const completedTool = event.tool || '';
        const completedSummary = (event.metadata?.summary as string) || (event.metadata?.commandSummary as string) || '';
        const completedProjectPath = (event.metadata?.projectPath as string) || '';
        if (completedTool) {
          this.notifications.dismissByToolAndSummary(completedTool, completedSummary, completedProjectPath);
        }
        this.setEventExpression(this.randomChoice(['happy', 'excited']));
        break;

      case 'stop':
        const projectName = (event.metadata?.project as string) || '';
        this.notifications.show({
          type: 'complete',
          title: 'Task Complete',
          body: projectName ? `${projectName}: Claude finished` : 'Claude finished',
          sessionId: event.sessionId,
        });
        this.setEventExpression(this.randomChoice(['happy', 'excited']));
        this.character?.setSpeaking(true);
        const stopSpeakDuration = 2250 * (0.7 + Math.random() * 0.6);
        setTimeout(() => this.character?.setSpeaking(false), stopSpeakDuration);
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
        this.setEventExpression('curious');
        break;

      case 'subagent_stop':
        // Subagent finished - brief positive expression, no notification (too noisy)
        this.setEventExpression(this.randomChoice(['happy', 'excited']));
        break;

      case 'user_prompt':
        // User submitted a prompt - dismiss attention notifications and
        // any pending approval notifications for this session (covers tool rejection:
        // if user rejected a tool, the next prompt means they've moved on)
        this.notifications.dismissByType('attention');
        if (event.sessionId) {
          this.notifications.dismissBySession(event.sessionId);
        }
        this.setEventExpression('thoughtful');
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
        this.setEventExpression('curious');
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
        this.setEventExpression('curious');
        this.character?.setSpeaking(true);
        const questionSpeakDuration = 1500 * (0.7 + Math.random() * 0.6);
        setTimeout(() => this.character?.setSpeaking(false), questionSpeakDuration);
        break;

      case 'plan_complete':
        // Plan was approved/rejected - dismiss plan notification
        this.notifications.dismissByType('plan');
        this.setEventExpression('happy');
        break;

      case 'question_complete':
        // Question was answered - dismiss question notification
        this.notifications.dismissByType('question');
        this.setEventExpression('happy');
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
