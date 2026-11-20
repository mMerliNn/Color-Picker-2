import { hueDiff, round2 } from '../shared/colors.js';
import {
  HUE_BINS,
  MIN_BIN_PICKS,
  MIN_GLOBAL_PICKS,
  MIN_TOTAL_PICKS,
  hueBinLabel,
  hueBinOf,
  type BandStat,
  type GamePoint,
  type HueBinStat,
  type StatsResponse,
  type Totals,
} from '../shared/stats.js';
import type { GameStore, GlobalBin, PickRow } from './db.js';

interface Answered extends PickRow {
  pick_hex: string;
  delta_e: number;
}

export interface GlobalStats {
  bins: GlobalBin[];
  overall: { n: number; avg: number | null };
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function rounded(n: number | null): number | null {
  return n === null ? null : round2(n);
}
const f1 = (n: number) => n.toFixed(1);

/** Average error per band; `edges` are the upper bounds of every band but the last. */
function bands(samples: { value: number; de: number }[], edges: number[], labels: string[]): BandStat[] {
  const buckets: number[][] = labels.map(() => []);
  for (const s of samples) {
    let i = edges.findIndex((edge) => s.value < edge);
    if (i === -1) i = labels.length - 1;
    (buckets[i] as number[]).push(s.de);
  }
  return labels.map((label, i) => {
    const des = buckets[i] as number[];
    return { label, n: des.length, avgDeltaE: rounded(mean(des)) };
  });
}

/**
 * Turn a player's raw pick log into the numbers behind the analysis page.
 * Pure function: everything it needs is passed in, so it is easy to test.
 */
export function computeStats(rows: PickRow[], global: GlobalStats): StatsResponse {
  const answered = rows.filter((r): r is Answered => r.pick_hex !== null && r.delta_e !== null);
  const misses = rows.length - answered.length;
  const everyoneOverall =
    global.overall.avg !== null && global.overall.n >= MIN_GLOBAL_PICKS ? round2(global.overall.avg) : null;

  // ---- per hue sector ------------------------------------------------------
  const acc = Array.from({ length: HUE_BINS }, () => ({
    de: [] as number[],
    dl: [] as number[],
    dc: [] as number[],
    drift: [] as number[],
  }));
  for (const r of answered) {
    if (r.target_h === null) continue; // grays have no hue
    const a = acc[hueBinOf(r.target_h)] as (typeof acc)[number];
    a.de.push(r.delta_e);
    if (r.pick_l !== null) a.dl.push(r.pick_l - r.target_l);
    if (r.pick_c !== null) a.dc.push(r.pick_c - r.target_c);
    if (r.pick_h !== null) a.drift.push(hueDiff(r.target_h, r.pick_h));
  }
  const globalByBin = new Map(global.bins.map((g) => [g.bin, g]));
  const hue: HueBinStat[] = acc.map((a, bin) => {
    const n = a.de.length;
    const enough = n >= MIN_BIN_PICKS;
    const g = globalByBin.get(bin);
    return {
      bin,
      label: hueBinLabel(bin),
      start: bin * 30,
      n,
      avgDeltaE: rounded(mean(a.de)),
      everyoneAvgDeltaE: g && g.n >= MIN_GLOBAL_PICKS ? round2(g.avg) : null,
      lightnessBias: enough ? rounded(mean(a.dl)) : null,
      chromaBias: enough ? rounded(mean(a.dc)) : null,
      hueDrift: enough && a.drift.length >= MIN_BIN_PICKS ? rounded(mean(a.drift)) : null,
    };
  });

  // ---- bands ---------------------------------------------------------------
  const lightness = bands(
    answered.map((r) => ({ value: r.target_l, de: r.delta_e })),
    [40, 65],
    ['Dark', 'Medium', 'Light'],
  );
  const chroma = bands(
    answered.map((r) => ({ value: r.target_c, de: r.delta_e })),
    [30, 50],
    ['Muted', 'Medium', 'Vivid'],
  );
  const timed = answered.filter((r): r is Answered & { time_ms: number } => r.time_ms !== null);
  const time = bands(
    timed.map((r) => ({ value: r.time_ms, de: r.delta_e })),
    [5000, 10_000, 15_000],
    ['Under 5 s', '5-10 s', '10-15 s', 'Over 15 s'],
  );

  const bias = {
    n: answered.length,
    lightness: rounded(mean(answered.filter((r) => r.pick_l !== null).map((r) => (r.pick_l as number) - r.target_l))),
    chroma: rounded(mean(answered.filter((r) => r.pick_c !== null).map((r) => (r.pick_c as number) - r.target_c))),
  };

  // ---- per game ------------------------------------------------------------
  const games = new Map<string, { at: number; des: number[]; score: number; rounds: number }>();
  for (const r of rows) {
    const g = games.get(r.game_id) ?? { at: r.created_at, des: [], score: 0, rounds: 0 };
    g.at = Math.min(g.at, r.created_at);
    g.score += r.score;
    g.rounds += 1;
    if (r.delta_e !== null && r.pick_hex !== null) g.des.push(r.delta_e);
    games.set(r.game_id, g);
  }
  const ordered = [...games.entries()].sort((a, b) => a[1].at - b[1].at);
  const trend: GamePoint[] = ordered
    .filter(([, g]) => g.des.length > 0)
    .slice(-30)
    .map(([gameId, g]) => ({
      gameId,
      at: g.at,
      avgDeltaE: round2(mean(g.des) as number),
      score: g.score,
      rounds: g.rounds,
    }));

  let bestGame: Totals['bestGame'] = null;
  for (const g of games.values()) {
    if (g.rounds < 5) continue; // partial or tiny games are not comparable
    if (!bestGame || g.score / g.rounds > bestGame.score / bestGame.rounds) {
      bestGame = { score: g.score, rounds: g.rounds };
    }
  }

  const totals: Totals = {
    games: games.size,
    rounds: rows.length,
    answered: answered.length,
    misses,
    avgDeltaE: rounded(mean(answered.map((r) => r.delta_e))),
    everyoneAvgDeltaE: everyoneOverall,
    avgScore: rounded(mean(rows.map((r) => r.score))),
    bestGame,
    avgTimeMs: timed.length ? Math.round(mean(timed.map((r) => r.time_ms)) as number) : null,
  };

  return {
    totals,
    hue,
    lightness,
    chroma,
    time,
    bias,
    trend,
    insights: buildInsights(totals, hue, bias, timed, trend),
    minBinPicks: MIN_BIN_PICKS,
    minTotalPicks: MIN_TOTAL_PICKS,
  };
}

// ---------------------------------------------------------------------------
// Plain-language findings. Each rule only fires when there is enough data and
// the effect is big enough to matter, so the page never over-reads noise.
// ---------------------------------------------------------------------------

function buildInsights(
  totals: Totals,
  hue: HueBinStat[],
  bias: StatsResponse['bias'],
  timed: (Answered & { time_ms: number })[],
  trend: GamePoint[],
): string[] {
  if (totals.answered < MIN_TOTAL_PICKS) {
    const more = MIN_TOTAL_PICKS - totals.answered;
    return [
      totals.answered === 0
        ? `Play a game and come back: patterns need at least ${MIN_TOTAL_PICKS} answered rounds.`
        : `Play about ${more} more round${more === 1 ? '' : 's'} and patterns will start to appear (it takes ${MIN_TOTAL_PICKS} answered rounds).`,
    ];
  }

  const out: string[] = [];

  if (totals.avgDeltaE !== null) {
    let line = `Your average color error is ΔE ${f1(totals.avgDeltaE)} (lower is better; around 2 is the smallest difference most people can see).`;
    if (totals.everyoneAvgDeltaE !== null) {
      const diff = totals.avgDeltaE - totals.everyoneAvgDeltaE;
      line +=
        Math.abs(diff) < 0.5
          ? ` That is about the same as everyone else (${f1(totals.everyoneAvgDeltaE)}).`
          : diff < 0
            ? ` That beats the average of all players (${f1(totals.everyoneAvgDeltaE)}).`
            : ` The average of all players is ${f1(totals.everyoneAvgDeltaE)}.`;
    }
    out.push(line);
  }

  // Hardest / easiest hues
  const ranked = hue
    .filter((h) => h.n >= MIN_BIN_PICKS && h.avgDeltaE !== null)
    .sort((a, b) => (a.avgDeltaE as number) - (b.avgDeltaE as number));
  if (ranked.length >= 3) {
    const best = ranked[0] as HueBinStat;
    const worst = ranked[ranked.length - 1] as HueBinStat;
    const gap = (worst.avgDeltaE as number) - (best.avgDeltaE as number);
    if (gap >= 1.5 && (worst.avgDeltaE as number) >= (best.avgDeltaE as number) * 1.3) {
      out.push(
        `Hardest hue for you: ${worst.label.toLowerCase()} (ΔE ${f1(worst.avgDeltaE as number)}, ${worst.n} picks). Easiest: ${best.label.toLowerCase()} (ΔE ${f1(best.avgDeltaE as number)}).`,
      );
    }
  }

  // Systematic lightness / chroma bias
  if (bias.lightness !== null && Math.abs(bias.lightness) >= 1.5) {
    out.push(
      `You tend to pick colors that are ${bias.lightness > 0 ? 'lighter' : 'darker'} than the target (by about ${f1(Math.abs(bias.lightness))} lightness points). Nudge your pick ${bias.lightness > 0 ? 'darker' : 'lighter'} before locking in.`,
    );
  }
  if (bias.chroma !== null && Math.abs(bias.chroma) >= 2) {
    out.push(
      `Your picks are usually ${bias.chroma > 0 ? 'more vivid' : 'duller'} than the target (by about ${f1(Math.abs(bias.chroma))} points of saturation).`,
    );
  }

  // Hue drift in specific sectors
  const drifting = hue
    .filter((h) => h.hueDrift !== null && Math.abs(h.hueDrift) >= 3)
    .sort((a, b) => Math.abs(b.hueDrift as number) - Math.abs(a.hueDrift as number))
    .slice(0, 2);
  for (const h of drifting) {
    const toward = hueBinLabel(h.bin + ((h.hueDrift as number) > 0 ? 1 : -1)).toLowerCase();
    out.push(
      `On ${h.label.toLowerCase()} colors your picks drift about ${Math.round(Math.abs(h.hueDrift as number))}° toward ${toward}.`,
    );
  }

  // Speed vs accuracy
  if (timed.length >= 20) {
    const sorted = [...timed].sort((a, b) => a.time_ms - b.time_ms);
    const half = Math.floor(sorted.length / 2);
    const fast = mean(sorted.slice(0, half).map((r) => r.delta_e));
    const slow = mean(sorted.slice(sorted.length - half).map((r) => r.delta_e));
    if (fast !== null && slow !== null) {
      if (fast - slow >= 1.5) {
        out.push(`Taking your time pays off: your slower half of picks averages ΔE ${f1(slow)} versus ${f1(fast)} for the quick half.`);
      } else if (slow - fast >= 1.5) {
        out.push(`Your quick picks are your best (ΔE ${f1(fast)} versus ${f1(slow)} when slower). Trust your first instinct.`);
      }
    }
  }

  // Progress over time
  if (trend.length >= 6) {
    const recent = mean(trend.slice(-3).map((g) => g.avgDeltaE)) as number;
    const earlier = mean(trend.slice(-8, -3).map((g) => g.avgDeltaE)) as number;
    if (earlier - recent >= 1) {
      out.push(`You are improving: your last 3 games averaged ΔE ${f1(recent)} versus ${f1(earlier)} before that.`);
    } else if (recent - earlier >= 1) {
      out.push(`Your last 3 games were a bit worse (ΔE ${f1(recent)}) than the ones before (${f1(earlier)}).`);
    }
  }

  // Missed rounds
  if (totals.misses >= 3 && totals.misses / Math.max(1, totals.rounds) >= 0.1) {
    out.push(`You missed ${totals.misses} rounds without locking in a color. Each one scores zero, so lock in something before time runs out.`);
  }

  return out.slice(0, 7);
}

// ---------------------------------------------------------------------------

/** Reads from the store and caches the (whole-population) comparison numbers. */
export class StatsService {
  private cache: { at: number; value: GlobalStats } | null = null;

  constructor(
    private readonly store: GameStore,
    private readonly cacheMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  forClient(clientId: string): StatsResponse {
    return computeStats(this.store.picksForClient(clientId), this.global());
  }

  deleteClient(clientId: string): number {
    const removed = this.store.deleteClientData(clientId);
    this.cache = null;
    return removed;
  }

  private global(): GlobalStats {
    const t = this.now();
    if (!this.cache || t - this.cache.at >= this.cacheMs) {
      this.cache = { at: t, value: this.store.globalHueBins() };
    }
    return this.cache.value;
  }
}
