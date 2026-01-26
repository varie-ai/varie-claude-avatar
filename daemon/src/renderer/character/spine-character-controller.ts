/**
 * Spine Character Controller
 *
 * Runtime animation control for Spine characters.
 * Ported from varie-character-extension for desktop overlay use.
 *
 * Provides clean API for:
 * - Lip sync (mouth texture swap)
 * - Eye blink (eyes texture swap or animation)
 * - Eye tracking (gaze direction via pre-baked mesh deformation)
 * - Breathing control
 * - Expression overlays
 */

// Simple logger for desktop app
const log = {
  info: (...args: unknown[]) => console.log('[SpineController]', ...args),
  debug: (...args: unknown[]) => console.debug('[SpineController]', ...args),
  warn: (...args: unknown[]) => console.warn('[SpineController]', ...args),
  error: (...args: unknown[]) => console.error('[SpineController]', ...args),
};

// ============================================================================
// Spine Player Types (subset of @esotericsoftware/spine-player)
// ============================================================================

/** Spine bone */
export interface SpineBone {
  name: string;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  data: { name: string };
}

/** Spine slot */
export interface SpineSlot {
  data: { name: string };
  setAttachment(attachment: SpineAttachment | null): void;
  getAttachment(): SpineAttachment | null;
}

/** Spine attachment */
export interface SpineAttachment {
  name: string;
}

/** Spine animation */
export interface SpineAnimation {
  name: string;
  duration: number;
}

/** Spine track entry */
export interface SpineTrackEntry {
  animation: SpineAnimation | null;
  trackTime: number;
  timeScale: number;
  alpha: number;
  mixBlend: number;
}

/** Spine skeleton data */
export interface SpineSkeletonData {
  animations: SpineAnimation[];
  findAnimation(name: string): SpineAnimation | null;
  defaultSkin: SpineSkin | null;
}

/** Spine skin */
export interface SpineSkin {
  name: string;
  attachments: Array<Record<string, SpineAttachment> | null>;
}

/** Spine skeleton */
export interface SpineSkeleton {
  slots: SpineSlot[];
  data: SpineSkeletonData;
  skin: SpineSkin | null;
  findBone(name: string): SpineBone | null;
  findSlot(name: string): SpineSlot | null;
  getAttachment(slotIndex: number, attachmentName: string): SpineAttachment | null;
}

/** Spine animation state */
export interface SpineAnimationState {
  setAnimation(trackIndex: number, animationName: string, loop: boolean): SpineTrackEntry;
  setEmptyAnimation(trackIndex: number, mixDuration: number): SpineTrackEntry;
  getCurrent(trackIndex: number): SpineTrackEntry | null;
  update(delta: number): void;
  apply(skeleton: SpineSkeleton): void;
}

/** MixBlend enum */
export const SpineMixBlend = {
  setup: 0,
  first: 1,
  replace: 2,
  add: 3,
} as const;

/** Spine Player instance */
export interface SpinePlayer {
  skeleton: SpineSkeleton;
  animationState: SpineAnimationState;
}

// ============================================================================
// Controller Types
// ============================================================================

export interface GazeState {
  x: number;
  y: number;
}

export interface ControllerState {
  isSpeaking: boolean;
  isBreathing: boolean;
  autoBlinkEnabled: boolean;
  currentGaze: GazeState;
  currentExpression: string | null;
  animations: string[];
  expressions: { floating: string[]; overlay: string[] };
}

export interface SpineCharacterControllerConfig {
  /** Auto-blink interval in ms (default: 3000) */
  autoBlinkInterval?: number;
  /** Auto-blink variance in ms (default: 1500) */
  autoBlinkVariance?: number;
  /** Mouth open duration in ms (default: 100) */
  mouthOpenDuration?: number;
  /** Mouth close duration in ms (default: 80) */
  mouthCloseDuration?: number;
  /** Gaze smoothing factor 0.1-0.3 (default: 0.15) */
  gazeSmoothingFactor?: number;
}

// ============================================================================
// Controller Implementation
// ============================================================================

