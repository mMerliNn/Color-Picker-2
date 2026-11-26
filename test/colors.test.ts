import { describe, expect, it } from 'vitest';
import {
  deltaE,
  generateColors,
  hueDiff,
  mulberry32,
  scoreFromDeltaE,
  speedBonus,
  toLch,
} from '../src/shared/colors.js';
import { matchLabel } from '../src/shared/labels.js';
import { shotClockDeadline } from '../src/shared/protocol.js';

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
