import { describe, expect, it } from 'vitest';
import { formatClock, formatSeconds } from '../src/shared/labels.js';

describe('formatSeconds', () => {
  it('words the lobby options', () => {
    expect(formatSeconds(15)).toBe('15 seconds');
    expect(formatSeconds(30)).toBe('30 seconds');
    expect(formatSeconds(60)).toBe('1 minute');
    expect(formatSeconds(120)).toBe('2 minutes');
    expect(formatSeconds(0)).toBe('Unlimited (solo only)');
  });
});

describe('formatClock', () => {
  it('shows seconds under a minute and m:ss from a minute up', () => {
    expect(formatClock(45)).toBe('45s');
    expect(formatClock(59.2)).toBe('1:00'); // rounds up to a full minute, never "60s"
    expect(formatClock(60)).toBe('1:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(0)).toBe('0s');
    expect(formatClock(-3)).toBe('0s');
  });
});
