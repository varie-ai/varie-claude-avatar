/**
 * Session color themes for multi-session notification display.
 * 10 base themes × 3 variants (normal, darker, lighter) = 30 total.
 * Round-robin assignment to sessions as they appear.
 */

export interface ColorVariant {
  background: string;
  border: string;
  toolBadge: string;
  toolText: string;
}

interface BaseColor {
  name: string;
  r: number; g: number; b: number; // border accent RGB
  bgR: number; bgG: number; bgB: number; // background tint RGB
}

const BASE_COLORS: BaseColor[] = [
  { name: 'amber',   r: 255, g: 180, b: 0,   bgR: 35, bgG: 32, bgB: 25 },
  { name: 'cyan',    r: 0,   g: 200, b: 220, bgR: 20, bgG: 35, bgB: 38 },
  { name: 'violet',  r: 160, g: 100, b: 255, bgR: 30, bgG: 25, bgB: 45 },
  { name: 'rose',    r: 255, g: 100, b: 130, bgR: 38, bgG: 25, bgB: 28 },
  { name: 'lime',    r: 140, g: 220, b: 60,  bgR: 28, bgG: 35, bgB: 22 },
  { name: 'coral',   r: 255, g: 130, b: 80,  bgR: 38, bgG: 30, bgB: 25 },
  { name: 'sky',     r: 100, g: 180, b: 255, bgR: 22, bgG: 28, bgB: 40 },
  { name: 'mint',    r: 80,  g: 220, b: 170, bgR: 22, bgG: 38, bgB: 32 },
  { name: 'gold',    r: 240, g: 200, b: 80,  bgR: 36, bgG: 34, bgB: 22 },
  { name: 'magenta', r: 220, g: 80,  b: 200, bgR: 38, bgG: 22, bgB: 35 },
];

function buildVariant(base: BaseColor, variant: 'normal' | 'darker' | 'lighter'): ColorVariant {
  let borderAlpha: number;
  let bgOffset: number;
  let badgeAlpha: number;

  switch (variant) {
    case 'darker':
      borderAlpha = 0.35;
      bgOffset = -5;
      badgeAlpha = 0.10;
      break;
    case 'lighter':
      borderAlpha = 0.65;
      bgOffset = 8;
      badgeAlpha = 0.20;
      break;
    default: // normal
      borderAlpha = 0.5;
      bgOffset = 0;
      badgeAlpha = 0.15;
      break;
  }

  const clamp = (n: number) => Math.max(0, Math.min(255, n));

  return {
    border: `rgba(${base.r}, ${base.g}, ${base.b}, ${borderAlpha})`,
    background: `rgba(${clamp(base.bgR + bgOffset)}, ${clamp(base.bgG + bgOffset)}, ${clamp(base.bgB + bgOffset)}, 0.96)`,
    toolBadge: `rgba(${base.r}, ${base.g}, ${base.b}, ${badgeAlpha})`,
    toolText: `rgba(${base.r}, ${base.g}, ${base.b}, 0.9)`,
  };
}

// Pre-build all variants
interface ThemeVariants {
  normal: ColorVariant;
  darker: ColorVariant;
  lighter: ColorVariant;
}

const THEMES: ThemeVariants[] = BASE_COLORS.map(base => ({
  normal: buildVariant(base, 'normal'),
  darker: buildVariant(base, 'darker'),
  lighter: buildVariant(base, 'lighter'),
}));

/**
 * Assigns color themes to sessions round-robin.
 */
export class SessionColorAssigner {
  private sessionColorMap: Map<string, number> = new Map();
  private nextIndex = 0;

  private getThemeIndex(sessionId: string): number {
    if (!this.sessionColorMap.has(sessionId)) {
      this.sessionColorMap.set(sessionId, this.nextIndex % THEMES.length);
      this.nextIndex++;
    }
    return this.sessionColorMap.get(sessionId)!;
  }

  getVariant(sessionId: string, variant: 'normal' | 'darker' | 'lighter'): ColorVariant {
    const idx = this.getThemeIndex(sessionId);
    return THEMES[idx][variant];
  }

  removeSession(sessionId: string): void {
    this.sessionColorMap.delete(sessionId);
    // nextIndex does NOT reset — prevents immediate color reuse
  }

  getAssignedSessionCount(): number {
    return this.sessionColorMap.size;
  }

  hasSession(sessionId: string): boolean {
    return this.sessionColorMap.has(sessionId);
  }
}