export class SpineCharacterController {
  /** The underlying Spine Player instance */
  public readonly player: SpinePlayer;
  private skeleton: SpineSkeleton;
  private animationState: SpineAnimationState;
  private skeletonData: SpineSkeletonData;

  // State
  private _isSpeaking = false;
  private _isBreathing = true;
  private _currentGaze: GazeState = { x: 0, y: 0 };
  public lastBlinkTime = 0;
  private _autoBlinkEnabled = true;
  private _autoBlinkInterval: number;
  private _autoBlinkVariance: number;
  private _currentExpression: string | null = null;

  // Mouth animation state
  private _mouthOpenDuration: number;
  private _mouthCloseDuration: number;
  private _speakingTimer: ReturnType<typeof setTimeout> | null = null;

  // Gaze control state
  private _smoothedGaze: GazeState = { x: 0, y: 0 };
  private _gazeSmoothingFactor: number;

  // Cached slot references
  private _mouthSlot: SpineSlot | null = null;
  private _eyesSlot: SpineSlot | null = null;
  private _exprFloatingSlot: SpineSlot | null = null;
  private _exprOverlayLeftSlot: SpineSlot | null = null;
  private _exprOverlayRightSlot: SpineSlot | null = null;
  private _mouthSlotIndex = -1;
  private _eyesSlotIndex = -1;

  // Cached attachments
  private _mouthAttachments: Record<string, SpineAttachment> = {};
  private _eyeAttachments: Record<string, SpineAttachment> = {};
  private _exprFloatingAttachments: Record<string, SpineAttachment> = {};
  private _exprOverlayLeftAttachments: Record<string, SpineAttachment> = {};
  private _exprOverlayRightAttachments: Record<string, SpineAttachment> = {};

  // Animation tracks
  private readonly TRACK_MAIN = 0;
  private readonly TRACK_BREATHING = 1;
  private readonly TRACK_GAZE = 2;
  private readonly TRACK_GAZE_VERTICAL = 3;
  private readonly TRACK_BLINK = 4;

  // Blink scheduling
  private _blinkTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(player: SpinePlayer, config: SpineCharacterControllerConfig = {}) {
    this.player = player;
    this.skeleton = player.skeleton;
    this.animationState = player.animationState;
    this.skeletonData = this.skeleton.data;

    // Apply config with defaults
    this._autoBlinkInterval = config.autoBlinkInterval ?? 3000;
    this._autoBlinkVariance = config.autoBlinkVariance ?? 1500;
    this._mouthOpenDuration = config.mouthOpenDuration ?? 150;
    this._mouthCloseDuration = config.mouthCloseDuration ?? 150;
    this._gazeSmoothingFactor = config.gazeSmoothingFactor ?? 0.15;

    // Cache slot references
    this._cacheSlots();

    // Start breathing by default
    this._startBreathing();

    // Start auto-blink
    this._scheduleNextBlink();

    log.info('SpineCharacterController initialized');
  }

  // ============================================================================
  // Slot Caching
  // ============================================================================

