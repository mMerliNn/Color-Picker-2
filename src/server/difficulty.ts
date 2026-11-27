import { COLOR_C_RANGE, COLOR_L_RANGE, PRIOR_DIFFICULTY, type DifficultyFn } from '../shared/colors.js';
import { hueBinOf, HUE_BINS } from '../shared/stats.js';

/**
 * Which colors are hard, measured from everyone's real picks.
 *
 * Color space is split into cells: 12 hue sectors x 3 lightness bands x 3
 * chroma bands. Each pick's error is divided by that player's own average
 * error, so a cell does not look hard just because beginners happened to get
 * it (1.3 = this player's errors are 30% bigger here than usual). A cell's
 * measured value is blended with the prior guess (PRIOR_DIFFICULTY), weighted
 * by how many picks it has: with PRIOR_WEIGHT picks the two count the same, and
 * with ten times that the data dominates. Before there is data, the prior alone
 * decides.
 */

export interface DifficultySample {
  targetL: number;
  targetC: number;
  targetH: number | null;
  /** The pick's error divided by the player's own average error. */
  relError: number;
}

/** Picks a cell needs before its measurement counts as much as the prior. */
export const PRIOR_WEIGHT = 40;
const L_BANDS = 3;
const C_BANDS = 3;

function band(x: number, [lo, hi]: readonly [number, number], n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(((x - lo) / (hi - lo)) * n)));
}

function cellOf(l: number, c: number, h: number | null): number | null {
  if (h === null) return null; // near-grays have no hue
  return (hueBinOf(h) * L_BANDS + band(l, COLOR_L_RANGE, L_BANDS)) * C_BANDS + band(c, COLOR_C_RANGE, C_BANDS);
}

export interface DifficultyModel {
  fn: DifficultyFn;
  /** Picks the model learned from (0 = prior only). */
  samples: number;
}

export function buildDifficulty(samples: readonly DifficultySample[], prior: DifficultyFn = PRIOR_DIFFICULTY): DifficultyModel {
  const sum = new Float64Array(HUE_BINS * L_BANDS * C_BANDS);
  const n = new Uint32Array(sum.length);
  let used = 0;
  for (const s of samples) {
    const cell = cellOf(s.targetL, s.targetC, s.targetH);
    if (cell === null || !Number.isFinite(s.relError)) continue;
    // Cap single wild picks (a mis-tap, a stuck finger) so they cannot make a cell look hard alone.
    sum[cell] = (sum[cell] as number) + Math.min(s.relError, 4);
    n[cell] = (n[cell] as number) + 1;
    used++;
  }
  const fn: DifficultyFn = (lch) => {
    const p = prior(lch);
    const cell = cellOf(lch.l, lch.c, lch.h);
    if (cell === null || !n[cell]) return p;
    const count = n[cell] as number;
    const measured = (sum[cell] as number) / count;
    return (count * measured + PRIOR_WEIGHT * p) / (count + PRIOR_WEIGHT);
  };
  return { fn, samples: used };
}
