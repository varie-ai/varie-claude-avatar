/**
 * SpineCharacter - High-level wrapper for Spine character rendering
 *
 * Owns a persistent WebGL context + SceneRenderer (created once on first load).
 * On each load(), only the Spine character data (atlas, textures, skeleton,
 * controller) is swapped, preserving MSAA anti-aliasing across character switches.
 */

import {
  loadSpineData,
  getSpineRuntime,
  SpineData,
  SpineSceneRenderer,
} from './spine-loader';
import { SpineCharacterController } from './spine-character-controller';

/** Base canvas height at 1.0x scale. Canvas is always rendered at this size;
 *  visual scaling is done via CSS transform to preserve MSAA anti-aliasing. */
const BASE_HEIGHT = 540;

export class SpineCharacter {
  private container: HTMLElement;
  private controller: SpineCharacterController | null = null;

  // Persistent state (created once on first load, destroyed in destroy())
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private renderer: SpineSceneRenderer | null = null;
  private animationFrameId: number | null = null;
  private isDestroyed: boolean = false;
  private lastTime: number = 0;

  // CSS scale (visual only — does not touch WebGL drawing buffer)
  private currentScale: number = 1.0;

  // Per-character state (swapped on each load())
  private spineData: SpineData | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /**
   * Load a character from a bundle URL.
   * On first call, creates a persistent WebGL context + SceneRenderer.
   * On subsequent calls, swaps only the character data.
   */
  async load(bundleUrl: string): Promise<void> {
    console.log('[SpineCharacter] Loading:', bundleUrl);

    // 1. Create persistent WebGL context on first load
    if (!this.canvas) {
      this.createPersistentContext();
    }

    // 2. Dispose old character data (keeps canvas/GL/renderer intact)
    this.disposeCharacterData();

    // 3. Load new character data using existing GL context
    this.spineData = await loadSpineData(
      bundleUrl,
      this.gl!,
      this.container,
      {
        defaultAnimation: 'idle',
        defaultAnimationLoop: true,
        height: BASE_HEIGHT,
      }
    );

    this.controller = this.spineData.controller;
    console.log('[SpineCharacter] Loaded successfully');
    console.log('[SpineCharacter] Available animations:', this.controller.getAnimations());
    console.log('[SpineCharacter] Available expressions:', this.controller.getAvailableExpressions());
  }

