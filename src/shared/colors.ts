import chroma from 'chroma-js';

// ---------------------------------------------------------------------------
// Seeded randomness: the same seed always yields the same colors, so every
// player in a room (and, later, a "daily challenge") sees an identical set.
// ---------------------------------------------------------------------------

/** mulberry32: tiny, fast, good-enough seeded PRNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
  return items;
}

/** Largest chroma <= `c` that fits in sRGB for the given lightness and hue. */
function inGamutHex(l: number, c: number, h: number): string {
  let chromaValue = c;
  for (let i = 0; i < 60; i++) {
    const color = chroma.lch(l, chromaValue, h);
    if (!color.clipped()) return color.hex();
    chromaValue *= 0.94;
  }
  return chroma.lch(l, 0, h).hex();
}

/**
 * Generate `count` target colors from a seed.
 *
 * Hues are stratified: the color wheel is split into `count` equal sectors and
 * each round gets one sector (in shuffled order), so every game covers the
 * whole wheel instead of clustering by chance. Per-hue statistics later on
 * depend on this even coverage. Colors are generated in CIE LCH, which is
 * perceptually even, then clamped into the sRGB gamut.
 */
export function generateColors(seed: number, count: number): string[] {
  const rand = mulberry32(seed);
  const sectors = shuffleInPlace(
    Array.from({ length: count }, (_, i) => i),
    rand,
  );
  const sectorSize = 360 / count;
  return sectors.map((sector) => {
    const hue = (sector + rand()) * sectorSize;
    const lightness = 30 + rand() * 55; // 30..85, avoids near-black/white
    const chromaValue = 18 + rand() * 57; // 18..75, from pastel to vivid
    return inGamutHex(lightness, chromaValue, hue);
  });
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** CIEDE2000 distance: ~1 is barely noticeable, ~10+ is clearly different. */
export function deltaE(a: string, b: string): number {
  return chroma.deltaE(a, b);
}

/** Larger = more forgiving. 18 gives ΔE 5 -> 76 points, ΔE 20 -> 33. */
export const SCORE_DECAY = 18;
export const MAX_ROUND_SCORE = 100;

export function scoreFromDeltaE(dE: number): number {
  const score = Math.round(MAX_ROUND_SCORE * Math.exp(-Math.max(0, dE) / SCORE_DECAY));
  return Math.min(MAX_ROUND_SCORE, Math.max(0, score));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// LCH helpers (stored with every pick so per-hue analysis needs no recompute)
// ---------------------------------------------------------------------------

export interface Lch {
  l: number;
  c: number;
  h: number | null; // null for (near-)achromatic colors, where hue is undefined
}

export function toLch(hex: string): Lch {
  const [l, c, h] = chroma(hex).lch();
  return { l: round2(l), c: round2(c), h: c < 1 || Number.isNaN(h) ? null : round2(h) };
}

/** Signed hue difference b - a wrapped to (-180, 180]. Lives in review.ts (no chroma-js) so the browser can use it too. */
export { hueDiff } from './review.js';
