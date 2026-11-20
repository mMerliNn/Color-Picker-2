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

export interface GameSettings {
  rounds: number;
  roundSeconds: number;
}

export const DEFAULT_SETTINGS: GameSettings = { rounds: 10, roundSeconds: 20 };

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
  score: number;
  timeMs: number | null;
}

// ---- client -> server ----------------------------------------------------

export type ClientMessage =
  | { t: 'create'; clientId: string; name: string; settings?: Partial<GameSettings> }
  | { t: 'join'; clientId: string; name: string; code: string }
  | { t: 'settings'; settings: Partial<GameSettings> }
  | { t: 'start' }
  | { t: 'pick'; hex: string }
  | { t: 'again' }
  | { t: 'leave' };

// ---- server -> client ----------------------------------------------------

export type Phase = 'lobby' | 'starting' | 'picking' | 'reveal' | 'final';

export type ServerMessage =
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
      color: string;
      endsAt: number | null; // null = no time limit (solo "unlimited" mode)
      submitted: number;
      expected: number;
      youPick: string | null; // set when re-sent after a reconnect
    }
  | { t: 'progress'; submitted: number; expected: number }
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
  | { t: 'final'; serverNow: number; standings: Standing[]; colors: string[] }
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
    case 'start':
    case 'again':
    case 'leave':
      return { t: m.t };
    default:
      return null;
  }
}