  private createPersistentContext(): void {
    const spineLib = getSpineRuntime();

    // Create canvas at fixed base size (CSS transform handles visual scaling)
    const baseHeight = BASE_HEIGHT;
    const baseWidth = Math.round(baseHeight * 0.75);
    const dpr = window.devicePixelRatio || 1;

    this.canvas = document.createElement('canvas');
    this.canvas.width = baseWidth * dpr;
    this.canvas.height = baseHeight * dpr;
    this.canvas.style.width = `${baseWidth}px`;
    this.canvas.style.height = `${baseHeight}px`;
    this.canvas.style.position = 'absolute';
    this.canvas.style.left = '50%';
    this.canvas.style.top = '50%';
    this.canvas.style.transform = `translate(-50%, -50%) scale(${this.currentScale})`;
    this.container.appendChild(this.canvas);

    // Create WebGL context with anti-aliasing
    this.gl = this.canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    });
    if (!this.gl) {
      throw new Error('WebGL not supported');
    }

    // Create SceneRenderer (reused across character swaps)
    this.renderer = new spineLib.SceneRenderer(this.canvas, this.gl);

    // Start persistent render loop
    this.isDestroyed = false;
    this.lastTime = performance.now();
    this.animationFrameId = requestAnimationFrame(this.render);

    console.log('[SpineCharacter] Persistent WebGL context created');
  }

  /**
   * Render loop - runs continuously while the context is alive.
   * Draws current character if loaded, otherwise just clears (transparent).
   */
  private render = (time: number): void => {
    if (this.isDestroyed) return;

    const delta = (time - this.lastTime) / 1000;
    this.lastTime = time;

    const gl = this.gl!;
    const canvas = this.canvas!;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.spineData) {
      const spineLib = getSpineRuntime();
      const { skeleton, animationState, camera } = this.spineData;

      animationState.update(delta);
      animationState.apply(skeleton);
      skeleton.update(delta);
      skeleton.updateWorldTransform(spineLib.Physics.update);

      this.renderer!.camera.position.x = camera.centerX;
      this.renderer!.camera.position.y = camera.centerY;
      this.renderer!.camera.viewportWidth = camera.viewportWidth;
      this.renderer!.camera.viewportHeight = camera.viewportHeight;

      this.renderer!.begin();
      this.renderer!.drawSkeleton(skeleton, true);
      this.renderer!.end();
    }

    this.animationFrameId = requestAnimationFrame(this.render);
  };

  /**
   * Dispose per-character data without touching the persistent WebGL context.
   */
  private disposeCharacterData(): void {
    if (this.spineData) {
      this.spineData.controller.destroy();
      this.spineData.atlas.dispose();
      this.spineData = null;
      this.controller = null;
    }
  }

  /**
   * Set gaze target (where character looks)
   * @param x - Horizontal position, -1 (left) to 1 (right)
   * @param y - Vertical position, -1 (down) to 1 (up)
   */
  setLookTarget(x: number, y: number): void {
    this.controller?.setLookTarget(x, y);
  }

  /**
   * Trigger a blink
   */
  triggerBlink(): void {
    this.controller?.triggerBlink();
  }

  /**
   * Enable/disable speaking animation (lip sync)
   */
  setSpeaking(enabled: boolean): void {
    this.controller?.setSpeaking(enabled);
  }

  /**
   * Set character expression
   */
  setExpression(expression: string): void {
    this.controller?.setExpression(expression);
  }

  /**
   * Clear current expression
   */
  clearExpression(): void {
    this.controller?.clearExpression();
  }

  /**
   * Play a named animation
   */
  triggerMotion(motionName: string): void {
    this.controller?.playAnimation(motionName, false);
  }

  /**
   * Check if character is loaded
   */
  isLoaded(): boolean {
    return this.spineData !== null;
  }

  /**
   * Get current expression
   */
  getCurrentExpression(): string | null {
    return this.controller?.currentExpression ?? null;
  }

  /**
   * Get if character is speaking
   */
  getIsSpeaking(): boolean {
    return this.controller?.isSpeaking ?? false;
  }

  /**
   * Set visual scale via CSS transform (preserves MSAA — no WebGL buffer change).
   * Can be called before or after load(); stores the value for createPersistentContext().
   */
  setScale(scale: number): void {
    this.currentScale = scale;
    if (this.canvas) {
      this.canvas.style.transform = `translate(-50%, -50%) scale(${scale})`;
      console.log(`[SpineCharacter] CSS scale: ${scale}`);
    }
  }

  /**
   * Resize canvas to match current container dimensions
   */
  resize(): void {
    if (!this.canvas) return;
    const newBaseHeight = this.container.clientHeight || 300;
    const newBaseWidth = Math.round(newBaseHeight * 0.75);
    const currentDpr = window.devicePixelRatio || 1;
    this.canvas.width = newBaseWidth * currentDpr;
    this.canvas.height = newBaseHeight * currentDpr;
    this.canvas.style.width = `${newBaseWidth}px`;
    this.canvas.style.height = `${newBaseHeight}px`;
    console.log(`[SpineCharacter] Resized canvas to ${newBaseWidth}x${newBaseHeight} (${this.canvas.width}x${this.canvas.height} internal)`);
  }

  /**
   * Update (called each frame if needed)
   */
  update(): void {
    // Animation updates are handled internally by the render loop
  }

  /**
   * Cleanup and release all resources (persistent context + character data)
   */
  destroy(): void {
    console.log('[SpineCharacter] Destroying');
    this.isDestroyed = true;

    // Dispose per-character data
    this.disposeCharacterData();

    // Cancel render loop
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Dispose SceneRenderer
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }

    // Release WebGL context
    if (this.gl) {
      const loseCtx = this.gl.getExtension('WEBGL_lose_context');
      if (loseCtx) loseCtx.loseContext();
      this.gl = null;
    }

    // Remove canvas from DOM
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
    }
  }
}
