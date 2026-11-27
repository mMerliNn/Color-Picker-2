import { describe, expect, it } from 'vitest';
import {
  deltaE,
  generateColors,
  generateGrays,
  grayError,
  grayOf,
  grayValue,
  hueDiff,
  mulberry32,
  scoreFromDeltaE,
  speedBonus,
  toLch,
} from '../src/shared/colors.js';
import { matchLabel } from '../src/shared/labels.js';
import { DEFAULT_SETTINGS, cleanSettings, fitSettings, shotClockDeadline } from '../src/shared/protocol.js';

describe('generateColors', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    expect(generateColors(12345, 10)).toEqual(generateColors(12345, 10));
    expect(generateColors(12345, 10)).not.toEqual(generateColors(54321, 10));
  });

  it('returns valid, distinct hex colors', () => {
    const colors = generateColors(7, 10);
    expect(colors).toHaveLength(10);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(colors).size).toBe(10);
  });

  it('covers the color wheel: one color per hue sector', () => {
    // Hex rounding shifts hue slightly (measured worst case over 20k colors:
    // < 2 degrees), so allow 3 degrees of slack around each 36-degree sector.
    const circularDistanceToSector = (hue: number, sector: number) => {
      const start = sector * 36;
      const end = start + 36;
      if (hue >= start && hue <= end) return 0;
      const d = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
      return Math.min(d(hue, start), d(hue, end));
    };
    for (const seed of [1, 2, 3, 99, 4242, 123456789]) {
      const hues = generateColors(seed, 10).map((c) => toLch(c).h);
      expect(hues.every((h) => h !== null)).toBe(true);
      for (let sector = 0; sector < 10; sector++) {
        const covered = hues.some((h) => circularDistanceToSector(h as number, sector) <= 3);
        expect(covered, `seed ${seed}, sector ${sector}`).toBe(true);
      }
    }
  });

  it('supports other round counts', () => {
    expect(generateColors(5, 5)).toHaveLength(5);
  });
});

describe('Rapid speed bonus', () => {
  it('is half the accuracy points at once, shrinking evenly to nothing at the deadline', () => {
    expect(speedBonus(100, 0, 20_000)).toBe(50);
    expect(speedBonus(100, 10_000, 20_000)).toBe(25);
    expect(speedBonus(100, 20_000, 20_000)).toBe(0);
    expect(speedBonus(100, 25_000, 20_000)).toBe(0); // a late pick in the grace window
  });

  it('is proportional to accuracy, so a fast careless pick earns little', () => {
    expect(speedBonus(20, 0, 20_000)).toBe(10);
    expect(speedBonus(0, 0, 20_000)).toBe(0);
  });
});

describe('grayscale modes', () => {
  it('turns every number from 0 to 100 into a gray and back', () => {
    for (let n = 0; n <= 100; n++) expect(grayValue(grayOf(n))).toBe(n);
    expect(grayOf(0)).toBe('#000000');
    expect(grayOf(100)).toBe('#ffffff');
    expect(grayValue('#808080')).toBe(54); // 50% in hex looks like 54, not 50
  });

  it('spreads each game from dark to light: one gray per band', () => {
    const grays = generateGrays(1234, 5).map(grayValue);
    const bands = grays.map((l) => Math.min(4, Math.floor((l - 5) / 18))).sort();
    expect(bands).toEqual([0, 1, 2, 3, 4]);
    expect(generateGrays(1234, 5)).toEqual(generateGrays(1234, 5)); // same seed, same grays
    for (const hex of generateGrays(99, 10)) expect(toLch(hex).c).toBeLessThan(0.5); // truly gray
  });

  it('scores the plain difference, so "off by 10" always costs the same', () => {
    for (const l of [10, 50, 90]) expect(grayError(grayOf(l), grayOf(l - 10))).toBe(10);
    expect(scoreFromDeltaE(grayError(grayOf(50), grayOf(60)))).toBe(57);
  });

  it('has its own time options: 10, 20 or 30 seconds', () => {
    expect(cleanSettings({ roundSeconds: 10 })).toEqual({ roundSeconds: 10 });
    expect(cleanSettings({ roundSeconds: 25 })).toBeNull();
    const fit = (mode: string, roundSeconds: number) => fitSettings({ ...DEFAULT_SETTINGS, mode, roundSeconds } as never).roundSeconds;
    expect(fit('grayscale', 10)).toBe(10);
    expect(fit('grayscale', 60)).toBe(20); // not offered for grays
    expect(fit('grayscale', 0)).toBe(20);
    expect(fit('classic', 10)).toBe(20); // 10 s is a grayscale-only option
    expect(fit('classic', 0)).toBe(0); // unlimited stays for classic (solo)
    expect(fit('rapid', 0)).toBe(20); // the rapid modes need a deadline
  });
});

describe('Rapid shot clock', () => {
  it('halves the time left, to at most 10 s and at least 5 s, and never adds time', () => {
    expect(shotClockDeadline(0, 20_000)).toBe(10_000);
    expect(shotClockDeadline(2_000, 20_000)).toBe(11_000); // 18 s left: 9 s
    expect(shotClockDeadline(12_000, 20_000)).toBe(17_000); // 8 s left: 5 s, not 4
    expect(shotClockDeadline(16_000, 20_000)).toBe(20_000); // 4 s left: unchanged
  });

  it('caps long rounds at 10 s, changing gradually (no jump at the cap)', () => {
    expect(shotClockDeadline(20_000, 60_000)).toBe(30_000); // 40 s left: 10 s, not 20
    expect(shotClockDeadline(3_000, 30_000)).toBe(13_000); // 27 s left: 10 s, not 13.5
    expect(shotClockDeadline(48_000, 60_000)).toBe(54_000); // 12 s left: 6 s
    const left = (now: number) => shotClockDeadline(now, 60_000) - now;
    expect(left(39_900)).toBe(10_000);
    expect(left(40_100)).toBe(9950); // just past the cap: barely less
  });
});

describe('scoring', () => {
  it('maps deltaE to a monotonic 0..100 score', () => {
    expect(scoreFromDeltaE(0)).toBe(100);
    let prev = 101;
    for (const dE of [0.5, 1, 2, 5, 10, 20, 40, 100, 500]) {
      const s = scoreFromDeltaE(dE);
      expect(s).toBeLessThanOrEqual(prev);
      expect(s).toBeGreaterThanOrEqual(0);
      prev = s;
    }
    expect(scoreFromDeltaE(-3)).toBe(100);
  });

  it('computes CIEDE2000 distances', () => {
    expect(deltaE('#336699', '#336699')).toBe(0);
    expect(deltaE('#000000', '#ffffff')).toBeGreaterThan(90);
    expect(deltaE('#808080', '#818181')).toBeLessThan(1);
  });

  it('labels match quality', () => {
    expect(matchLabel(0.5)).toBe('Spot on!');
    expect(matchLabel(7)).toBe('Good');
    expect(matchLabel(60)).toBe('Way off');
  });
});

describe('hue helpers', () => {
  it('wraps the hue difference', () => {
    expect(hueDiff(350, 10)).toBe(20);
    expect(hueDiff(10, 350)).toBe(-20);
    expect(hueDiff(0, 180)).toBe(180);
    expect(hueDiff(90, 90)).toBe(0);
  });

  it('reports no hue for grays', () => {
    expect(toLch('#808080').h).toBeNull();
    expect(toLch('#ff0000').h).not.toBeNull();
  });
});

describe('mulberry32', () => {
  it('yields values in [0, 1)', () => {
    const r = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
