/**
 * Spine Model Loader for Desktop Overlay
 *
 * Handles loading .varie bundles and initializing Spine characters
 * using spine-webgl directly for transparent overlay rendering.
 *
 * Supports both plain (unencrypted) and legacy encrypted bundles.
 */

import { SpineCharacterController, SpineCharacterControllerConfig, SpinePlayer } from './spine-character-controller';
import { decryptLegacyBundle, needsDecryption, unpackBundle } from './legacy-decrypt';
// @ts-ignore
import { spine as spineRuntime } from './spine-runtime';

const log = {
  info: (...args: unknown[]) => console.log('[SpineLoader]', ...args),
  debug: (...args: unknown[]) => console.debug('[SpineLoader]', ...args),
  warn: (...args: unknown[]) => console.warn('[SpineLoader]', ...args),
  error: (...args: unknown[]) => console.error('[SpineLoader]', ...args),
};

// ============================================================================
// Types
// ============================================================================

export interface SpinePlayerConfig {
  defaultAnimation?: string;
  defaultAnimationLoop?: boolean;
  width?: number;
  height?: number;
}

export interface LoadSpineResult {
  controller: SpineCharacterController;
  player: SpinePlayer;
  canvas: HTMLCanvasElement;
  cleanup: () => void;
  resize: () => void;
}

// Spine runtime types (subset)
export interface SpineWebGL {
  TextureAtlas: new (atlasText: string) => SpineTextureAtlas;
  GLTexture: new (gl: WebGLRenderingContext, image: HTMLImageElement) => SpineGLTexture;
  AtlasAttachmentLoader: new (atlas: SpineTextureAtlas) => SpineAtlasAttachmentLoader;
  SkeletonJson: new (loader: SpineAtlasAttachmentLoader) => SpineSkeletonJsonLoader;
  Skeleton: new (data: SpineSkeletonData) => SpineSkeletonInstance;
  AnimationStateData: new (skeletonData: SpineSkeletonData) => SpineAnimationStateData;
  AnimationState: new (data: SpineAnimationStateData) => SpineAnimationStateInstance;
  SceneRenderer: new (canvas: HTMLCanvasElement, gl: WebGLRenderingContext) => SpineSceneRenderer;
  Vector2: new () => SpineVector2;
  Physics: { update: unknown };
}

export interface SpineTextureAtlas {
  pages: SpineAtlasPage[];
  dispose(): void;
}

interface SpineAtlasPage {
  name: string;
  setTexture(texture: SpineGLTexture): void;
}

export interface SpineGLTexture {
  dispose(): void;
}

interface SpineAtlasAttachmentLoader {}

interface SpineSkeletonJsonLoader {
  readSkeletonData(jsonText: string): SpineSkeletonData;
}

interface SpineSkeletonData {
  findAnimation(name: string): SpineAnimation | null;
}

interface SpineAnimation {
  name: string;
  duration: number;
}

export interface SpineSkeletonInstance {
  setToSetupPose(): void;
  updateWorldTransform(physics: unknown): void;
  getBounds(offset: SpineVector2, size: SpineVector2): void;
  update(delta: number): void;
  slots: unknown[];
  data: SpineSkeletonData;
  skin: unknown;
  findBone(name: string): unknown;
  findSlot(name: string): unknown;
  getAttachment(slotIndex: number, attachmentName: string): unknown;
}

interface SpineAnimationStateData {}

export interface SpineAnimationStateInstance {
  setAnimation(trackIndex: number, animationName: string, loop: boolean): unknown;
  update(delta: number): void;
  apply(skeleton: SpineSkeletonInstance): void;
  getCurrent(trackIndex: number): unknown;
  setEmptyAnimation(trackIndex: number, mixDuration: number): unknown;
}

export interface SpineSceneRenderer {
  camera: {
    position: { x: number; y: number };
    viewportWidth: number;
    viewportHeight: number;
  };
  begin(): void;
  drawSkeleton(skeleton: SpineSkeletonInstance, premultipliedAlpha: boolean): void;
  end(): void;
  dispose(): void;
}

