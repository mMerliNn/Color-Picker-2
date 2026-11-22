import { describe, expect, it } from 'vitest';
import type { PickRow } from '../src/server/db.js';
import { computeStats, type GlobalStats } from '../src/server/stats.js';
import { hueBinLabel, hueBinOf } from '../src/shared/stats.js';

const NO_GLOBAL: GlobalStats = { bins: [], overall: { n: 0, avg: null } };

let seq = 0;
function row(o: Partial<PickRow> = {}): PickRow {
  return {
    game_id: 'g1',
    round: seq++,
    pick_hex: '#808080',
    delta_e: 5,
    score: 76,
    time_ms: 8000,
    target_l: 50,
    target_c: 40,
    target_h: 100,
    pick_l: 50,
    pick_c: 40,
    pick_h: 100,
    created_at: 1000,
    ...o,
  };
}
function many(n: number, o: Partial<PickRow> | ((i: number) => Partial<PickRow>) = {}): PickRow[] {
  return Array.from({ length: n }, (_, i) => row(typeof o === 'function' ? o(i) : o));
}
const hueBin = (stats: ReturnType<typeof computeStats>, bin: number) => stats.hue[bin]!;

describe('hue sectors', () => {
  it('maps angles to 30-degree sectors with wraparound', () => {
    expect(hueBinOf(0)).toBe(0);
    expect(hueBinOf(29.99)).toBe(0);
    expect(hueBinOf(30)).toBe(1);
    expect(hueBinOf(359.9)).toBe(11);
    expect(hueBinOf(360)).toBe(0);
    expect(hueBinOf(-10)).toBe(11);
    expect(hueBinLabel(12)).toBe(hueBinLabel(0)); // wraps
    expect(hueBinLabel(-1)).toBe(hueBinLabel(11));
  });
});

describe('computeStats: basics', () => {
  it('handles a player with no history', () => {
    const s = computeStats([], NO_GLOBAL);
    expect(s.totals).toMatchObject({ games: 0, rounds: 0, answered: 0, misses: 0, avgDeltaE: null, bestGame: null });
    expect(s.hue).toHaveLength(12);
    expect(s.hue.every((h) => h.n === 0 && h.avgDeltaE === null)).toBe(true);
    expect(s.trend).toEqual([]);
    expect(s.insights).toHaveLength(1);
    expect(s.insights[0]).toMatch(/Play a game/);
  });

  it('puts picks into the right sector and averages their error', () => {
    const s = computeStats(
      [
        row({ target_h: 10, delta_e: 4 }),
        row({ target_h: 20, delta_e: 6 }),
        row({ target_h: 30, delta_e: 10 }), // boundary belongs to sector 1
        row({ target_h: 359, delta_e: 2 }),
      ],
      NO_GLOBAL,
    );
    expect(hueBin(s, 0)).toMatchObject({ n: 2, avgDeltaE: 5 });
    expect(hueBin(s, 1)).toMatchObject({ n: 1, avgDeltaE: 10 });
    expect(hueBin(s, 11)).toMatchObject({ n: 1, avgDeltaE: 2 });
    expect(hueBin(s, 5).n).toBe(0);
  });

  it('counts missed rounds separately and leaves them out of every error average', () => {
    const s = computeStats(
      [
        row({ delta_e: 10, score: 57 }),
        row({ pick_hex: null, delta_e: null, score: 0, time_ms: null, pick_l: null, pick_c: null, pick_h: null }),
      ],
      NO_GLOBAL,
    );
    expect(s.totals).toMatchObject({ rounds: 2, answered: 1, misses: 1, avgDeltaE: 10, avgScore: 28.5 });
    expect(s.totals.avgTimeMs).toBe(8000);
    expect(hueBin(s, 3).n).toBe(1);
  });

  it('ignores gray targets (no hue) for hue sectors but still counts them elsewhere', () => {
    const s = computeStats([row({ target_h: null, target_c: 0.5, target_l: 80, delta_e: 3 })], NO_GLOBAL);
    expect(s.hue.every((h) => h.n === 0)).toBe(true);
    expect(s.lightness[2]).toMatchObject({ label: 'Light', n: 1, avgDeltaE: 3 });
    expect(s.totals.answered).toBe(1);
  });

  it('buckets lightness, chroma and time', () => {
    const s = computeStats(
      [
        row({ target_l: 20, target_c: 10, time_ms: 2000, delta_e: 1 }),
        row({ target_l: 50, target_c: 40, time_ms: 7000, delta_e: 2 }),
        row({ target_l: 80, target_c: 70, time_ms: 12_000, delta_e: 3 }),
        row({ target_l: 80, target_c: 70, time_ms: 19_000, delta_e: 5 }),
      ],
      NO_GLOBAL,
    );
    expect(s.lightness.map((b) => [b.label, b.n, b.avgDeltaE])).toEqual([
      ['Dark', 1, 1],
      ['Medium', 1, 2],
      ['Light', 2, 4],
    ]);
    expect(s.chroma.map((b) => b.n)).toEqual([1, 1, 2]);
    expect(s.time.map((b) => b.n)).toEqual([1, 1, 1, 1]);
  });
});

