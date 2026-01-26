/**
 * Spine Runtime Module
 *
 * Provides access to spine-webgl runtime loaded via script tag.
 * spine-webgl.js must be loaded before this module runs.
 */

// Declare the global spine variable (loaded via script tag in index.html)
declare const spine: any;

// Get spine from global scope (spine-webgl.js sets global 'spine' variable)
const spineRuntime = typeof spine !== 'undefined' ? spine : (window as any).spine;

if (!spineRuntime) {
  console.error('[SpineRuntime] Spine runtime not found! Make sure spine-webgl.js is loaded before this script.');
}

// Re-export the spine namespace
export { spineRuntime as spine };

// Export type for the spine namespace
export type SpineRuntime = typeof spineRuntime;