  private _cacheSlots(): void {
    for (let i = 0; i < this.skeleton.slots.length; i++) {
      const slot = this.skeleton.slots[i];
      const slotName = slot.data.name;

      if (slotName === 'mouth_slot') {
        this._mouthSlot = slot;
        this._mouthSlotIndex = i;
      } else if (slotName === 'eyes_slot') {
        this._eyesSlot = slot;
        this._eyesSlotIndex = i;
      } else if (slotName === 'expr_floating_slot') {
        this._exprFloatingSlot = slot;
      } else if (slotName === 'expr_overlay_left_slot') {
        this._exprOverlayLeftSlot = slot;
      } else if (slotName === 'expr_overlay_right_slot') {
        this._exprOverlayRightSlot = slot;
      }
    }

    // Cache attachments
    if (this._mouthSlotIndex >= 0) {
      const closed = this.skeleton.getAttachment(this._mouthSlotIndex, 'mouth_closed');
      const open = this.skeleton.getAttachment(this._mouthSlotIndex, 'mouth_open');
      if (closed) this._mouthAttachments['mouth_closed'] = closed;
      if (open) this._mouthAttachments['mouth_open'] = open;
    }

    if (this._eyesSlotIndex >= 0) {
      const eyesClosed = this.skeleton.getAttachment(this._eyesSlotIndex, 'eyes_closed');
      if (eyesClosed) this._eyeAttachments['eyes_closed'] = eyesClosed;
    }

    // Cache expression attachments from skin
    const skin = this.skeleton.skin || this.skeletonData.defaultSkin;
    if (skin?.attachments) {
      for (let i = 0; i < skin.attachments.length; i++) {
        const slotAttachments = skin.attachments[i];
        if (!slotAttachments) continue;

        for (const attachName of Object.keys(slotAttachments)) {
          if (attachName.startsWith('expr_float_')) {
            this._exprFloatingAttachments[attachName] = slotAttachments[attachName];
          } else if (attachName.includes('_left')) {
            this._exprOverlayLeftAttachments[attachName] = slotAttachments[attachName];
          } else if (attachName.includes('_right')) {
            this._exprOverlayRightAttachments[attachName] = slotAttachments[attachName];
          }
        }
      }
    }

    log.debug('Cached slots:', {
      mouthSlot: !!this._mouthSlot,
      eyesSlot: !!this._eyesSlot,
      exprFloatingSlot: !!this._exprFloatingSlot,
      exprOverlayLeftSlot: !!this._exprOverlayLeftSlot,
      exprOverlayRightSlot: !!this._exprOverlayRightSlot,
    });
  }

  // ============================================================================
  // Lip Sync
  // ============================================================================

  setSpeaking(enabled: boolean): void {
    if (this._isSpeaking === enabled) return;
    this._isSpeaking = enabled;
    if (enabled) {
      this._startSpeaking();
    } else {
      this._stopSpeaking();
    }
  }

  get isSpeaking(): boolean {
    return this._isSpeaking;
  }

  private _startSpeaking(): void {
    if (!this._mouthSlot) {
      log.warn('No mouth_slot found');
      return;
    }

    const cycle = (): void => {
      if (!this._isSpeaking) return;
      this._setMouthOpen(true);

      // Open duration: 150-200ms randomized
      const openDuration = this._mouthOpenDuration + Math.random() * 50;

      this._speakingTimer = setTimeout(() => {
        if (!this._isSpeaking) return;
        this._setMouthOpen(false);

        // Close duration: 150-200ms normally, occasionally 300-400ms pause (20% chance)
        const isLongPause = Math.random() < 0.2;
        const closeDuration = isLongPause
          ? 300 + Math.random() * 100  // 300-400ms pause
          : this._mouthCloseDuration + Math.random() * 50;  // 150-200ms

        this._speakingTimer = setTimeout(() => {
          if (this._isSpeaking) cycle();
        }, closeDuration);
      }, openDuration);
    };

    cycle();
  }

  private _stopSpeaking(): void {
    if (this._speakingTimer) {
      clearTimeout(this._speakingTimer);
      this._speakingTimer = null;
    }
    this._setMouthOpen(false);
  }

  private _setMouthOpen(open: boolean): void {
    if (!this._mouthSlot) return;
    const attachmentName = open ? 'mouth_open' : 'mouth_closed';
    const attachment = this._mouthAttachments[attachmentName];

    if (attachment) {
      this._mouthSlot.setAttachment(attachment);
    } else if (this._mouthSlotIndex >= 0) {
      const attach = this.skeleton.getAttachment(this._mouthSlotIndex, attachmentName);
      if (attach) this._mouthSlot.setAttachment(attach);
    }
  }

  setSpeakingSpeed(speed: number): void {
    speed = Math.max(0.5, Math.min(2.0, speed));
    this._mouthOpenDuration = 150 / speed;
    this._mouthCloseDuration = 150 / speed;
  }

  // ============================================================================
  // Eye Blink
  // ============================================================================

