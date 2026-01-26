export interface NotificationData {
  type: 'approval' | 'complete' | 'info' | 'attention' | 'question';
  title: string;
  body: string;
  sessionId?: string;
  tool?: string;
  metadata?: {
    project?: string;
    projectPath?: string;
    summary?: string;
    commandSummary?: string;
    filePath?: string;
  };
}

interface PendingNotification {
  id: string;
  sessionId: string;
  tool: string;
  project: string;
  projectPath: string;
  summary: string;
  timestamp: number;
  shown: boolean; // Whether notification is actually displayed
}

const AUTO_DISMISS_DELAY = 2000; // 2 seconds - if tool completes within this, auto-dismiss

export class NotificationManager {
  private container: HTMLElement;
  private appElement: HTMLElement; // For approval notifications (needs viewport-relative fixed positioning)
  private pendingNotifications: Map<string, PendingNotification> = new Map();
  private notificationElement: HTMLElement | null = null;
  private idCounter = 0;
  private pendingTimers: Map<string, number> = new Map(); // Timers for delayed show

  constructor(container: HTMLElement) {
    this.container = container;
    // Get #app element for approval notifications - it doesn't have transform so position:fixed works correctly
    this.appElement = document.getElementById('app') || container;
  }

  show(data: NotificationData): string {
    const id = `notification-${++this.idCounter}`;

    if (data.type === 'approval') {
      return this.addNotification(id, data);
    } else if (data.type === 'attention') {
      return this.showAttention(id, data);
    } else if (data.type === 'question') {
      return this.showQuestion(id, data);
    } else {
      return this.showTransient(id, data);
    }
  }

  private addNotification(id: string, data: NotificationData): string {
    const sessionId = data.sessionId || 'unknown';
    const project = data.metadata?.project || 'unknown';
    const projectPath = data.metadata?.projectPath || '';
    const tool = data.tool || '';
    const summary = data.metadata?.summary || data.metadata?.commandSummary || tool || 'action';

    console.log('[NotificationManager] Adding notification:', { id, sessionId, project, projectPath, tool, summary });

    // Cancel any existing timer for this session (in case of rapid events)
    this.cancelPendingTimer(sessionId);

    // Add to pending notifications (not shown yet)
    this.pendingNotifications.set(sessionId, {
      id,
      sessionId,
      tool,
      project,
      projectPath,
      summary,
      timestamp: Date.now(),
      shown: false,
    });

    // Delay showing notification - if tool_complete comes quickly, we won't show it
    const timerId = window.setTimeout(() => {
      const notification = this.pendingNotifications.get(sessionId);
      if (notification && !notification.shown) {
        notification.shown = true;
        console.log('[NotificationManager] Showing notification after delay (needs approval):', sessionId);
        this.updateNotificationDisplay();
      }
      this.pendingTimers.delete(sessionId);
    }, AUTO_DISMISS_DELAY);

    this.pendingTimers.set(sessionId, timerId);

    return id;
  }

