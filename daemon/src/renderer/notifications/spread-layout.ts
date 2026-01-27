/**
 * Layout engine for spread-mode notifications.
 * Calculates CSS positions for notifications grouped by session.
 */

export interface NotificationSlot {
  top: number;
  left: string;
  transform: string;
  zIndex: number;
  isTopCard: boolean;     // true for the newest (front) card in its session group
  totalInGroup: number;   // total notifications in this session group (including non-visible)
}

export interface SpreadNotificationInfo {
  id: string;
  sessionId: string;
  timestamp: number;
}

/** Pre-defined anchor positions for session groups (at scale 1.0). */
const SESSION_ANCHORS = [
  { top: 21,  left: '50%', transform: 'translateX(-50%)' },  // Above head
  { top: 200, left: '55%', transform: 'translateX(-50%)' },  // Face / upper body
  { top: 340, left: '45%', transform: 'translateX(-50%)' },  // Mid body
];

/** Card-stack offset: vertical px between cards in the same session group (at scale 1.0). */
const CARD_STACK_Y = 6;

/** Card-stack offset: horizontal px between cards (older cards shift right). */
const CARD_STACK_X = 3;

/** Max visible notifications per session group. */
const MAX_PER_SESSION = 3;

/** Max total visible notifications across all sessions. */
const MAX_TOTAL = 12;

/**
 * Calculates layout positions for all notifications in spread mode.
 */
export class SpreadLayoutEngine {

  calculateLayout(
    notifications: SpreadNotificationInfo[],
    scale: number = 1.0,
  ): Map<string, NotificationSlot> {
    const result = new Map<string, NotificationSlot>();
    if (notifications.length === 0) return result;

    // Group by sessionId, preserving order of first appearance
    const sessionOrder: string[] = [];
    const sessionGroups = new Map<string, SpreadNotificationInfo[]>();

    for (const n of notifications) {
      if (!sessionGroups.has(n.sessionId)) {
        sessionOrder.push(n.sessionId);
        sessionGroups.set(n.sessionId, []);
      }
      sessionGroups.get(n.sessionId)!.push(n);
    }

    // Sort each group by timestamp (oldest first, newest at anchor position)
    for (const group of sessionGroups.values()) {
      group.sort((a, b) => a.timestamp - b.timestamp);
    }

    let totalRendered = 0;

    for (let i = 0; i < sessionOrder.length; i++) {
      const sessionId = sessionOrder[i];
      const group = sessionGroups.get(sessionId)!;

      // Get anchor for this session group
      const anchor = i < SESSION_ANCHORS.length
        ? SESSION_ANCHORS[i]
        : this.randomAnchor(i, scale);

      // Take the most recent notifications (up to MAX_PER_SESSION)
      const visible = group.slice(-MAX_PER_SESSION);

      for (let j = 0; j < visible.length; j++) {
        if (totalRendered >= MAX_TOTAL) break;

        const n = visible[j];
        // stackIndex: 0 for newest (front), increases for older (behind)
        const stackIndex = visible.length - 1 - j;

        // Card stack: older cards peek out slightly below-right of the top card
        const yOffset = stackIndex * CARD_STACK_Y;
        const xOffset = stackIndex * CARD_STACK_X;

        result.set(n.id, {
          top: Math.round((anchor.top + yOffset) * scale),
          left: anchor.left,
          transform: xOffset > 0
            ? `translateX(calc(-50% + ${Math.round(xOffset * scale)}px))`
            : anchor.transform,
          zIndex: 1100 + j, // newer on top (higher j = newer = higher z)
          isTopCard: j === visible.length - 1,
          totalInGroup: group.length,
        });

        totalRendered++;
      }

      if (totalRendered >= MAX_TOTAL) break;
    }

    return result;
  }

  /**
   * Count distinct sessions in the notification list.
   */
  getSessionCount(notifications: SpreadNotificationInfo[]): number {
    const sessions = new Set(notifications.map(n => n.sessionId));
    return sessions.size;
  }

  /**
   * Get how many excess notifications a session has (beyond MAX_PER_SESSION).
   */
  getExcessCount(notifications: SpreadNotificationInfo[], sessionId: string): number {
    const count = notifications.filter(n => n.sessionId === sessionId).length;
    return Math.max(0, count - MAX_PER_SESSION);
  }

  /**
   * Generate a pseudo-random but deterministic anchor for overflow sessions.
   * Uses session index as seed for consistency across re-layouts.
   */
  private randomAnchor(sessionIndex: number, scale: number): { top: number; left: string; transform: string } {
    // Simple deterministic spread: alternate sides, vary vertical position
    const baseTop = 100 + ((sessionIndex * 97) % 300); // 100-400 range
    const leftOffset = sessionIndex % 2 === 0 ? 40 : 60; // alternate left/right of center

    return {
      top: baseTop,
      left: `${leftOffset}%`,
      transform: 'translateX(-50%)',
    };
  }
}