  triggerBlink(): void {
    if (this._hasAnimation('blink')) {
      const track = this.animationState.setAnimation(this.TRACK_BLINK, 'blink', false);
      if (track) track.alpha = 1.0;
    } else if (this._eyesSlot) {
      this._setEyesClosed(true);
      setTimeout(() => this._setEyesClosed(false), 150);
    }
    this.lastBlinkTime = Date.now();
  }

  private _setEyesClosed(closed: boolean): void {
    if (!this._eyesSlot) return;
    if (closed) {
      const attachment = this._eyeAttachments['eyes_closed'];
      if (attachment) {
        this._eyesSlot.setAttachment(attachment);
      } else if (this._eyesSlotIndex >= 0) {
        const attach = this.skeleton.getAttachment(this._eyesSlotIndex, 'eyes_closed');
        if (attach) this._eyesSlot.setAttachment(attach);
      }
    } else {
      this._eyesSlot.setAttachment(null);
    }
  }

  setAutoBlinkEnabled(enabled: boolean): void {
    this._autoBlinkEnabled = enabled;
    if (enabled) {
      this._scheduleNextBlink();
    } else if (this._blinkTimeoutId) {
      clearTimeout(this._blinkTimeoutId);
      this._blinkTimeoutId = null;
    }
  }

  get autoBlinkEnabled(): boolean {
    return this._autoBlinkEnabled;
  }

  setBlinkInterval(intervalMs: number, varianceMs = 1500): void {
    this._autoBlinkInterval = intervalMs;
    this._autoBlinkVariance = varianceMs;
  }

  private _scheduleNextBlink(): void {
    if (!this._autoBlinkEnabled) return;
    const delay = this._autoBlinkInterval + (Math.random() - 0.5) * 2 * this._autoBlinkVariance;

    this._blinkTimeoutId = setTimeout(() => {
      if (this._autoBlinkEnabled) {
        this.triggerBlink();
        this._scheduleNextBlink();
      }
    }, delay);
  }

  // ============================================================================
  // Eye Tracking / Gaze
  // ============================================================================

  setLookTarget(x: number, y: number, smooth = true): void {
    x = Math.max(-1, Math.min(1, x));
    y = Math.max(-1, Math.min(1, y));
    this._currentGaze = { x, y };

    if (smooth) {
      this._smoothedGaze.x += (x - this._smoothedGaze.x) * this._gazeSmoothingFactor;
      this._smoothedGaze.y += (y - this._smoothedGaze.y) * this._gazeSmoothingFactor;
      this._applyGaze(this._smoothedGaze.x, this._smoothedGaze.y);
    } else {
      this._smoothedGaze = { x, y };
      this._applyGaze(x, y);
    }
  }

  lookAtScreen(screenX: number, screenY: number): void {
    const x = (screenX / window.innerWidth) * 2 - 1;
    const y = -((screenY / window.innerHeight) * 2 - 1);
    this.setLookTarget(x, y);
  }

  get currentGaze(): GazeState {
    return { ...this._currentGaze };
  }

  private _applyGaze(x: number, y: number): void {
    const hasHorizontalGaze = this._hasAnimation('look_left') && this._hasAnimation('look_right');
    const hasVerticalGaze = this._hasAnimation('look_up') && this._hasAnimation('look_down');

    if (hasHorizontalGaze || hasVerticalGaze) {
      this._applyGazeWithAnimations(x, y, hasHorizontalGaze, hasVerticalGaze);
    } else {
      this._applyGazeWithIdleTime(x);
    }
  }

