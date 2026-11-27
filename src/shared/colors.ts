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
// Grayscale modes: grays on a 0-100 lightness scale (CIE L*: 0 is black, 100
// white, and 50 the gray that looks halfway, not #808080, which looks like 54)
// ---------------------------------------------------------------------------

/** The gray that looks `l` on the 0-100 scale. */
export function grayOf(l: number): string {
  return chroma.lab(Math.min(100, Math.max(0, l)), 0, 0).hex();
}

/** A gray's place on the 0-100 scale, as a whole number. grayValue(grayOf(n)) is n for every n in 0..100. */
export function grayValue(hex: string): number {
  return Math.round(chroma(hex).lab()[0] as number);
}

/** Gray targets: one per band from dark to light (5 to 95), shuffled, so every game covers the whole scale. */
export function generateGrays(seed: number, count: number): string[] {
  const rand = mulberry32(seed);
  const bands = shuffleInPlace(
    Array.from({ length: count }, (_, i) => i),
    rand,
  );
  const size = 90 / count;
  return bands.map((band) => grayOf(Math.round(5 + (band + rand()) * size)));
}

/**
 * Grayscale modes' error: the plain difference on the 0-100 scale. Scored with
 * the same points curve as ΔE in the other modes, but not with ΔE itself, which
 * forgives very dark and very light grays more ("off by 10" would then score
 * anywhere from 59 to 72 points, while the result says "10 too dark").
 */
export function grayError(target: string, pick: string): number {
  return Math.abs(grayValue(pick) - grayValue(target));
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

/** Rapid modes: locking in instantly earns this share of the accuracy points on top. */
export const RAPID_MAX_BONUS = 0.5;

/**
 * Rapid modes' speed bonus for a locked-in pick: up to half the accuracy points,
 * shrinking evenly to nothing at the round's original deadline (counted from
 * when picking starts: the unlock in memory modes). Proportional to
 * accuracy, so locking in a careless color fast never pays.
 */
export function speedBonus(accuracy: number, timeMs: number, roundMs: number): number {
  if (roundMs <= 0) return 0;
  const left = Math.min(1, Math.max(0, 1 - timeMs / roundMs));
  return Math.round(accuracy * RAPID_MAX_BONUS * left);
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
