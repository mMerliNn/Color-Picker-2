// Shapes and constants for the personal "history analysis" page.
// Dependency-free, so the browser can import it too.

import { isGameMode, type GameMode } from './protocol.js';

// ---------------------------------------------------------------------------
// One analysis page per game mode
//
// Each mode is a different skill (matching a color on screen is not the same as
// matching it from memory), so each gets its own page built from its own games
// only, with its own "everyone" comparison. Pages live at /stats/<mode>; the
// default mode keeps the plain /stats address.
//
// Adding a mode: add it to MODE_OPTIONS (protocol.ts) and give it an entry
// here. TypeScript refuses to compile until both are done; the server, the API,
// the page and its mode switcher all pick the new mode up from these two lists.
// ---------------------------------------------------------------------------

export interface StatsPageInfo {
  /** Name in the page switcher and the page title. */
  label: string;
  /** One line under the page heading: what this mode measures. */
  intro: string;
}

export const STATS_PAGES: Record<GameMode, StatsPageInfo> = {
  classic: { label: 'Classic', intro: 'Matching with the color on screen.' },
  rapid: { label: 'Classic · Rapid', intro: 'Matching with the color on screen, against the clock.' },
  memory: { label: 'Memory', intro: 'Matching from memory, after the color was hidden.' },
  'memory-rapid': { label: 'Memory · Rapid', intro: 'Matching from memory, against the clock.' },
};

/** The mode shown at plain /stats. */
export const DEFAULT_STATS_MODE: GameMode = 'classic';

/** Address of a mode's analysis page (without the ?profile= test query). */
export function statsPath(mode: GameMode): string {
  return mode === DEFAULT_STATS_MODE ? '/stats' : `/stats/${mode}`;
}

/** Which mode a page address is about; null when it is not a known stats page. */
export function statsModeFromPath(pathname: string): GameMode | null {
  const m = /^\/stats(?:\/([a-z0-9-]+))?\/?$/.exec(pathname);
  if (!m) return null;
  const mode = m[1] ?? DEFAULT_STATS_MODE;
  return isGameMode(mode) ? mode : null;
}

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
