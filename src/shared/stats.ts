// Shapes and constants for the personal "history analysis" page.
// Dependency-free, so the browser can import it too.

/** The hue wheel is split into 12 sectors of 30 degrees (CIE LCH hue angle). */
export const HUE_BINS = 12;
/** Fewer picks than this in a sector and we call it "low data". */
export const MIN_BIN_PICKS = 5;
/** Fewer answered rounds than this and we don't try to find patterns. */
export const MIN_TOTAL_PICKS = 20;
/** Comparisons with "everyone" need at least this many picks in the sector. */
export const MIN_GLOBAL_PICKS = 50;

// Rough names for each 30-degree sector of the CIE LCH hue angle.
const HUE_BIN_NAMES = [
  'Pink-red', // 0-30
  'Red-orange', // 30-60
  'Orange-yellow', // 60-90
  'Yellow', // 90-120
  'Yellow-green', // 120-150
  'Green', // 150-180
  'Teal-cyan', // 180-210
  'Sky blue', // 210-240
  'Blue', // 240-270
  'Violet', // 270-300
  'Purple', // 300-330
  'Magenta', // 330-360
] as const;

export function hueBinOf(hue: number): number {
  const h = ((hue % 360) + 360) % 360;
  return Math.min(HUE_BINS - 1, Math.floor(h / 30));
}

export function hueBinLabel(bin: number): string {
  return HUE_BIN_NAMES[((bin % HUE_BINS) + HUE_BINS) % HUE_BINS] as string;
}

export interface Totals {
  games: number;
  rounds: number; // rows logged, including missed rounds
  answered: number;
  misses: number;
  avgDeltaE: number | null;
  everyoneAvgDeltaE: number | null;
  avgScore: number | null; // points per round, misses count as 0
  bestGame: { score: number; rounds: number } | null; // best points-per-round game
  avgTimeMs: number | null;
}

export interface HueBinStat {
  bin: number;
  label: string;
  start: number; // degrees
  n: number;
  avgDeltaE: number | null;
  everyoneAvgDeltaE: number | null;
  // Signed averages; null until the sector has MIN_BIN_PICKS picks.
  lightnessBias: number | null; // pick L* - target L*  (+ = lighter than the target)
  chromaBias: number | null; // pick C* - target C*   (+ = more vivid)
  hueDrift: number | null; // degrees, wrapped; + = toward the next sector on the wheel
}

export interface BandStat {
  label: string;
  n: number;
  avgDeltaE: number | null;
}

export interface GamePoint {
  gameId: string;
  at: number;
  avgDeltaE: number;
  score: number;
  rounds: number;
}

export interface StatsResponse {
  totals: Totals;
  hue: HueBinStat[];
  lightness: BandStat[];
  chroma: BandStat[];
  time: BandStat[];
  bias: { n: number; lightness: number | null; chroma: number | null };
  trend: GamePoint[]; // oldest first, last 30 games
  insights: string[];
  minBinPicks: number;
  minTotalPicks: number;
}
