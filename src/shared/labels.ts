// Dependency-free helpers shared by client and server (kept separate from
// colors.ts so the browser bundle does not need chroma-js).

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