  private _applyGazeWithAnimations(x: number, y: number, hasHorizontal: boolean, hasVertical: boolean): void {
    const GAZE_DURATION = 0.3;

    if (hasHorizontal) {
      if (Math.abs(x) > 0.1) {
        const animName = x < 0 ? 'look_left' : 'look_right';
        const currentTrack = this.animationState.getCurrent(this.TRACK_GAZE);
        const needsChange = !currentTrack || !currentTrack.animation || currentTrack.animation.name !== animName;

        let track: SpineTrackEntry;
        if (needsChange) {
          track = this.animationState.setAnimation(this.TRACK_GAZE, animName, false);
        } else {
          track = currentTrack;
        }

        if (track) {
          track.alpha = Math.min(1.0, Math.abs(x));
          track.trackTime = GAZE_DURATION;
          track.timeScale = 0;
          track.mixBlend = SpineMixBlend.replace;
        }
      } else {
        const currentTrack = this.animationState.getCurrent(this.TRACK_GAZE);
        if (currentTrack?.animation) {
          this.animationState.setEmptyAnimation(this.TRACK_GAZE, 0.2);
        }
      }
    }

    if (hasVertical) {
      if (Math.abs(y) > 0.1) {
        const animName = y > 0 ? 'look_up' : 'look_down';
        const currentTrack = this.animationState.getCurrent(this.TRACK_GAZE_VERTICAL);
        const needsChange = !currentTrack || !currentTrack.animation || currentTrack.animation.name !== animName;

        let track: SpineTrackEntry;
        if (needsChange) {
          track = this.animationState.setAnimation(this.TRACK_GAZE_VERTICAL, animName, false);
        } else {
          track = currentTrack;
        }

        if (track) {
          track.alpha = Math.min(1.0, Math.abs(y));
          track.trackTime = GAZE_DURATION;
          track.timeScale = 0;
          track.mixBlend = SpineMixBlend.replace;
        }
      } else {
        const currentTrack = this.animationState.getCurrent(this.TRACK_GAZE_VERTICAL);
        if (currentTrack?.animation) {
          this.animationState.setEmptyAnimation(this.TRACK_GAZE_VERTICAL, 0.2);
        }
      }
    }
  }

  private _applyGazeWithIdleTime(x: number): void {
    const track = this.animationState.getCurrent(this.TRACK_MAIN);
    if (!track || track.animation?.name !== 'idle') return;

    if (x < -0.3) {
      track.trackTime = 1.5;
    } else if (x > 0.3) {
      track.trackTime = 4.5;
    } else {
      track.trackTime = 0;
    }
  }

  // ============================================================================
  // Breathing
  // ============================================================================

  setBreathing(enabled: boolean): void {
    if (this._isBreathing === enabled) return;
    this._isBreathing = enabled;
    if (enabled) {
      this._startBreathing();
    } else {
      this._stopBreathing();
    }
  }

  get isBreathing(): boolean {
    return this._isBreathing;
  }

  private _startBreathing(): void {
    if (this._hasAnimation('breathing')) {
      this.animationState.setAnimation(this.TRACK_BREATHING, 'breathing', true);
      log.debug('Started breathing animation');
    } else {
      log.warn('No breathing animation found');
    }
  }

  private _stopBreathing(): void {
    this.animationState.setEmptyAnimation(this.TRACK_BREATHING, 0.5);
  }

  // ============================================================================
  // Expressions
  // ============================================================================

  private static readonly COMPOSITE_EXPRESSIONS: Record<string, { floating?: string; overlay?: string }> = {
    happy: { floating: 'happy_hearts' },
    excited: { floating: 'excited_sparkle' },
    sad: { floating: 'sad_heart', overlay: 'sad_tears_2' },
    shy: { overlay: 'shy_blush' },
    angry: { floating: 'angry' },
    surprised: { floating: 'surprised' },
    curious: { floating: 'curious_question' },
    thoughtful: { floating: 'thoughtful' },
  };

