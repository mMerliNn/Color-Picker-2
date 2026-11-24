// Wire protocol shared by client and server. All messages are JSON objects
// with a `t` (type) discriminator.

export const MAX_PLAYERS = 30;
export const MAX_NAME_LENGTH = 20;
export const ROOM_CODE_LENGTH = 5;
// No 0/O, 1/I/L: codes are read aloud and typed by hand.
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const ROUND_OPTIONS = [5, 10] as const;
/** `roundSeconds` value meaning "no time limit". Only allowed in solo games. */
export const UNLIMITED_SECONDS = 0;
export const SECONDS_OPTIONS = [15, 20, 30, 60, UNLIMITED_SECONDS] as const;

/**
 * Classic: the target stays on screen while you match it.
 * Rapid: Classic against the clock (see MODE_FEATURES).
 * Memory: the target shows for `memorizeSeconds`, then hides behind a moment of
 * static, and the player matches it from memory.
 * Memory Rapid: Memory against the clock.
 *
 * Each mode is scored, logged and analysed on its own (its own stats page).
 * In the lobby, modes are grouped into categories (MODE_CATEGORIES below).
 */
export const MODE_OPTIONS = ['classic', 'rapid', 'memory', 'memory-rapid'] as const;
export type GameMode = (typeof MODE_OPTIONS)[number];

/**
 * What each mode does, so the code checks features rather than mode names and
 * a new combination is one entry here.
 * - memory: the color shows for `memorizeSeconds`, then hides before picking.
 * - rapid: locking in early earns a speed bonus, and the first lock-in halves
 *   everyone else's time left (the shot clock, see shotClockDeadline).
 */
export interface ModeFeatures {
  memory: boolean;
  rapid: boolean;
}
export const MODE_FEATURES: Record<GameMode, ModeFeatures> = {
  classic: { memory: false, rapid: false },
  rapid: { memory: false, rapid: true },
  memory: { memory: true, rapid: false },
  'memory-rapid': { memory: true, rapid: true },
};
export const isMemoryMode = (mode: GameMode): boolean => MODE_FEATURES[mode].memory;
export const isRapidMode = (mode: GameMode): boolean => MODE_FEATURES[mode].rapid;

export interface ModeVariant {
  mode: GameMode;
  /** Name inside its category ("Standard", "Rapid"). */
  label: string;
}
export interface ModeCategory {
  /** The lobby's main choice ("Classic", "Memory"). */
  label: string;
  variants: readonly ModeVariant[];
}

/**
 * The lobby asks for a category first, then a variant inside it. Every mode
 * belongs to exactly one category (checked by a test). Adding a variant or a
 * whole category is one entry here plus its mode in MODE_OPTIONS.
 */
export const MODE_CATEGORIES: readonly ModeCategory[] = [
  {
    label: 'Classic',
    variants: [
      { mode: 'classic', label: 'Standard' },
      { mode: 'rapid', label: 'Rapid' },
    ],
  },
  {
    label: 'Memory',
    variants: [
      { mode: 'memory', label: 'Standard' },
      { mode: 'memory-rapid', label: 'Rapid' },
    ],
  },
];

export function categoryOf(mode: GameMode): ModeCategory {
  return MODE_CATEGORIES.find((c) => c.variants.some((v) => v.mode === mode)) as ModeCategory;
}

export function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && (MODE_OPTIONS as readonly string[]).includes(value);
}
/** Memory mode: how long the color is shown, in seconds. */
export const MEMORIZE_OPTIONS = [2, 3, 5] as const;
/** Memory mode: static between hiding the color and unlocking the picker. */
export const MEMORY_STATIC_MS = 1000;
/** Rapid modes: the shot clock never leaves anyone less than this (unless less was left anyway). */
export const SHOT_CLOCK_MIN_MS = 5000;

/**
 * Rapid modes' shot clock: when the first player locks in, the time left for
 * everyone else is cut in half, but never below SHOT_CLOCK_MIN_MS, and never
 * more than was left. Returns the new deadline (the old one when nothing changes).
 * Relative rather than a fixed "10 s left", so it bites in any round length,
 * even when people usually take over half the round to lock in.
 */
export function shotClockDeadline(now: number, endsAt: number): number {
  const left = endsAt - now;
  return Math.min(endsAt, now + Math.max(SHOT_CLOCK_MIN_MS, Math.round(left / 2)));
}

export interface GameSettings {
  rounds: number;
  roundSeconds: number; // never unlimited in the rapid modes (the speed bonus needs a deadline)
  mode: GameMode;
  memorizeSeconds: number; // memory modes only
}

export const DEFAULT_SETTINGS: GameSettings = { rounds: 5, roundSeconds: 20, mode: 'classic', memorizeSeconds: 3 };

export interface PlayerInfo {
  id: string; // public, per-room id (never the private clientId)
  name: string;
  connected: boolean;
}

export interface Standing {
  id: string;
  name: string;
  total: number;
  avgDeltaE: number | null; // mean over rounds with a pick
  rank: number;
  connected: boolean;
}

export interface RoundResult {
  id: string;
  name: string;
  pick: string | null; // '#rrggbb', null when the player missed the round
  deltaE: number | null;
  score: number; // everything this round earned, speed bonus included
  bonus: number; // Rapid: the speed bonus part of `score` (0 in other modes)
  timeMs: number | null;
  // True when the player locked in. False when time ran out and the color they
  // had on screen was used (no speed bonus), or when they missed the round.
  lockedIn: boolean;
}

/** One round as one player played it: sent only to that player, for their review. */
export interface RoundReview {
  target: string;
  pick: string | null; // null when the player missed the round
  deltaE: number | null;
  score: number;
}

// ---- client -> server ----------------------------------------------------

