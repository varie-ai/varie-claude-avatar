/**
 * Global Mouse Tracker
 *
 * Tracks mouse position across the entire screen for eye tracking.
 * Works with Electron's transparent overlay to make the character
 * follow the cursor anywhere on screen.
 */

import { screen, BrowserWindow } from 'electron';

export interface ScreenMousePosition {
  // Raw screen coordinates
  screenX: number;
  screenY: number;
  // Normalized coordinates (-1 to 1) relative to primary display
  normalizedX: number;
  normalizedY: number;
  // Normalized relative to overlay window
  relativeX: number;
  relativeY: number;
  // Window-relative info for UI controls
  isInWindow: boolean;
  windowRelativeY: number; // 0 = top of window, 1 = bottom
}

export type MousePositionCallback = (position: ScreenMousePosition) => void;

export class MouseTracker {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private callback: MousePositionCallback | null = null;
  private overlayWindow: BrowserWindow | null = null;
  private pollInterval: number;

  constructor(pollInterval = 16) { // ~60fps
    this.pollInterval = pollInterval;
  }

  /**
   * Start tracking mouse position
   */
  start(callback: MousePositionCallback, overlayWindow?: BrowserWindow): void {
    this.callback = callback;
    this.overlayWindow = overlayWindow || null;

    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    this.intervalId = setInterval(() => {
      this.updatePosition();
    }, this.pollInterval);
  }

  /**
   * Stop tracking
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.callback = null;
  }

  /**
   * Set the overlay window reference
   */
  setOverlayWindow(window: BrowserWindow): void {
    this.overlayWindow = window;
  }

  private updatePosition(): void {
    if (!this.callback) return;

    // Get global cursor position
    const cursorPoint = screen.getCursorScreenPoint();
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.size;

    // Normalize to -1 to 1 (center of screen = 0,0)
    const normalizedX = (cursorPoint.x / screenWidth) * 2 - 1;
    const normalizedY = -((cursorPoint.y / screenHeight) * 2 - 1); // Invert Y

    // Calculate relative to overlay window if available
    let relativeX = normalizedX;
    let relativeY = normalizedY;
    let isInWindow = false;
    let windowRelativeY = 0.5;

    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      const bounds = this.overlayWindow.getBounds();
      const windowCenterX = bounds.x + bounds.width / 2;
      const windowCenterY = bounds.y + bounds.height / 2;

      // Distance from cursor to window center, normalized
      const dx = cursorPoint.x - windowCenterX;
      const dy = cursorPoint.y - windowCenterY;

      // Normalize based on a reasonable "gaze range" (e.g., 500px = full gaze)
      const gazeRange = 500;
      relativeX = Math.max(-1, Math.min(1, dx / gazeRange));
      relativeY = Math.max(-1, Math.min(1, -dy / gazeRange)); // Invert Y

      // Check if mouse is within window bounds
      isInWindow = cursorPoint.x >= bounds.x &&
                   cursorPoint.x <= bounds.x + bounds.width &&
                   cursorPoint.y >= bounds.y &&
                   cursorPoint.y <= bounds.y + bounds.height;

      // Window-relative Y position (0 = top, 1 = bottom)
      windowRelativeY = (cursorPoint.y - bounds.y) / bounds.height;
    }

    this.callback({
      screenX: cursorPoint.x,
      screenY: cursorPoint.y,
      normalizedX,
      normalizedY,
      relativeX,
      relativeY,
      isInWindow,
      windowRelativeY,
    });
  }
}
