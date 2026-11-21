import { describe, expect, it } from 'vitest';
import type { RoundReview } from '../src/shared/protocol.js';
import { GOOD, hexToHsv, hsvToHex, reviewNotes, summaryTip, type Hsv } from '../src/shared/review.js';

/** A pick that misses `target` by the given HSV amounts (hue in degrees, s/v in 0..1). */
function miss(target: string, dh: number, ds: number, dv: number): string {
  const t = hexToHsv(target);
  return hsvToHex({ h: (t.h + dh + 360) % 360, s: t.s + ds, v: t.v + dv });
}

function round(target: string, pick: string | null): RoundReview {
  return { target, pick, deltaE: pick ? 1 : null, score: pick ? 90 : 0 };
}

const byLabel = (target: string, pick: string) => Object.fromEntries(reviewNotes(target, pick).map((n) => [n.label, n]));

describe('HSV conversion', () => {
  it('round-trips hex colors', () => {
    for (const hex of ['#000000', '#ffffff', '#808080', '#ff0000', '#3e63dd', '#b43e20', '#57deb8']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it('matches known values', () => {
    const near = (a: Hsv, b: Hsv) => {
      expect(a.h).toBeCloseTo(b.h, 5);
      expect(a.s).toBeCloseTo(b.s, 5);
      expect(a.v).toBeCloseTo(b.v, 5);
    };
    near(hexToHsv('#ff0000'), { h: 0, s: 1, v: 1 });
    near(hexToHsv('#00ff00'), { h: 120, s: 1, v: 1 });
    near(hexToHsv('#0000ff'), { h: 240, s: 1, v: 1 });
    near(hexToHsv('#808080'), { h: 0, s: 0, v: 128 / 255 });
  });
});

describe('reviewNotes', () => {
  const target = '#3e63dd'; // a mid blue: hue, saturation and brightness all well inside their ranges

  it('calls a perfect pick good on all three, with the dot on the target', () => {
    const notes = reviewNotes(target, target);
    expect(notes.map((n) => n.label)).toEqual(['Hue', 'Saturation', 'Brightness']);
    for (const n of notes) {
      expect(n.good).toBe(true);
      expect(n.bar.pick).toBeCloseTo(n.bar.target, 2);
    }
  });

  it('names the direction of each miss', () => {
    expect(byLabel(target, miss(target, 0, 0, -0.2)).Brightness!.text).toBe('too dark');
    expect(byLabel(target, miss(target, 0, -0.08, 0)).Saturation!.text).toBe('slightly muted');
    expect(byLabel(target, miss(target, 0, 0.1, 0)).Saturation!.text).toBe('slightly vivid');
    expect(byLabel(target, miss(target, 30, 0, 0)).Hue!.text).toBe('far too purple');
    // A small drift from red still reads as the neighbour it drifted toward.
    expect(byLabel('#cc2222', miss('#cc2222', 8, 0, 0)).Hue!.text).toBe('slightly orange');
  });

  it('treats differences under GOOD as good', () => {
    const notes = byLabel(target, miss(target, GOOD - 1, (GOOD - 1.5) / 100, -(GOOD - 1.5) / 100));
    expect(notes.Hue!.good && notes.Saturation!.good && notes.Brightness!.good).toBe(true);
  });

  it('draws the good range the same width on all three bars', () => {
    const widths = reviewNotes(target, target).map((n) => n.bar.band[1] - n.bar.band[0]);
    for (const w of widths) expect(w).toBeCloseTo(0.1, 5);
  });

  it('cuts the good range off at a bar end and keeps the target on it', () => {
    const white = byLabel('#ffffff', '#f0f0f0');
    expect(white.Brightness!.bar.target).toBe(1);
    expect(white.Brightness!.bar.band).toEqual([0.95, 1]);
  });

  it('does not judge hue for near-gray targets', () => {
    const hue = byLabel('#7a7d80', '#7a8060').Hue!;
    expect(hue.bar.faded).toBe(true);
    expect(hue.good).toBe(true);
  });

  it('pins a hue miss beyond the bar to its end', () => {
    const hue = byLabel(target, miss(target, 90, 0, 0)).Hue!;
    expect(hue.bar.pick).toBe(1);
    expect(hue.bar.out).toBe(1);
  });
});

describe('summaryTip', () => {
  const targets = ['#3e63dd', '#b43e20', '#57deb8', '#8c77c0', '#c07780'];

  it('says nothing when the player made no picks', () => {
    expect(summaryTip(targets.map((t) => round(t, null)))).toBeNull();
  });

  it('praises a game that stayed in the good range', () => {
    expect(summaryTip(targets.map((t) => round(t, t)))).toMatch(/^Spot on/);
  });

  it('names a consistent lean and what was on target', () => {
    const tip = summaryTip(targets.map((t) => round(t, miss(t, 0, -0.15, 0))));
    expect(tip).toBe('You tend to pick colors too muted. Hue and brightness were on target.');
  });

  it('names two habits together', () => {
    const tip = summaryTip(targets.map((t) => round(t, miss(t, 0, -0.15, -0.15))));
    expect(tip).toMatch(/^You tend to pick colors too muted and too dark\./);
  });

  it('does not call misses that go both ways a habit', () => {
    const tip = summaryTip(targets.map((t, i) => round(t, miss(t, 0, 0, i % 2 ? 0.15 : -0.15))));
    expect(tip).toMatch(/^Your misses go both ways; brightness was off the most\./);
  });

  it('ignores missed rounds', () => {
    const rounds = targets.map((t, i) => round(t, i === 0 ? null : t));
    expect(summaryTip(rounds)).toMatch(/^Spot on/);
  });
});
