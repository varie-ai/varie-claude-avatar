import { SessionColorAssigner, ColorVariant } from './session-color-theme';
import { SpreadLayoutEngine, SpreadNotificationInfo, NotificationSlot } from './spread-layout';

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
}

const MIN_DISPLAY_MS = 1000; // Minimum time a notification stays visible before auto-dismissal

export class NotificationManager {
  private container: HTMLElement;
  private appElement: HTMLElement; // For approval notifications (needs viewport-relative fixed positioning)
  private pendingNotifications: Map<string, PendingNotification> = new Map();
  private notificationElement: HTMLElement | null = null;
  private idCounter = 0;

  // Spread mode
  private spreadMode = true;
  private spreadElements: Map<string, HTMLElement> = new Map();
  private colorAssigner = new SessionColorAssigner();
  private layoutEngine = new SpreadLayoutEngine();
  private currentScale = 1.0;
  private onDisplayChanged: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    // Get #app element for approval notifications - it doesn't have transform so position:fixed works correctly
    this.appElement = document.getElementById('app') || container;
  }

  setSpreadMode(enabled: boolean): void {
    if (this.spreadMode === enabled) return;
    this.spreadMode = enabled;
    // Clear current display, then re-render in the new mode
    this.clearAllDisplayElements();
    this.updateNotificationDisplay();
  }

  getSpreadMode(): boolean {
    return this.spreadMode;
  }

  setScale(scale: number): void {
    this.currentScale = scale;
    if (this.spreadMode) {
      this.updateNotificationDisplay();
    }
  }

  setOnDisplayChanged(callback: () => void): void {
    this.onDisplayChanged = callback;
  }

  getVisibleSessionCount(): number {
    const sessions = new Set<string>();
    for (const n of this.pendingNotifications.values()) {
      sessions.add(n.sessionId);
    }
    return sessions.size;
  }

  private clearAllDisplayElements(): void {
    // Clear stacked mode element
    if (this.notificationElement) {
      this.notificationElement.remove();
      this.notificationElement = null;
    }
    // Clear spread mode elements
    for (const el of this.spreadElements.values()) {
      el.remove();
    }
    this.spreadElements.clear();
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

    // Add to pending notifications and show immediately.
    // Dismissed when a matching tool_complete event arrives (dismissByToolAndSummary),
    // when the session ends (dismissBySession), or by user click.
    this.pendingNotifications.set(id, {
      id,
      sessionId,
      tool,
      project,
      projectPath,
      summary,
      timestamp: Date.now(),
    });

    this.updateNotificationDisplay();

    return id;
  }

  private updateNotificationDisplay(): void {
    if (this.spreadMode) {
      this.updateSpreadDisplay();
    } else {
      this.updateStackedDisplay();
    }
    this.onDisplayChanged?.();
  }

  // ── Stacked mode (original behavior + session color) ──────────────

  private updateStackedDisplay(): void {
    // Clear any spread elements
    for (const el of this.spreadElements.values()) el.remove();
    this.spreadElements.clear();

    const notifications = Array.from(this.pendingNotifications.values());
    const count = notifications.length;

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

    const latest = notifications[notifications.length - 1];

    // Remove old element immediately (no animation) when updating
    if (this.notificationElement) {
      this.notificationElement.remove();
      this.notificationElement = null;
    }

    // Build element completely BEFORE adding to DOM
    const element = document.createElement('div');
    element.className = 'notification approval';

    // Apply session color
    const color = this.colorAssigner.getVariant(latest.sessionId, 'normal');
    this.applyColor(element, color, latest.tool);

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

    // Capture id for click handler closure
    const idToRemove = latest.id;

    // Add dismiss handler to button BEFORE adding to DOM
    const dismissBtn = element.querySelector('.btn-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pendingNotifications.delete(idToRemove);
        this.updateNotificationDisplay();
      });
    }

    // Also dismiss on click anywhere on notification
    element.addEventListener('click', () => {
      this.pendingNotifications.delete(idToRemove);
      this.updateNotificationDisplay();
    });

    // NOW add to DOM - fully ready with content and handlers
    this.appElement.appendChild(element);
    this.notificationElement = element;

    console.log('[NotificationManager] Stacked notification displayed:', idToRemove);
  }

  // ── Spread mode (per-notification positioned elements) ────────────

  private updateSpreadDisplay(): void {
    // Clear stacked element
    if (this.notificationElement) {
      this.notificationElement.remove();
      this.notificationElement = null;
    }

    const notifications = Array.from(this.pendingNotifications.values());

    if (notifications.length === 0) {
      for (const el of this.spreadElements.values()) {
        el.classList.add('hiding');
        setTimeout(() => el.remove(), 300);
      }
      this.spreadElements.clear();
      return;
    }

    // Build layout
    const infos: SpreadNotificationInfo[] = notifications.map(n => ({
      id: n.id,
      sessionId: n.sessionId,
      timestamp: n.timestamp,
    }));
    const layout = this.layoutEngine.calculateLayout(infos, this.currentScale);

    // Remove elements no longer in layout
    const layoutIds = new Set(layout.keys());
    for (const [id, el] of this.spreadElements) {
      if (!layoutIds.has(id)) {
        el.classList.add('hiding');
        const toRemove = el;
        setTimeout(() => toRemove.remove(), 300);
        this.spreadElements.delete(id);
      }
    }

    // Create or update elements for each notification in layout
    for (const [id, slot] of layout) {
      const notification = this.pendingNotifications.get(id);
      if (!notification) continue;

      let element = this.spreadElements.get(id);
      const isNew = !element;

      if (isNew) {
        element = this.createSpreadElement(notification);
        this.appElement.appendChild(element);
        this.spreadElements.set(id, element);
      }

      // Apply position
      this.applySlot(element!, slot);

      // Apply session color (top card gets normal, background cards get darker)
      const variant = slot.isTopCard ? 'normal' : 'darker';
      const color = this.colorAssigner.getVariant(notification.sessionId, variant);
      this.applyColor(element!, color, notification.tool);

      // Card stack: top card gets count badge when session has 2+ notifications
      if (slot.isTopCard && slot.totalInGroup >= 2) {
        this.ensureSpreadBadge(element!, slot.totalInGroup);
      } else {
        this.removeSpreadBadge(element!);
      }

      // Background cards get reduced visual prominence
      element!.classList.toggle('spread-bg-card', !slot.isTopCard);
    }

    console.log('[NotificationManager] Spread display updated:', layout.size, 'notifications');
  }

  private createSpreadElement(notification: PendingNotification): HTMLElement {
    const element = document.createElement('div');
    element.className = 'notification approval spread-item';
    element.id = notification.id;

    const projectDisplay = this.formatProject(notification.project);
    const toolDisplay = notification.tool || 'Action';
    const summaryDisplay = this.formatSummary(notification.summary, notification.tool);

    element.innerHTML = `
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

    const idToRemove = notification.id;

    const dismissBtn = element.querySelector('.btn-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pendingNotifications.delete(idToRemove);
        this.updateNotificationDisplay();
      });
    }

    element.addEventListener('click', () => {
      this.pendingNotifications.delete(idToRemove);
      this.updateNotificationDisplay();
    });

    return element;
  }

  private applySlot(element: HTMLElement, slot: NotificationSlot): void {
    element.style.top = `${slot.top}px`;
    element.style.left = slot.left;
    element.style.transform = slot.transform;
    element.style.zIndex = String(slot.zIndex);
  }

  private applyColor(element: HTMLElement, color: ColorVariant, tool: string): void {
    element.style.borderColor = color.border;
    element.style.background = color.background;
    // Apply to tool badge if it exists
    const toolBadge = element.querySelector('.notification-tool') as HTMLElement | null;
    if (toolBadge) {
      toolBadge.style.background = color.toolBadge;
      toolBadge.style.color = color.toolText;
    }
  }

  private ensureSpreadBadge(element: HTMLElement, count: number): void {
    let badge = element.querySelector('.spread-count-badge') as HTMLElement | null;
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'spread-count-badge';
      element.appendChild(badge);
    }
    badge.textContent = String(count);
  }

  private removeSpreadBadge(element: HTMLElement): void {
    const badge = element.querySelector('.spread-count-badge');
    if (badge) badge.remove();
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
    if (this.pendingNotifications.delete(id)) {
      this.updateNotificationDisplay();
    }
  }

  dismissBySession(sessionId: string): void {
    let changed = false;
    for (const [key, notification] of this.pendingNotifications) {
      if (notification.sessionId === sessionId) {
        this.pendingNotifications.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.colorAssigner.removeSession(sessionId);
      this.updateNotificationDisplay();
    }
  }

  dismissByToolAndSummary(tool: string, summary: string, projectPath?: string): void {
    // Find and dismiss notification matching tool + projectPath + summary
    // Uses prefix matching for summary to handle truncation differences
    for (const [key, notification] of this.pendingNotifications) {
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
        // Enforce minimum display duration so quick auto-approved tools
        // still flash the notification visibly (1s) before dismissing
        const elapsed = Date.now() - notification.timestamp;
        if (elapsed < MIN_DISPLAY_MS) {
          const remaining = MIN_DISPLAY_MS - elapsed;
          console.log('[NotificationManager] Delaying dismiss by', remaining, 'ms for min display:', key);
          setTimeout(() => {
            if (this.pendingNotifications.has(key)) {
              this.pendingNotifications.delete(key);
              this.updateNotificationDisplay();
            }
          }, remaining);
        } else {
          console.log('[NotificationManager] Dismissing notification by tool+project+summary match:', { tool, projectPath, summary, id: key });
          this.pendingNotifications.delete(key);
          this.updateNotificationDisplay();
        }
        return;
      }
    }
    console.log('[NotificationManager] No matching notification found for:', { tool, projectPath, summary });
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
      for (const [key, notification] of this.pendingNotifications.entries()) {
        if (notification.tool === 'Plan') {
          this.pendingNotifications.delete(key);
        }
      }
      this.updateNotificationDisplay();
    }
  }

  dismissAll(): void {
    this.pendingNotifications.clear();
    this.updateNotificationDisplay();
  }

  getPendingCount(): number {
    return this.pendingNotifications.size;
  }

  hasPendingApproval(sessionId: string): boolean {
    for (const notification of this.pendingNotifications.values()) {
      if (notification.sessionId === sessionId) return true;
    }
    return false;
  }

  hasAnyPendingApproval(): boolean {
    return this.pendingNotifications.size > 0;
  }
}