export type ClientMessage =
  | { t: 'create'; clientId: string; name: string; settings?: Partial<GameSettings> }
  | { t: 'join'; clientId: string; name: string; code: string }
  | { t: 'settings'; settings: Partial<GameSettings> }
  | { t: 'start' }
  | { t: 'pick'; hex: string }
  // The color the player currently has on screen while still choosing. If the
  // round ends before they lock in, the server uses the latest draft, so a slow
  // connection or a late timer can no longer turn a pick into a miss.
  | { t: 'draft'; hex: string }
  // Clock sync: the server echoes `c` back with its own time (see 'pong').
  | { t: 'ping'; c: number }
  // Solo only: skip the wait after a round result and go straight on.
  | { t: 'next' }
  | { t: 'again' }
  | { t: 'leave' };

// ---- server -> client ----------------------------------------------------

export type Phase = 'lobby' | 'starting' | 'picking' | 'reveal' | 'final';

export type ServerMessage =
  // Reply to a client 'ping'. The client measures the round trip and works out
  // how far its clock is from the server's, so countdowns are accurate even on
  // a slow or far-away connection.
  | { t: 'pong'; c: number; serverNow: number }
  | {
      t: 'state'; // sent on join / reconnect and whenever the lobby changes
      serverNow: number;
      code: string;
      youId: string;
      hostId: string;
      phase: Phase;
      settings: GameSettings;
      players: PlayerInfo[];
    }
  | { t: 'starting'; serverNow: number; startsAt: number }
  | {
      t: 'round';
      serverNow: number;
      index: number; // 0-based
      total: number;
      // The target. Null once it has been hidden in memory mode (for example
      // when someone reconnects mid-round), so it never reaches the page again.
      color: string | null;
      // Memory mode only (null in classic): when the color hides, and when the
      // static ends and the picker unlocks. The round time counts from unlockAt.
      hideAt: number | null;
      unlockAt: number | null;
      // When the time to pick started (the unlock in memory mode). Rapid's speed
      // bonus shrinks from here to the original deadline.
      startedAt: number;
      // null = no time limit (solo "unlimited" mode). In Rapid it can move
      // earlier mid-round: see 'shotClock'.
      endsAt: number | null;
      submitted: number;
      expected: number;
      youPick: string | null; // set when re-sent after a reconnect
    }
  | { t: 'progress'; submitted: number; expected: number }
  // Rapid modes only, at most once per round: the first player has locked in
  // (`by`, a player id) while others are still choosing. `endsAt` is the
  // round's deadline from now on: `shortened` when the time left was halved
  // (see shotClockDeadline), unchanged when it was too short to cut.
  | { t: 'shotClock'; serverNow: number; by: string; endsAt: number; shortened: boolean }
  | { t: 'picked'; hex: string } // confirmation of your own pick
  | {
      t: 'reveal';
      serverNow: number;
      index: number;
      total: number;
      target: string;
      results: RoundResult[]; // best first
      standings: Standing[];
      nextAt: number; // next round, or the final results after the last round
    }
  | {
      t: 'final';
      serverNow: number;
      standings: Standing[];
      colors: string[];
      // This player's own rounds, in order (one per round). Never anyone else's.
      yourRounds: RoundReview[];
    }
  | { t: 'error'; code: ErrorCode; message: string };

export type ErrorCode =
  | 'bad_message'
  | 'bad_name'
  | 'no_room'
  | 'room_full'
  | 'in_progress'
  | 'not_host'
  | 'not_in_room'
  | 'wrong_phase'
  | 'solo_only'
  | 'rate_limited'
  | 'server_busy';

// ---- validation (server side) -------------------------------------------

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function isClientId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
}

export function cleanSettings(raw: unknown): Partial<GameSettings> | null {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const out: Partial<GameSettings> = {};
  if (r.rounds !== undefined) {
    if (!ROUND_OPTIONS.includes(r.rounds as (typeof ROUND_OPTIONS)[number])) return null;
    out.rounds = r.rounds as number;
  }
  if (r.roundSeconds !== undefined) {
    if (!SECONDS_OPTIONS.includes(r.roundSeconds as (typeof SECONDS_OPTIONS)[number])) return null;
    out.roundSeconds = r.roundSeconds as number;
  }
  if (r.mode !== undefined) {
    if (!isGameMode(r.mode)) return null;
    out.mode = r.mode;
  }
  if (r.memorizeSeconds !== undefined) {
    if (!MEMORIZE_OPTIONS.includes(r.memorizeSeconds as (typeof MEMORIZE_OPTIONS)[number])) return null;
    out.memorizeSeconds = r.memorizeSeconds as number;
  }
  return out;
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'create': {
      const name = cleanName(m.name);
      const settings = cleanSettings(m.settings);
      if (!name || !isClientId(m.clientId) || settings === null) return null;
      return { t: 'create', clientId: m.clientId, name, settings };
    }
    case 'join': {
      const name = cleanName(m.name);
      const code = normalizeCode(m.code);
      if (!name || !code || !isClientId(m.clientId)) return null;
      return { t: 'join', clientId: m.clientId, name, code };
    }
    case 'settings': {
      const settings = cleanSettings(m.settings);
      if (settings === null) return null;
      return { t: 'settings', settings };
    }
    case 'pick':
      return isHex(m.hex) ? { t: 'pick', hex: m.hex.toLowerCase() } : null;
    case 'draft':
      return isHex(m.hex) ? { t: 'draft', hex: m.hex.toLowerCase() } : null;
    case 'ping':
      return typeof m.c === 'number' && Number.isFinite(m.c) ? { t: 'ping', c: m.c } : null;
    case 'start':
    case 'next':
    case 'again':
    case 'leave':
      return { t: m.t };
    default:
      return null;
  }
}