interface SpineVector2 {
  x: number;
  y: number;
}

// ============================================================================
// Loader Implementation
// ============================================================================

/**
 * Load a Spine character from a .varie bundle URL
 */
export async function loadSpineCharacter(
  bundleUrl: string,
  container: HTMLElement,
  playerConfig: SpinePlayerConfig = {},
  controllerConfig: SpineCharacterControllerConfig = {}
): Promise<LoadSpineResult> {
  log.info(`Loading Spine character from: ${bundleUrl}`);

  const spineLib = spineRuntime as SpineWebGL;
  if (!spineLib) {
    throw new Error('Spine runtime not available');
  }

  // 1. Fetch bundle
  log.debug('Fetching bundle...');
  const response = await fetch(bundleUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch bundle: ${response.status}`);
  }
  let bundleData = await response.arrayBuffer();
  log.debug(`Fetched ${(bundleData.byteLength / 1024 / 1024).toFixed(2)} MB`);

  // 2. Decrypt if needed (legacy encrypted bundles)
  if (needsDecryption(bundleData)) {
    log.debug('Bundle is encrypted, decrypting...');
    bundleData = await decryptLegacyBundle(bundleData);
    log.debug('Decrypted successfully');
  }

  // 3. Unpack bundle
  const files = unpackBundle(bundleData);
  log.debug(`Unpacked ${files.size} files`);

  const fileList = Array.from(files.keys());
  log.debug('Bundle contents:', fileList);

  // 4. Find Spine files
  const jsonFile = fileList.find((f) => f.endsWith('.json'));
  const atlasFile = fileList.find((f) => f.endsWith('.atlas'));
  const pngFile = fileList.find((f) => f.endsWith('.png'));

  if (!jsonFile) throw new Error('No .json file found in bundle');
  if (!atlasFile) throw new Error('No .atlas file found in bundle');
  if (!pngFile) throw new Error('No .png file found in bundle');

  log.debug('Files found:', { jsonFile, atlasFile, pngFile });

  // 5. Get raw data
  const jsonData = files.get(jsonFile);
  const atlasData = files.get(atlasFile);
  const pngData = files.get(pngFile);

  if (!jsonData || !atlasData || !pngData) {
    throw new Error('Failed to get file data from bundle');
  }

  const jsonText = new TextDecoder().decode(jsonData);
  const atlasText = new TextDecoder().decode(atlasData);

  // 6. Create canvas and WebGL context
  const canvas = document.createElement('canvas');
  const baseHeight = playerConfig.height || container.clientHeight || 300;
  const baseWidth = playerConfig.width || Math.round(baseHeight * 0.75);

  // Set canvas size (2x for retina)
  const dpr = window.devicePixelRatio || 1;
  canvas.width = baseWidth * dpr;
  canvas.height = baseHeight * dpr;
  canvas.style.width = `${baseWidth}px`;
  canvas.style.height = `${baseHeight}px`;
  canvas.style.position = 'absolute';
  canvas.style.left = '50%';
  canvas.style.top = '50%';
  canvas.style.transform = 'translate(-50%, -50%)';
  container.appendChild(canvas);

  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) {
    throw new Error('WebGL not supported');
  }

  // 7. Load PNG as HTMLImageElement
  const pngBlob = new Blob([pngData], { type: 'image/png' });
  const pngUrl = URL.createObjectURL(pngBlob);

  let img: HTMLImageElement;
  try {
    img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to load texture image'));
      image.src = pngUrl;
    });
  } catch (err) {
    URL.revokeObjectURL(pngUrl);
    throw err;
  }

  log.debug('Texture loaded:', img.width, 'x', img.height);

  // 8. Create GLTexture
  const glTexture = new spineLib.GLTexture(gl, img);
  URL.revokeObjectURL(pngUrl);
  log.debug('GLTexture created');

  // 9. Create TextureAtlas and set texture
  const atlas = new spineLib.TextureAtlas(atlasText);
  for (const page of atlas.pages) {
    page.setTexture(glTexture);
  }
  log.debug('TextureAtlas created with', atlas.pages.length, 'pages');

  // 10. Load skeleton
  const atlasLoader = new spineLib.AtlasAttachmentLoader(atlas);
  const skeletonJson = new spineLib.SkeletonJson(atlasLoader);
  const skeletonData = skeletonJson.readSkeletonData(jsonText);

  // 11. Create skeleton and animation state
  const skeleton = new spineLib.Skeleton(skeletonData);
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform(spineLib.Physics.update);

  const animationStateData = new spineLib.AnimationStateData(skeletonData);
  const animationState = new spineLib.AnimationState(animationStateData);

  // Play default animation
  const defaultAnim = playerConfig.defaultAnimation ?? 'idle';
  const idleAnim = skeletonData.findAnimation(defaultAnim);
  if (idleAnim) {
    animationState.setAnimation(0, defaultAnim, playerConfig.defaultAnimationLoop ?? true);
    log.debug(`Playing animation: ${defaultAnim}`);
  }

  // 12. Create player-like object for controller
  const player: SpinePlayer = {
    skeleton: skeleton as unknown as SpinePlayer['skeleton'],
    animationState: animationState as unknown as SpinePlayer['animationState'],
  };

  // 13. Create controller
  const controller = new SpineCharacterController(player, controllerConfig);

  // 14. Setup renderer
  const renderer = new spineLib.SceneRenderer(canvas, gl);

  // Calculate skeleton bounds for camera positioning
  const offset = new spineLib.Vector2();
  const size = new spineLib.Vector2();
  skeleton.getBounds(offset, size);
  log.debug('Skeleton bounds:', offset.x, offset.y, size.x, size.y);

  // Camera position
  const centerX = offset.x + size.x / 2;
  const centerY = offset.y + size.y / 2;

  // Calculate viewport
  const canvasAspect = baseWidth / baseHeight;
  const skeletonAspect = size.x / size.y;
  const viewportPadding = 1.08;

  let viewportWidth: number;
  let viewportHeight: number;

  if (skeletonAspect > canvasAspect) {
    viewportWidth = size.x * viewportPadding;
    viewportHeight = viewportWidth / canvasAspect;
  } else {
    viewportHeight = size.y * viewportPadding;
    viewportWidth = viewportHeight * canvasAspect;
  }

  log.debug('Viewport:', viewportWidth, viewportHeight);

  // 15. Render loop
  let animationFrameId: number | null = null;
  let lastTime = performance.now();
  let isDestroyed = false;

  const render = (time: number) => {
    if (isDestroyed) return;

    const delta = (time - lastTime) / 1000;
    lastTime = time;

    // Update
    animationState.update(delta);
    animationState.apply(skeleton);
    skeleton.update(delta);
    skeleton.updateWorldTransform(spineLib.Physics.update);

    // Render
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    renderer.camera.position.x = centerX;
    renderer.camera.position.y = centerY;
    renderer.camera.viewportWidth = viewportWidth;
    renderer.camera.viewportHeight = viewportHeight;

    renderer.begin();
    renderer.drawSkeleton(skeleton, true);
    renderer.end();

    animationFrameId = requestAnimationFrame(render);
  };

  animationFrameId = requestAnimationFrame(render);
  log.info('Spine character loaded successfully');

  // 16. Resize function (updates canvas to match current container size)
  const resize = () => {
    const newBaseHeight = container.clientHeight || 300;
    const newBaseWidth = Math.round(newBaseHeight * 0.75);
    const currentDpr = window.devicePixelRatio || 1;
    canvas.width = newBaseWidth * currentDpr;
    canvas.height = newBaseHeight * currentDpr;
    canvas.style.width = `${newBaseWidth}px`;
    canvas.style.height = `${newBaseHeight}px`;
    log.info(`Resized canvas to ${newBaseWidth}x${newBaseHeight} (${canvas.width}x${canvas.height} internal)`);
  };

  // 17. Cleanup function
  const cleanup = () => {
    log.info('Cleaning up Spine character');
    isDestroyed = true;
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
    }
    controller.destroy();
    renderer.dispose();
    atlas.dispose();
    files.clear();
    // Explicitly release the WebGL context so a new one can get full MSAA
    const loseCtx = gl.getExtension('WEBGL_lose_context');
    if (loseCtx) loseCtx.loseContext();
    canvas.remove();
  };

  return {
    controller,
    player,
    canvas,
    cleanup,
    resize,
  };
}

/**
 * Check if Spine runtime is loaded
 */
export function isSpineRuntimeLoaded(): boolean {
  return spineRuntime !== undefined && typeof (spineRuntime as SpineWebGL).Skeleton === 'function';
}

/**
 * Get the Spine runtime library reference
 */
export function getSpineRuntime(): SpineWebGL {
  const lib = spineRuntime as SpineWebGL;
  if (!lib) {
    throw new Error('Spine runtime not available');
  }
  return lib;
}

// ============================================================================
// Data-Only Loader (for persistent WebGL context)
// ============================================================================

/**
 * Spine character data loaded into an existing WebGL context.
 * Does NOT own the canvas, GL context, or SceneRenderer.
 */
export interface SpineData {
  skeleton: SpineSkeletonInstance;
  animationState: SpineAnimationStateInstance;
  atlas: SpineTextureAtlas;
  glTexture: SpineGLTexture;
  controller: SpineCharacterController;
  camera: {
    centerX: number;
    centerY: number;
    viewportWidth: number;
    viewportHeight: number;
  };
}

/**
 * Load Spine character data into an existing WebGL context.
 *
 * Creates atlas, textures, skeleton, animation state, and controller
 * but does NOT create canvas, WebGL context, SceneRenderer, or render loop.
 * This allows the caller to reuse a single GL context across character swaps,
 * preserving MSAA anti-aliasing.
 */
export async function loadSpineData(
  bundleUrl: string,
  gl: WebGLRenderingContext,
  container: HTMLElement,
  playerConfig: SpinePlayerConfig = {},
  controllerConfig: SpineCharacterControllerConfig = {}
): Promise<SpineData> {
  log.info(`Loading Spine data from: ${bundleUrl}`);

  const spineLib = getSpineRuntime();

  // 1. Fetch bundle
  log.debug('Fetching bundle...');
  const response = await fetch(bundleUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch bundle: ${response.status}`);
  }
  let bundleData = await response.arrayBuffer();
  log.debug(`Fetched ${(bundleData.byteLength / 1024 / 1024).toFixed(2)} MB`);

  // 2. Decrypt if needed (legacy encrypted bundles)
  if (needsDecryption(bundleData)) {
    log.debug('Bundle is encrypted, decrypting...');
    bundleData = await decryptLegacyBundle(bundleData);
    log.debug('Decrypted successfully');
  }

  // 3. Unpack bundle
  const files = unpackBundle(bundleData);
  log.debug(`Unpacked ${files.size} files`);

  const fileList = Array.from(files.keys());
  log.debug('Bundle contents:', fileList);

  // 4. Find Spine files
  const jsonFile = fileList.find((f) => f.endsWith('.json'));
  const atlasFile = fileList.find((f) => f.endsWith('.atlas'));
  const pngFile = fileList.find((f) => f.endsWith('.png'));

  if (!jsonFile) throw new Error('No .json file found in bundle');
  if (!atlasFile) throw new Error('No .atlas file found in bundle');
  if (!pngFile) throw new Error('No .png file found in bundle');

  log.debug('Files found:', { jsonFile, atlasFile, pngFile });

  // 5. Get raw data
  const jsonData = files.get(jsonFile);
  const atlasData = files.get(atlasFile);
  const pngData = files.get(pngFile);

  if (!jsonData || !atlasData || !pngData) {
    throw new Error('Failed to get file data from bundle');
  }

  const jsonText = new TextDecoder().decode(jsonData);
  const atlasText = new TextDecoder().decode(atlasData);

  // 6. Load PNG as HTMLImageElement
  const pngBlob = new Blob([pngData], { type: 'image/png' });
  const pngUrl = URL.createObjectURL(pngBlob);

  let img: HTMLImageElement;
  try {
    img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to load texture image'));
      image.src = pngUrl;
    });
  } catch (err) {
    URL.revokeObjectURL(pngUrl);
    throw err;
  }

  log.debug('Texture loaded:', img.width, 'x', img.height);

  // 7. Create GLTexture using provided GL context
  const glTexture = new spineLib.GLTexture(gl, img);
  URL.revokeObjectURL(pngUrl);
  log.debug('GLTexture created');

  // 8. Create TextureAtlas and set texture
  const atlas = new spineLib.TextureAtlas(atlasText);
  for (const page of atlas.pages) {
    page.setTexture(glTexture);
  }
  log.debug('TextureAtlas created with', atlas.pages.length, 'pages');

  // 9. Load skeleton
  const atlasLoader = new spineLib.AtlasAttachmentLoader(atlas);
  const skeletonJson = new spineLib.SkeletonJson(atlasLoader);
  const skeletonData = skeletonJson.readSkeletonData(jsonText);

  // 10. Create skeleton and animation state
  const skeleton = new spineLib.Skeleton(skeletonData);
  skeleton.setToSetupPose();
  skeleton.updateWorldTransform(spineLib.Physics.update);

  const animationStateData = new spineLib.AnimationStateData(skeletonData);
  const animationState = new spineLib.AnimationState(animationStateData);

  // Play default animation
  const defaultAnim = playerConfig.defaultAnimation ?? 'idle';
  const idleAnim = skeletonData.findAnimation(defaultAnim);
  if (idleAnim) {
    animationState.setAnimation(0, defaultAnim, playerConfig.defaultAnimationLoop ?? true);
    log.debug(`Playing animation: ${defaultAnim}`);
  }

  // 11. Create player object for controller
  const player: SpinePlayer = {
    skeleton: skeleton as unknown as SpinePlayer['skeleton'],
    animationState: animationState as unknown as SpinePlayer['animationState'],
  };

  // 12. Create controller
  const controller = new SpineCharacterController(player, controllerConfig);

  // 13. Calculate camera bounds
  const offset = new spineLib.Vector2();
  const size = new spineLib.Vector2();
  skeleton.getBounds(offset, size);
  log.debug('Skeleton bounds:', offset.x, offset.y, size.x, size.y);

  const centerX = offset.x + size.x / 2;
  const centerY = offset.y + size.y / 2;

  const baseHeight = playerConfig.height || container.clientHeight || 300;
  const baseWidth = playerConfig.width || Math.round(baseHeight * 0.75);
  const canvasAspect = baseWidth / baseHeight;
  const skeletonAspect = size.x / size.y;
  const viewportPadding = 1.08;

  let viewportWidth: number;
  let viewportHeight: number;

  if (skeletonAspect > canvasAspect) {
    viewportWidth = size.x * viewportPadding;
    viewportHeight = viewportWidth / canvasAspect;
  } else {
    viewportHeight = size.y * viewportPadding;
    viewportWidth = viewportHeight * canvasAspect;
  }

  log.debug('Viewport:', viewportWidth, viewportHeight);

  // Release bundle data
  files.clear();

  log.info('Spine data loaded successfully');

  return {
    skeleton,
    animationState,
    atlas,
    glTexture,
    controller,
    camera: { centerX, centerY, viewportWidth, viewportHeight },
  };
}