  private updateNotificationDisplay(): void {
    // Only show notifications that have been marked as "shown"
    const shownNotifications = Array.from(this.pendingNotifications.values()).filter(n => n.shown);
    const count = shownNotifications.length;

    if (count === 0) {
      if (this.notificationElement) {
        this.notificationElement.classList.add('hiding');
        const elementToRemove = this.notificationElement;
        this.notificationElement = null;
        setTimeout(() => {
          elementToRemove.remove();
        }, 300);
      }
      return;
    }

    const latest = shownNotifications[shownNotifications.length - 1];

    // Remove old element immediately (no animation) when updating
    if (this.notificationElement) {
      this.notificationElement.remove();
      this.notificationElement = null;
    }

    // Build element completely BEFORE adding to DOM
    const element = document.createElement('div');
    element.className = 'notification approval';

    const projectDisplay = this.formatProject(latest.project);
    const toolDisplay = latest.tool || 'Action';
    const summaryDisplay = this.formatSummary(latest.summary, latest.tool);
    const countBadge = count > 1 ? `<div class="approval-badge">${count}</div>` : '';

    element.innerHTML = `
      ${countBadge}
      <div class="notification-header">
        <span class="notification-project">${projectDisplay}</span>
      </div>
      <div class="notification-content">
        <span class="notification-summary">${summaryDisplay}</span>
      </div>
      <div class="notification-actions">
        <span class="notification-tool">${toolDisplay}</span>
        ${toolDisplay === 'Plan' ? '<span class="notification-action-tag">Approval</span>' : ''}
        <button class="btn-dismiss">Dismiss</button>
      </div>
    `;

    // Capture sessionId for click handler closure
    const sessionIdToRemove = latest.sessionId;

    // Add dismiss handler to button BEFORE adding to DOM
    const dismissBtn = element.querySelector('.btn-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pendingNotifications.delete(sessionIdToRemove);
        this.updateNotificationDisplay();
      });
    }

    // Also dismiss on click anywhere on notification
    element.addEventListener('click', () => {
      this.pendingNotifications.delete(sessionIdToRemove);
      this.updateNotificationDisplay();
    });

    // NOW add to DOM - fully ready with content and handlers
    this.appElement.appendChild(element);
    this.notificationElement = element;

    console.log('[NotificationManager] Notification displayed for session:', sessionIdToRemove);
  }

  private formatProject(project: string): string {
    return project;
  }

  private formatSummary(summary: string, tool: string): string {
    if (!summary || summary === tool) {
      switch (tool) {
        case 'Bash': return 'Running command...';
        case 'Write': return 'Creating file...';
        case 'Edit': return 'Editing file...';
        default: return 'Working...';
      }
    }

    if (tool === 'Bash') {
      return summary.trim();
    }

    return summary;
  }

  private showAttention(id: string, data: NotificationData): string {
    const element = document.createElement('div');
    element.id = id;
    element.className = 'notification attention';

    const projectDisplay = data.title || 'Project';

    element.innerHTML = `
      <div class="notification-header">
        <span class="notification-project">${projectDisplay}</span>
        <button class="btn-dismiss-small">×</button>
      </div>
      <div class="notification-content">
        <span class="notification-summary">${data.body}</span>
      </div>
    `;

    // Use appElement for fixed positioning (same as approval notifications)
    this.appElement.appendChild(element);

    // Click anywhere on notification to dismiss
    element.addEventListener('click', () => {
      element.classList.add('hiding');
      setTimeout(() => element.remove(), 300);
    });

    return id;
  }

  private showQuestion(id: string, data: NotificationData): string {
    const element = document.createElement('div');
    element.id = id;
    element.className = 'notification question';

    const projectDisplay = data.title || 'Question';

    element.innerHTML = `
      <div class="notification-header">
        <span class="notification-project">${projectDisplay}</span>
        <button class="btn-dismiss-small">×</button>
      </div>
      <div class="notification-content">
        <span class="notification-summary">${data.body}</span>
      </div>
    `;

    // Use appElement for fixed positioning (same as approval notifications)
    this.appElement.appendChild(element);

    // Click anywhere on notification to dismiss
    element.addEventListener('click', () => {
      element.classList.add('hiding');
      setTimeout(() => element.remove(), 300);
    });

    return id;
  }

  private showTransient(id: string, data: NotificationData): string {
    const element = document.createElement('div');
    element.id = id;
    element.className = `notification ${data.type} transient`;

    element.innerHTML = `
      <div class="notification-body">${data.body}</div>
    `;

    this.container.appendChild(element);

    element.addEventListener('click', () => {
      element.classList.add('hiding');
      setTimeout(() => element.remove(), 300);
    });

    setTimeout(() => {
      if (element.parentNode) {
        element.classList.add('hiding');
        setTimeout(() => element.remove(), 300);
      }
    }, 5000); // 5 seconds for transient notifications (e.g., "Claude finished")

    return id;
  }

  dismiss(id: string): void {
    for (const [sessionId, notification] of this.pendingNotifications) {
      if (notification.id === id) {
        this.cancelPendingTimer(sessionId);
        this.pendingNotifications.delete(sessionId);
        this.updateNotificationDisplay();
        return;
      }
    }
  }

  dismissBySession(sessionId: string): void {
    const notification = this.pendingNotifications.get(sessionId);
    if (notification) {
      // Cancel any pending timer
      this.cancelPendingTimer(sessionId);

      // If notification wasn't shown yet, it was auto-permitted - just remove silently
      if (!notification.shown) {
        console.log('[NotificationManager] Auto-permitted tool completed before display:', sessionId);
      }

      this.pendingNotifications.delete(sessionId);
      this.updateNotificationDisplay();
    }
  }

  dismissByToolAndSummary(tool: string, summary: string, projectPath?: string): void {
    // Find and dismiss notification matching tool + projectPath + summary
    // Uses prefix matching for summary to handle truncation differences
    for (const [sessionId, notification] of this.pendingNotifications) {
      // Must match tool
      if (notification.tool !== tool) continue;

      // Must match projectPath if both are provided
      if (projectPath && notification.projectPath && notification.projectPath !== projectPath) continue;

      // Match summary: exact match or prefix match (either direction for truncation)
      const summaryMatches =
        notification.summary === summary ||
        notification.summary.startsWith(summary) ||
        summary.startsWith(notification.summary);

      if (summaryMatches) {
        console.log('[NotificationManager] Dismissing notification by tool+project+summary match:', { tool, projectPath, summary, sessionId });
        this.cancelPendingTimer(sessionId);
        this.pendingNotifications.delete(sessionId);
        this.updateNotificationDisplay();
        return;
      }
    }
    console.log('[NotificationManager] No matching notification found for:', { tool, projectPath, summary });
  }

  private cancelPendingTimer(sessionId: string): void {
    const timerId = this.pendingTimers.get(sessionId);
    if (timerId) {
      window.clearTimeout(timerId);
      this.pendingTimers.delete(sessionId);
    }
  }

  dismissByType(type: 'plan' | 'question' | 'attention'): void {
    // Find and dismiss notifications by type (for question/attention which are DOM-based)
    const className = type === 'plan' ? 'approval' : type;
    const elements = this.appElement.querySelectorAll(`.notification.${className}`);
    elements.forEach(element => {
      element.classList.add('hiding');
      setTimeout(() => element.remove(), 300);
    });

    // For plan/approval, also clear pending notifications
    if (type === 'plan') {
      for (const [sessionId, notification] of this.pendingNotifications.entries()) {
        if (notification.tool === 'Plan') {
          this.cancelPendingTimer(sessionId);
          this.pendingNotifications.delete(sessionId);
        }
      }
      this.updateNotificationDisplay();
    }
  }

  dismissAll(): void {
    // Cancel all timers
    for (const timerId of this.pendingTimers.values()) {
      window.clearTimeout(timerId);
    }
    this.pendingTimers.clear();
    this.pendingNotifications.clear();
    this.updateNotificationDisplay();
  }

  getPendingCount(): number {
    return this.pendingNotifications.size;
  }

  hasPendingApproval(sessionId: string): boolean {
    return this.pendingNotifications.has(sessionId);
  }

  hasAnyPendingApproval(): boolean {
    return this.pendingNotifications.size > 0;
  }
}