describe('computeStats: bias', () => {
  it('reports signed lightness/chroma bias and hue drift only once a sector has enough picks', () => {
    const few = computeStats(many(4, { pick_l: 54, pick_c: 35, pick_h: 108 }), NO_GLOBAL);
    expect(hueBin(few, 3)).toMatchObject({ n: 4, lightnessBias: null, chromaBias: null, hueDrift: null });

    const enough = computeStats(many(6, { pick_l: 54, pick_c: 35, pick_h: 108 }), NO_GLOBAL);
    expect(hueBin(enough, 3)).toMatchObject({ lightnessBias: 4, chromaBias: -5, hueDrift: 8 });
    expect(enough.bias).toEqual({ n: 6, lightness: 4, chroma: -5 });
  });

  it('wraps hue drift across 0/360 degrees', () => {
    const s = computeStats(many(6, { target_h: 355, pick_h: 5 }), NO_GLOBAL);
    expect(hueBin(s, 11).hueDrift).toBe(10); // not -350
    const back = computeStats(many(6, { target_h: 5, pick_h: 355 }), NO_GLOBAL);
    expect(hueBin(back, 0).hueDrift).toBe(-10);
  });

  it('skips drift for gray picks (hue undefined) without breaking other biases', () => {
    const s = computeStats(many(6, { pick_h: null, pick_c: 0.4 }), NO_GLOBAL);
    expect(hueBin(s, 3).hueDrift).toBeNull();
    expect(hueBin(s, 3).chromaBias).toBeCloseTo(-39.6, 5);
  });
});

describe('computeStats: comparison with everyone', () => {
  it('uses the global numbers only where there is enough data', () => {
    const global: GlobalStats = {
      bins: [
        { bin: 3, n: 80, avg: 6.123 },
        { bin: 4, n: 10, avg: 9 },
      ],
      overall: { n: 400, avg: 7.456 },
    };
    const s = computeStats(many(3, { target_h: 100 }), global);
    expect(hueBin(s, 3).everyoneAvgDeltaE).toBe(6.12);
    expect(hueBin(s, 4).everyoneAvgDeltaE).toBeNull(); // only 10 picks: not meaningful
    expect(hueBin(s, 0).everyoneAvgDeltaE).toBeNull();
    expect(s.totals.everyoneAvgDeltaE).toBe(7.46);
    expect(computeStats([], { bins: [], overall: { n: 10, avg: 3 } }).totals.everyoneAvgDeltaE).toBeNull();
  });
});

describe('computeStats: games and trend', () => {
  const game = (id: string, at: number, n: number, de: number, score: number) =>
    many(n, { game_id: id, created_at: at, delta_e: de, score });

  it('orders games oldest first, averages per game and finds the best one', () => {
    const rows = [
      ...game('b', 2000, 5, 10, 50), // newer, worse
      ...game('a', 1000, 5, 20, 20), // older
      ...game('c', 3000, 5, 4, 80), // newest, best
      ...game('tiny', 4000, 2, 0, 100), // too short to be the "best game"
    ];
    const s = computeStats(rows, NO_GLOBAL);
    expect(s.trend.map((g) => g.gameId)).toEqual(['a', 'b', 'c', 'tiny']);
    expect(s.trend.map((g) => g.avgDeltaE)).toEqual([20, 10, 4, 0]);
    expect(s.totals.games).toBe(4);
    expect(s.totals.bestGame).toEqual({ score: 400, rounds: 5 });
  });

  it('keeps only the last 30 games', () => {
    const rows = Array.from({ length: 35 }, (_, i) => game(`g${i}`, 1000 + i, 5, 5, 70)).flat();
    const s = computeStats(rows, NO_GLOBAL);
    expect(s.trend).toHaveLength(30);
    expect(s.trend[0]!.gameId).toBe('g5');
    expect(s.trend.at(-1)!.gameId).toBe('g34');
  });
});

