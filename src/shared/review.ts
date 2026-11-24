// Round review: how far each pick was from its target in hue, saturation and
// brightness, as data for the review sheet and its saved image, plus a one-line
// summary tip for the whole game.
//
// Everything is in HSV because that is what the picker uses (hue slider,
// left/right = saturation, up/down = brightness), so what the review shows maps
// straight onto the controls. Dependency-free (no chroma-js), so the browser
// bundle stays small. Scoring itself still uses CIEDE2000 (colors.ts).

import type { RoundReview } from './protocol.js';

// ---------------------------------------------------------------------------
// HSV helpers
// ---------------------------------------------------------------------------

export interface Hsv {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
}

export function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { h: hue, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex({ h: hue, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + hue / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Signed hue difference b - a wrapped to (-180, 180]. */
export function hueDiff(a: number, b: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Hue barely matters for near-grays and near-blacks, so it is not judged there. */
export function isNearGray(c: Hsv): boolean {
  return c.s < 0.12 || c.v < 0.15;
}

const HUE_NAMES: [number, string][] = [
  [15, 'red'],
  [45, 'orange'],
  [70, 'yellow'],
  [100, 'yellow-green'],
  [150, 'green'],
  [175, 'teal'],
  [200, 'cyan'],
  [255, 'blue'],
  [285, 'purple'],
  [320, 'magenta'],
  [345, 'pink'],
  [360, 'red'],
];

export function hueName(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  return HUE_NAMES.find(([end]) => d < end)?.[1] ?? 'red';
}

// ---------------------------------------------------------------------------
// Per-round bars
// ---------------------------------------------------------------------------

/**
 * Below this a difference counts as "good": degrees for hue, points out of 100
 * for saturation and brightness. Used for the per-round verdicts (read out by
 * screen readers) and the summary tip.
 */
export const GOOD = 5;

/**
 * The hue bar shows the target's hue ± this many degrees. 50 makes it span 100°,
 * the same 100-unit scale as the saturation and brightness bars (0..100), so the
 * same gap between tick and dot means the same size of miss on all three.
 */
export const HUE_SPAN = 50;

/**
 * A mini slider for one property: the gradient shows that property changing
 * while the other two stay at the target's values (like the picker itself),
 * with where the target and the pick sit on it. Positions are 0..1.
 */
export interface ReviewBar {
  stops: string[];
  target: number;
  pick: number;
  /** The pick lies beyond the bar's range (hue only): -1 left, 1 right. Drawn at the end. */
  out: -1 | 0 | 1;
  /** No marks: the hue of a near-gray target, where hue does not matter. */
  faded: boolean;
}

export interface ReviewNote {
  label: 'Hue' | 'Saturation' | 'Brightness';
  /** Short verdict such as "slightly orange" or "good" (read out by screen readers). */
  text: string;
  good: boolean;
  bar: ReviewBar;
}

function sample(n: number, f: (x: number) => string): string[] {
  return Array.from({ length: n }, (_, i) => f(i / (n - 1)));
}

function hueBar(t: Hsv, dh: number, faded: boolean): ReviewBar {
  // Keep the strip readable for dark or muted targets.
  const s = Math.max(t.s, 0.5);
  const v = Math.max(t.v, 0.7);
  const pos = 0.5 + dh / (2 * HUE_SPAN);
  return {
    stops: sample(13, (x) => hsvToHex({ h: (t.h + (x - 0.5) * 2 * HUE_SPAN + 360) % 360, s, v })),
    target: 0.5,
    pick: clamp01(pos),
    out: pos < 0 ? -1 : pos > 1 ? 1 : 0,
    faded,
  };
}

function degree(diff: number): string | null {
  const a = Math.abs(diff);
  if (a < GOOD) return null;
  if (a < 12) return 'slightly';
  if (a < 25) return 'too';
  return 'far too';
}

/** Hue, saturation and brightness of one pick compared with its target. */
export function reviewNotes(target: string, pick: string): ReviewNote[] {
  const t = hexToHsv(target);
  const p = hexToHsv(pick);
  const notes: ReviewNote[] = [];

  const dh = hueDiff(t.h, p.h);
  if (isNearGray(t)) {
    notes.push({ label: 'Hue', text: 'n/a (near gray)', good: true, bar: hueBar(t, 0, true) });
  } else {
    const deg = degree(dh);
    // Name the hue in the direction the pick drifted (at least 30° away, so a
    // small drift from red still reads "orange", not "red").
    const toward = hueName(t.h + Math.sign(dh) * Math.max(30, Math.abs(dh)));
    notes.push({ label: 'Hue', text: deg ? `${deg} ${toward}` : 'good', good: !deg, bar: hueBar(t, dh, false) });
  }

  const ds = (p.s - t.s) * 100;
  const sDeg = degree(ds);
  notes.push({
    label: 'Saturation',
    text: sDeg ? `${sDeg} ${ds < 0 ? 'muted' : 'vivid'}` : 'good',
    good: !sDeg,
    bar: {
      stops: sample(6, (x) => hsvToHex({ h: t.h, s: x, v: t.v })),
      target: t.s,
      pick: p.s,
      out: 0,
      faded: false,
    },
  });

  const dv = (p.v - t.v) * 100;
  const vDeg = degree(dv);
  notes.push({
    label: 'Brightness',
    text: vDeg ? `${vDeg} ${dv < 0 ? 'dark' : 'bright'}` : 'good',
    good: !vDeg,
    bar: {
      stops: sample(6, (x) => hsvToHex({ h: t.h, s: t.s, v: x })),
      target: t.v,
      pick: p.v,
      out: 0,
      faded: false,
    },
  });

  return notes;
}

// ---------------------------------------------------------------------------
// Summary tip: one or two short sentences about the whole game.
//
// Saturation and brightness lean the same way in every round (too muted, too
// dark), so a consistent lean there is a habit worth naming. Hue drifts toward
// a different neighbour each round, so for hue only the size of the miss counts.
// ---------------------------------------------------------------------------

const PROP_NAME = { h: 'hue', s: 'saturation', v: 'brightness' } as const;

function joinAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Null when there is nothing to say (no picks at all). */
export function summaryTip(rounds: readonly Pick<RoundReview, 'target' | 'pick'>[]): string | null {
  const diffs = { h: [] as number[], s: [] as number[], v: [] as number[] };
  for (const r of rounds) {
    if (!r.pick) continue;
    const t = hexToHsv(r.target);
    const p = hexToHsv(r.pick);
    if (!isNearGray(t)) diffs.h.push(hueDiff(t.h, p.h));
    diffs.s.push((p.s - t.s) * 100);
    diffs.v.push((p.v - t.v) * 100);
  }
  if (diffs.s.length === 0) return null;

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanAbs = (xs: number[]) => (xs.length ? mean(xs.map(Math.abs)) : 0);

  // A habit: the average lean is outside the good range, and most rounds lean that way.
  const habits: string[] = [];
  for (const [prop, low, high] of [
    ['s', 'muted', 'vivid'],
    ['v', 'dark', 'bright'],
  ] as const) {
    const xs = diffs[prop];
    const m = mean(xs);
    const sameWay = xs.filter((x) => Math.sign(x) === Math.sign(m)).length / xs.length;
    if (Math.abs(m) >= GOOD && sameWay >= 0.6) habits.push(`too ${m < 0 ? low : high}`);
  }

  const typical = (['h', 's', 'v'] as const).map((prop) => ({ prop, miss: meanAbs(diffs[prop]) }));
  const strong = typical.filter((x) => x.miss < GOOD).map((x) => PROP_NAME[x.prop]);
  const weakest = typical.reduce((a, b) => (b.miss > a.miss ? b : a));

  if (strong.length === 3) return 'Spot on: hue, saturation and brightness all landed in the good range.';

  const parts: string[] = [];
  if (habits.length) parts.push(`You tend to pick colors ${joinAnd(habits)}.`);
  else parts.push(`Your misses go both ways; ${PROP_NAME[weakest.prop]} was off the most.`);
  if (strong.length) parts.push(`${capitalize(joinAnd(strong))} ${strong.length > 1 ? 'were' : 'was'} on target.`);
  else if (habits.length && weakest.prop === 'h') parts.push('Hue was off the most.');
  return parts.join(' ');
}