  setExpression(expressionName: string | null): void {
    if (!expressionName) {
      this.clearExpression();
      return;
    }

    const setOverlayPair = (baseName: string): boolean => {
      const leftAttach = `expr_overlay_${baseName}_left`;
      const rightAttach = `expr_overlay_${baseName}_right`;
      let found = false;

      if (this._exprOverlayLeftSlot && this._exprOverlayLeftAttachments[leftAttach]) {
        this._exprOverlayLeftSlot.setAttachment(this._exprOverlayLeftAttachments[leftAttach]);
        found = true;
      }
      if (this._exprOverlayRightSlot && this._exprOverlayRightAttachments[rightAttach]) {
        this._exprOverlayRightSlot.setAttachment(this._exprOverlayRightAttachments[rightAttach]);
        found = true;
      }
      return found;
    };

    const setFloating = (baseName: string): boolean => {
      const floatAttachName = `expr_float_${baseName}`;
      if (this._exprFloatingSlot && this._exprFloatingAttachments[floatAttachName]) {
        this._exprFloatingSlot.setAttachment(this._exprFloatingAttachments[floatAttachName]);
        return true;
      }
      return false;
    };

    // Clear all expression slots first
    if (this._exprFloatingSlot) this._exprFloatingSlot.setAttachment(null);
    if (this._exprOverlayLeftSlot) this._exprOverlayLeftSlot.setAttachment(null);
    if (this._exprOverlayRightSlot) this._exprOverlayRightSlot.setAttachment(null);

    // Check composite expression map
    const composite = SpineCharacterController.COMPOSITE_EXPRESSIONS[expressionName];
    if (composite) {
      if (composite.floating) setFloating(composite.floating);
      if (composite.overlay) setOverlayPair(composite.overlay);
      this._currentExpression = expressionName;
      log.debug(`Set composite expression: ${expressionName}`);
      return;
    }

    // Fallback: try floating first
    if (setFloating(expressionName)) {
      this._currentExpression = expressionName;
      log.debug(`Set floating expression: ${expressionName}`);
      return;
    }

    // Fallback: try overlay pair
    if (setOverlayPair(expressionName)) {
      this._currentExpression = expressionName;
      log.debug(`Set overlay expression pair: ${expressionName}`);
      return;
    }

    log.warn(`Expression not found: ${expressionName}`);
  }

  clearExpression(): void {
    if (this._exprFloatingSlot) this._exprFloatingSlot.setAttachment(null);
    if (this._exprOverlayLeftSlot) this._exprOverlayLeftSlot.setAttachment(null);
    if (this._exprOverlayRightSlot) this._exprOverlayRightSlot.setAttachment(null);
    this._currentExpression = null;
    log.debug('Cleared expression');
  }

  get currentExpression(): string | null {
    return this._currentExpression;
  }

  getAvailableExpressions(): { floating: string[]; overlay: string[] } {
    const floating = Object.keys(this._exprFloatingAttachments).map((name) =>
      name.replace('expr_float_', '')
    );
    const overlay = Object.keys(this._exprOverlayLeftAttachments).map((name) =>
      name.replace('expr_overlay_', '').replace('_left', '')
    );
    return { floating, overlay };
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private _hasAnimation(name: string): boolean {
    return this.skeletonData.findAnimation(name) !== null;
  }

  playAnimation(name: string, loop = true, track = 0): void {
    if (this._hasAnimation(name)) {
      this.animationState.setAnimation(track, name, loop);
    } else {
      log.warn(`Animation not found: ${name}`);
    }
  }

  getAnimations(): string[] {
    return this.skeletonData.animations.map((a) => a.name);
  }

  getState(): ControllerState {
    return {
      isSpeaking: this._isSpeaking,
      isBreathing: this._isBreathing,
      autoBlinkEnabled: this._autoBlinkEnabled,
      currentGaze: { ...this._currentGaze },
      currentExpression: this._currentExpression,
      animations: this.getAnimations(),
      expressions: this.getAvailableExpressions(),
    };
  }

  update(_deltaTime: number): void {
    // Currently handled by Spine runtime
  }

  destroy(): void {
    this.setSpeaking(false);
    this.setAutoBlinkEnabled(false);
    this.setBreathing(false);
    this.clearExpression();

    if (this._speakingTimer) {
      clearTimeout(this._speakingTimer);
      this._speakingTimer = null;
    }

    if (this._blinkTimeoutId) {
      clearTimeout(this._blinkTimeoutId);
      this._blinkTimeoutId = null;
    }

    log.info('SpineCharacterController destroyed');
  }
}