describe('computeStats: insights', () => {
  it('asks for more rounds while data is thin, and says how many', () => {
    const s = computeStats(many(12), NO_GLOBAL);
    expect(s.insights).toHaveLength(1);
    expect(s.insights[0]).toMatch(/8 more rounds/);
  });

  it('flags a systematic lightness and chroma bias', () => {
    const s = computeStats(many(30, { pick_l: 56, pick_c: 33 }), NO_GLOBAL);
    const text = s.insights.join('\n');
    expect(text).toMatch(/lighter than the target \(by about 6\.0/);
    expect(text).toMatch(/duller than the target \(by about 7\.0/);
  });

  it('stays quiet about tiny biases', () => {
    const s = computeStats(many(30, { pick_l: 50.5, pick_c: 40.5 }), NO_GLOBAL);
    expect(s.insights.join('\n')).not.toMatch(/lighter|darker|vivid|duller/);
  });

  it('names the hardest and easiest hues', () => {
    const rows = [
      ...many(8, { target_h: 100, delta_e: 3 }), // yellow: easy
      ...many(8, { target_h: 150, delta_e: 5 }), // green
      ...many(8, { target_h: 255, delta_e: 12 }), // blue: hard
    ];
    const text = computeStats(rows, NO_GLOBAL).insights.join('\n');
    expect(text).toMatch(/Hardest hue for you: blue \(ΔE 12\.0, 8 picks\)\. Easiest: yellow \(ΔE 3\.0\)/);
  });

  it('describes hue drift direction using the neighbouring sector', () => {
    const rows = many(30, { target_h: 255, pick_h: 263, pick_l: 50 });
    const text = computeStats(rows, NO_GLOBAL).insights.join('\n');
    expect(text).toMatch(/On blue colors your picks drift about 8° toward violet/);
    const wrap = computeStats(many(30, { target_h: 355, pick_h: 5 }), NO_GLOBAL).insights.join('\n');
    expect(wrap).toMatch(/On magenta colors your picks drift about 10° toward pink-red/);
  });

  it('notices when slower picks are more accurate', () => {
    const rows = [...many(15, { time_ms: 3000, delta_e: 9 }), ...many(15, { time_ms: 14_000, delta_e: 4 })];
    expect(computeStats(rows, NO_GLOBAL).insights.join('\n')).toMatch(/Taking your time pays off/);
    const reverse = [...many(15, { time_ms: 3000, delta_e: 4 }), ...many(15, { time_ms: 14_000, delta_e: 9 })];
    expect(computeStats(reverse, NO_GLOBAL).insights.join('\n')).toMatch(/quick picks are your best/);
  });

  it('notices improvement over the last games', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      many(5, { game_id: `g${i}`, created_at: 1000 + i, delta_e: i < 5 ? 12 : 6 }),
    ).flat();
    expect(computeStats(rows, NO_GLOBAL).insights.join('\n')).toMatch(/You are improving: your last 3 games averaged ΔE 6\.0 versus 12\.0/);
  });

  it('mentions missed rounds only when they are frequent', () => {
    const miss = { pick_hex: null, delta_e: null, score: 0, time_ms: null, pick_l: null, pick_c: null, pick_h: null };
    const some = computeStats([...many(40), ...many(3, miss)], NO_GLOBAL);
    expect(some.insights.join('\n')).not.toMatch(/missed/); // 3 of 43 is under 10%
    const lots = computeStats([...many(25), ...many(5, miss)], NO_GLOBAL);
    expect(lots.insights.join('\n')).toMatch(/You missed 5 rounds/);
  });

  it('compares the average with everyone', () => {
    const global: GlobalStats = { bins: [], overall: { n: 500, avg: 9 } };
    expect(computeStats(many(25, { delta_e: 4 }), global).insights[0]).toMatch(/beats the average of all players \(9\.0\)/);
    expect(computeStats(many(25, { delta_e: 14 }), global).insights[0]).toMatch(/average of all players is 9\.0/);
  });
});

describe('database upgrade', () => {
  it('marks games logged before game modes existed as classic', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { GameStore } = await import('../src/server/db.js');
    const dir = mkdtempSync(join(tmpdir(), 'colormatch-db-'));
    const file = join(dir, 'old.db');
    try {
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE games (id TEXT PRIMARY KEY, room_code TEXT NOT NULL, seed INTEGER NOT NULL,
          rounds INTEGER NOT NULL, round_seconds INTEGER NOT NULL, player_count INTEGER NOT NULL,
          started_at INTEGER NOT NULL, ended_at INTEGER);
        CREATE TABLE picks (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, round INTEGER NOT NULL,
          client_id TEXT NOT NULL, player_name TEXT NOT NULL, target_hex TEXT NOT NULL, pick_hex TEXT,
          delta_e REAL, score INTEGER NOT NULL, time_ms INTEGER, target_l REAL NOT NULL, target_c REAL NOT NULL,
          target_h REAL, pick_l REAL, pick_c REAL, pick_h REAL, created_at INTEGER NOT NULL);
        INSERT INTO games VALUES ('g1', 'ABCDE', 1, 5, 20, 1, 1000, 2000);
        INSERT INTO picks (game_id, round, client_id, player_name, target_hex, pick_hex, delta_e, score, time_ms,
          target_l, target_c, target_h, pick_l, pick_c, pick_h, created_at)
          VALUES ('g1', 0, 'cid-old-00000', 'Old', '#3e63dd', '#3e63dd', 0, 100, 1000, 50, 60, 280, 50, 60, 280, 1500);
        PRAGMA user_version = 1;
      `);
      old.close();
      const store = new GameStore(file);
      expect(store.listGames()[0]).toMatchObject({ id: 'g1', mode: 'classic', memorize_seconds: null });
      expect(store.picksForClient('cid-old-00000')).toHaveLength(1); // still in the stats
      store.close();
      const again = new GameStore(file); // opening an upgraded file again changes nothing
      expect(again.listGames()).toHaveLength(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
