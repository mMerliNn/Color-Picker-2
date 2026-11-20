// Dependency-free helpers shared by client and server (kept separate from
// colors.ts so the browser bundle does not need chroma-js).

/** Lobby wording for a "time per round" setting (0 = no limit). */
export function formatSeconds(n: number): string {
  if (n === 0) return 'Unlimited (solo only)';
  if (n === 60) return '1 minute';
  if (n > 60 && n % 60 === 0) return `${n / 60} minutes`;
  return `${n} seconds`;
}

/** A countdown value as "45s", or "1:05" once it reaches a minute. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type MatchLabel = 'Spot on!' | 'Great' | 'Good' | 'Close' | 'Off' | 'Way off';

/** Human wording for a CIEDE2000 distance. */
export function matchLabel(dE: number): MatchLabel {
  if (dE < 2) return 'Spot on!';
  if (dE < 5) return 'Great';
  if (dE < 10) return 'Good';
  if (dE < 20) return 'Close';
  if (dE < 35) return 'Off';
  return 'Way off';
}
