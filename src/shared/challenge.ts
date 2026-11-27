// The weekly challenge: everyone plays the same colors, once, alone, and the
// results go on a public leaderboard. Dependency-free, so the browser can use it.

import type { GameMode, GameSettings } from './protocol.js';

// ---------------------------------------------------------------------------
// Weeks run from Monday 00:00 to the next Monday 00:00, Tokyo time (UTC+9, no
// daylight saving time), and are numbered like ISO weeks of the Tokyo date
// ("2026-W48"), so the number matches what a Japanese calendar shows.
// ---------------------------------------------------------------------------

const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

export interface ChallengeWeek {
  /** "2026-W48": the key everything is stored under. */
  id: string;
  /** ISO week-numbering year (the first days of January can still be the previous year's week 52/53). */
  year: number;
  /** 1..53 */
  number: number;
  /** Monday 00:00 Tokyo time, as epoch ms. */
  startsAt: number;
  /** The next Monday 00:00 Tokyo time, as epoch ms (the week does not include it). */
  endsAt: number;
}

/** The challenge week that contains the moment `nowMs`. */
export function challengeWeek(nowMs: number): ChallengeWeek {
  // Shift into Tokyo time, then use the UTC getters as Tokyo's wall clock.
  const t = new Date(nowMs + TOKYO_OFFSET_MS);
  const midnight = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const weekday = (t.getUTCDay() + 6) % 7; // Monday 0 .. Sunday 6
  const monday = midnight - weekday * DAY_MS;
  // ISO week: the week's Thursday decides the year, and week 1 is the one with
  // the year's first Thursday.
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const number = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / WEEK_MS) + 1;
  const startsAt = monday - TOKYO_OFFSET_MS;
  return { id: `${year}-W${String(number).padStart(2, '0')}`, year, number, startsAt, endsAt: startsAt + WEEK_MS };
}

/** The week before `week`. */
export function previousWeek(week: ChallengeWeek): ChallengeWeek {
  return challengeWeek(week.startsAt - 1);
}

export function isWeekId(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-W\d{2}$/.test(v);
}

// ---------------------------------------------------------------------------
// What is played. One entry decides it for every week; to change the mode, or
// to rotate modes (say, Memory every fourth week), change challengeConfig().
// Each week's settings are stored with its colors when the week is first
// played, so changing this never changes a week that has already started.
// ---------------------------------------------------------------------------

export type ChallengeSettings = Pick<GameSettings, 'mode' | 'rounds' | 'roundSeconds' | 'memorizeSeconds'>;

/** 10 rounds of Classic, 30 seconds each. */
export const DEFAULT_CHALLENGE: ChallengeSettings = { mode: 'classic', rounds: 10, roundSeconds: 30, memorizeSeconds: 3 };

/**
 * The settings for a week. Every mode works here (the challenge is an ordinary
 * solo game with its colors chosen in advance), except that unlimited time is
 * not allowed: everyone must have the same clock.
 */
export function challengeConfig(_week: ChallengeWeek): ChallengeSettings {
  return DEFAULT_CHALLENGE;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/** Rows on the public leaderboard. The player's own row is always added. */
export const LEADERBOARD_SIZE = 30;
/** Last week's top 3 stay on the home card for this long into the new week. */
export const LAST_WEEK_VISIBLE_MS = 3 * DAY_MS;

export interface LeaderRow {
  rank: number;
  name: string;
  score: number;
  avgDeltaE: number | null;
  totalTimeMs: number;
  /** Rounds played; fewer than the week's rounds when the player quit (the points so far count). */
  rounds: number;
  /** True for the player asking. */
  you: boolean;
}

export interface WeekSummary {
  id: string;
  number: number;
  startsAt: number;
  endsAt: number;
  mode: GameMode;
  rounds: number;
  roundSeconds: number;
  players: number;
}

/** POST /api/challenge: the home card. Public (counts and last week's winners only). */
export interface ChallengeStatus {
  serverNow: number;
  week: WeekSummary;
  /** This player's attempt this week, if any. */
  you: { rank: number; score: number; rounds: number; finished: boolean; inProgress: boolean } | null;
  /** Last week's top 3, during the first days of a new week only. */
  lastWeek: { id: string; number: number; top: LeaderRow[] } | null;
}

/** POST /api/challenge/leaderboard: only for players who played this week. */
/** One of the week's colors, with how everyone did on it. */
export interface ColorStat {
  round: number; // 0-based
  hex: string;
  /** Everyone's average error on it (ΔE; in the grayscale modes "off by"), over the answers; null before any. */
  avgError: number | null;
  answered: number;
  /** Rounds where time ran out with nothing chosen. */
  missed: number;
  /** The player's own answer and error (null when they missed it or have not reached it). */
  yourPick: string | null;
  yourError: number | null;
}

export interface LeaderboardResponse {
  week: WeekSummary;
  rows: LeaderRow[];
  /** The player's own row when it is not in `rows` (ranked below the top 30). */
  you: LeaderRow | null;
  /** The week's colors in round order, with everyone's average error on each. */
  colors: ColorStat[];
}

/** "3 days", "5 hours", "12 minutes": how long until `ms` from now (rounded down, at least a minute). */
export function timeLeft(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}
