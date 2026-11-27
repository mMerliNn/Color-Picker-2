import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toLch } from '../shared/colors.js';
import type { ChallengeSettings } from '../shared/challenge.js';
import type { GameMode } from '../shared/protocol.js';
import type { DifficultySample } from './difficulty.js';

/**
 * Persistent log of every game and every pick.
 *
 * Raw data is stored (target and picked hex, time, scores) together with the
 * LCH breakdown of both colors, so a future "history analysis" page can answer
 * questions like "error by hue" or "do I pick too light?" with plain SQL and no
 * recomputation. `client_id` is the player's anonymous, private identity.
 */

export interface GameRecord {
  id: string;
  roomCode: string;
  seed: number;
  rounds: number;
  roundSeconds: number;
  /** Optional for callers (scripts, tests) that only play classic. */
  mode?: GameMode;
  memorizeSeconds?: number | null; // memory modes only
  /** The weekly challenge's week ("2026-W48") when this game is a challenge attempt. */
  challengeWeek?: string | null;
  playerCount: number;
  startedAt: number;
}

export interface PickRecord {
  gameId: string;
  round: number; // 0-based
  clientId: string;
  playerName: string;
  targetHex: string;
  pickHex: string | null; // null = missed the round
  deltaE: number | null;
  score: number;
  timeMs: number | null;
}

/** One stored pick, as read back for the analysis page. */
export interface PickRow {
  game_id: string;
  round: number;
  pick_hex: string | null;
  delta_e: number | null;
  score: number;
  time_ms: number | null;
  target_l: number;
  target_c: number;
  target_h: number | null;
  pick_l: number | null;
  pick_c: number | null;
  pick_h: number | null;
  created_at: number;
}

export interface ChallengeRecord {
  week: string;
  settings: ChallengeSettings;
  seed: number;
  colors: string[];
  /** Picks the difficulty model had learned from when the colors were chosen (0 = prior only). */
  difficultySamples: number;
  createdAt: number;
}

/** One weekly challenge attempt as stored. */
export interface EntryRow {
  clientId: string;
  name: string;
  gameId: string;
  score: number;
  totalTimeMs: number;
  rounds: number;
  avgDeltaE: number | null;
  startedAt: number;
  finishedAt: number | null;
  nameHidden: number;
}
const ENTRY_COLUMNS = `client_id AS clientId, name, game_id AS gameId, score, total_time_ms AS totalTimeMs,
  rounds_played AS rounds, avg_delta_e AS avgDeltaE, started_at AS startedAt, finished_at AS finishedAt,
  name_hidden AS nameHidden`;

export interface GlobalBin {
  bin: number;
  n: number;
  avg: number;
}

// 1: games and picks. 2: games.mode and games.memorize_seconds (memory mode).
// 3: games.shot_seconds, from the first Rapid version (a fixed 5 or 10 s shot
// clock). Kept so every database has the same shape, but no longer filled:
// the shot clock now halves the time left, which needs no setting.
// 4: the weekly challenge (challenges, challenge_entries, games.challenge_week)
// and a small key-value table (meta) for the challenge's secret key.
const SCHEMA_VERSION = 4;

export class GameStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (row.user_version >= SCHEMA_VERSION) return;
    if (row.user_version < 1) this.createV1();
    if (row.user_version < 2) {
      // v2: the game mode. Every game logged before it was classic.
      this.db.exec(`
        BEGIN;
        ALTER TABLE games ADD COLUMN mode TEXT NOT NULL DEFAULT 'classic';
        ALTER TABLE games ADD COLUMN memorize_seconds INTEGER;
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
    if (row.user_version < 3) {
      // v3: the first Rapid version's fixed shot clock (no longer filled). A
      // rapid pick's speed bonus is its score minus the accuracy points for its
      // delta_e, so it needs no column of its own.
      this.db.exec(`
        BEGIN;
        ALTER TABLE games ADD COLUMN shot_seconds INTEGER;
        PRAGMA user_version = 3;
        COMMIT;
      `);
    }
    if (row.user_version < 4) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE games ADD COLUMN challenge_week TEXT;
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        -- One row per week, written when the week is first played, so the
        -- week's colors and settings never change afterwards (not even if the
        -- generator or the schedule is changed mid-week).
        CREATE TABLE IF NOT EXISTS challenges (
          week               TEXT PRIMARY KEY,
          mode               TEXT NOT NULL,
          rounds             INTEGER NOT NULL,
          round_seconds      INTEGER NOT NULL,
          memorize_seconds   INTEGER,
          seed               INTEGER NOT NULL,
          colors             TEXT NOT NULL,
          difficulty_samples INTEGER NOT NULL,
          created_at         INTEGER NOT NULL
        );
        -- One attempt per player (browser) per week. Written when the first
        -- color appears and updated after every round, so quitting midway
        -- keeps the points so far.
        CREATE TABLE IF NOT EXISTS challenge_entries (
          week          TEXT NOT NULL,
          client_id     TEXT NOT NULL,
          name          TEXT NOT NULL,
          game_id       TEXT NOT NULL,
          score         INTEGER NOT NULL DEFAULT 0,
          total_time_ms INTEGER NOT NULL DEFAULT 0,
          rounds_played INTEGER NOT NULL DEFAULT 0,
          avg_delta_e   REAL,
          started_at    INTEGER NOT NULL,
          finished_at   INTEGER,
          name_hidden   INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (week, client_id)
        );
        CREATE INDEX IF NOT EXISTS challenge_rank
          ON challenge_entries (week, score DESC, total_time_ms, started_at, client_id);
        CREATE INDEX IF NOT EXISTS games_by_challenge ON games (challenge_week);
        PRAGMA user_version = 4;
        COMMIT;
      `);
    }
  }

  private createV1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id            TEXT PRIMARY KEY,
        room_code     TEXT NOT NULL,
        seed          INTEGER NOT NULL,
        rounds        INTEGER NOT NULL,
        round_seconds INTEGER NOT NULL,
        player_count  INTEGER NOT NULL,
        started_at    INTEGER NOT NULL,
        ended_at      INTEGER
      );
      CREATE TABLE IF NOT EXISTS picks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id     TEXT NOT NULL REFERENCES games(id),
        round       INTEGER NOT NULL,
        client_id   TEXT NOT NULL,
        player_name TEXT NOT NULL,
        target_hex  TEXT NOT NULL,
        pick_hex    TEXT,
        delta_e     REAL,
        score       INTEGER NOT NULL,
        time_ms     INTEGER,
        target_l    REAL NOT NULL,
        target_c    REAL NOT NULL,
        target_h    REAL,
        pick_l      REAL,
        pick_c      REAL,
        pick_h      REAL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS picks_by_client ON picks (client_id, created_at);
      CREATE INDEX IF NOT EXISTS picks_by_game ON picks (game_id, round);
      PRAGMA user_version = 1;
    `);
  }

  startGame(game: GameRecord): void {
    this.db
      .prepare(
        `INSERT INTO games (id, room_code, seed, rounds, round_seconds, mode, memorize_seconds,
                            challenge_week, player_count, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        game.id,
        game.roomCode,
        game.seed,
        game.rounds,
        game.roundSeconds,
        game.mode ?? 'classic',
        game.memorizeSeconds ?? null,
        game.challengeWeek ?? null,
        game.playerCount,
        game.startedAt,
      );
  }

  /** Log all picks of one round (including misses) atomically. */
  logRound(picks: PickRecord[], now: number): void {
    const insert = this.db.prepare(
      `INSERT INTO picks (game_id, round, client_id, player_name, target_hex, pick_hex, delta_e,
                          score, time_ms, target_l, target_c, target_h, pick_l, pick_c, pick_h,
                          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const p of picks) {
        const target = toLch(p.targetHex);
        const pick = p.pickHex ? toLch(p.pickHex) : null;
        insert.run(
          p.gameId,
          p.round,
          p.clientId,
          p.playerName,
          p.targetHex,
          p.pickHex,
          p.deltaE,
          p.score,
          p.timeMs,
          target.l,
          target.c,
          target.h,
          pick?.l ?? null,
          pick?.c ?? null,
          pick?.h ?? null,
          now,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  finishGame(id: string, endedAt: number): void {
    this.db.prepare('UPDATE games SET ended_at = ? WHERE id = ?').run(endedAt, id);
  }

  // -- read helpers (used by tests now, by the analysis page later) ----------

  picksForGame(gameId: string): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM picks WHERE game_id = ? ORDER BY round, id')
      .all(gameId) as Record<string, unknown>[];
  }

  /**
   * A player's most recent picks in one game mode (misses included), newest
   * first. Modes are never mixed: matching from memory is a different skill with
   * much bigger errors, and mixing them would blur every chart.
   */
  picksForClient(clientId: string, mode: GameMode = 'classic', limit = 3000): PickRow[] {
    return this.db
      .prepare(
        `SELECT p.game_id, p.round, p.pick_hex, p.delta_e, p.score, p.time_ms,
                p.target_l, p.target_c, p.target_h, p.pick_l, p.pick_c, p.pick_h, p.created_at
         FROM picks p JOIN games g ON g.id = p.game_id
         WHERE p.client_id = ? AND g.mode = ?
         ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
      )
      .all(clientId, mode, limit) as unknown as PickRow[];
  }

  /**
   * Average error of everyone in one game mode, per 30-degree hue sector of the
   * target. Simulated players (client ids starting with "bot-") are left out.
   */
  globalHueBins(mode: GameMode = 'classic'): { bins: GlobalBin[]; overall: { n: number; avg: number | null } } {
    const bins = this.db
      .prepare(
        `SELECT MIN(11, CAST(p.target_h / 30 AS INTEGER)) AS bin, COUNT(*) AS n, AVG(p.delta_e) AS avg
         FROM picks p JOIN games g ON g.id = p.game_id
         WHERE p.pick_hex IS NOT NULL AND p.target_h IS NOT NULL AND p.client_id NOT LIKE 'bot-%'
           AND g.mode = ?
         GROUP BY bin`,
      )
      .all(mode) as unknown as GlobalBin[];
    const overall = this.db
      .prepare(
        `SELECT COUNT(*) AS n, AVG(p.delta_e) AS avg FROM picks p JOIN games g ON g.id = p.game_id
         WHERE p.pick_hex IS NOT NULL AND p.client_id NOT LIKE 'bot-%' AND g.mode = ?`,
      )
      .get(mode) as unknown as { n: number; avg: number | null };
    return { bins, overall };
  }

  // -- weekly challenge -------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  getChallenge(week: string): ChallengeRecord | null {
    const row = this.db.prepare('SELECT * FROM challenges WHERE week = ?').get(week) as
      | { week: string; mode: GameMode; rounds: number; round_seconds: number; memorize_seconds: number | null; seed: number; colors: string; difficulty_samples: number; created_at: number }
      | undefined;
    if (!row) return null;
    return {
      week: row.week,
      settings: { mode: row.mode, rounds: row.rounds, roundSeconds: row.round_seconds, memorizeSeconds: row.memorize_seconds ?? 3 },
      seed: row.seed,
      colors: JSON.parse(row.colors) as string[],
      difficultySamples: row.difficulty_samples,
      createdAt: row.created_at,
    };
  }

  /** Store a week's challenge unless it exists already; returns the stored one either way. */
  saveChallenge(c: ChallengeRecord): ChallengeRecord {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO challenges (week, mode, rounds, round_seconds, memorize_seconds, seed, colors,
                                           difficulty_samples, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.week, c.settings.mode, c.settings.rounds, c.settings.roundSeconds, c.settings.memorizeSeconds, c.seed, JSON.stringify(c.colors), c.difficultySamples, c.createdAt);
    return this.getChallenge(c.week) as ChallengeRecord;
  }

  /**
   * Everyone's errors in one mode for the difficulty model, each divided by the
   * player's own average (players with fewer than 10 answered rounds, and bots,
   * are left out). Newest first, at most `limit`.
   */
  difficultySamples(mode: GameMode, limit = 200_000): DifficultySample[] {
    return this.db
      .prepare(
        `WITH players AS (
           SELECT p.client_id, AVG(p.delta_e) AS avg_de
           FROM picks p JOIN games g ON g.id = p.game_id
           WHERE g.mode = ? AND p.pick_hex IS NOT NULL AND p.client_id NOT LIKE 'bot-%'
           GROUP BY p.client_id HAVING COUNT(*) >= 10 AND AVG(p.delta_e) > 0
         )
         SELECT p.target_l AS targetL, p.target_c AS targetC, p.target_h AS targetH, p.delta_e / pl.avg_de AS relError
         FROM picks p JOIN games g ON g.id = p.game_id JOIN players pl ON pl.client_id = p.client_id
         WHERE g.mode = ? AND p.pick_hex IS NOT NULL AND p.target_h IS NOT NULL
         ORDER BY p.id DESC LIMIT ?`,
      )
      .all(mode, mode, limit) as unknown as DifficultySample[];
  }

  /** The attempt starts (the first color appears). False when this player already has one this week. */
  startEntry(e: { week: string; clientId: string; name: string; gameId: string; startedAt: number }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO challenge_entries (week, client_id, name, game_id, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(e.week, e.clientId, e.name, e.gameId, e.startedAt);
    return Number(result.changes) === 1;
  }

  /** The attempt's totals so far (after each round), and `finishedAt` once the last round is done. */
  updateEntry(e: { week: string; clientId: string; gameId: string; score: number; totalTimeMs: number; rounds: number; avgDeltaE: number | null; finishedAt: number | null }): void {
    this.db
      .prepare(
        `UPDATE challenge_entries SET score = ?, total_time_ms = ?, rounds_played = ?, avg_delta_e = ?,
                finished_at = COALESCE(?, finished_at)
         WHERE week = ? AND client_id = ? AND game_id = ?`,
      )
      .run(e.score, e.totalTimeMs, e.rounds, e.avgDeltaE, e.finishedAt, e.week, e.clientId, e.gameId);
  }

  entry(week: string, clientId: string): EntryRow | null {
    return (this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM challenge_entries WHERE week = ? AND client_id = ?`).get(week, clientId) as EntryRow | undefined) ?? null;
  }

  countEntries(week: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM challenge_entries WHERE week = ?').get(week) as { n: number }).n;
  }

  /** Best first: most points, then least total time, then who started first. */
  topEntries(week: string, limit: number): EntryRow[] {
    return this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM challenge_entries WHERE week = ?
         ORDER BY score DESC, total_time_ms ASC, started_at ASC, client_id ASC LIMIT ?`,
      )
      .all(week, limit) as unknown as EntryRow[];
  }

  /** 1-based place of an attempt in the order of topEntries. */
  rankOf(week: string, me: EntryRow): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM challenge_entries
         WHERE week = ? AND (score > ? OR (score = ? AND (total_time_ms < ? OR (total_time_ms = ? AND
               (started_at < ? OR (started_at = ? AND client_id < ?))))))`,
      )
      .get(week, me.score, me.score, me.totalTimeMs, me.totalTimeMs, me.startedAt, me.startedAt, me.clientId) as { n: number };
    return row.n + 1;
  }

  /**
   * Everyone's results per round of a week's challenge: answers, misses and
   * the average error over the answers. Bots are left out.
   */
  challengeRoundStats(week: string): { round: number; answered: number; missed: number; avg: number | null }[] {
    return this.db
      .prepare(
        `SELECT p.round AS round, COUNT(p.pick_hex) AS answered, COUNT(*) - COUNT(p.pick_hex) AS missed,
                AVG(CASE WHEN p.pick_hex IS NOT NULL THEN p.delta_e END) AS avg
         FROM picks p JOIN games g ON g.id = p.game_id
         WHERE g.challenge_week = ? AND p.client_id NOT LIKE 'bot-%'
         GROUP BY p.round ORDER BY p.round`,
      )
      .all(week) as unknown as { round: number; answered: number; missed: number; avg: number | null }[];
  }

  /** One player's picks in one game, by round. */
  picksOf(gameId: string, clientId: string): { round: number; pickHex: string | null; deltaE: number | null }[] {
    return this.db
      .prepare('SELECT round, pick_hex AS pickHex, delta_e AS deltaE FROM picks WHERE game_id = ? AND client_id = ? ORDER BY round')
      .all(gameId, clientId) as unknown as { round: number; pickHex: string | null; deltaE: number | null }[];
  }

  /** Moderation: hide (or show again) a name on the public leaderboard. Returns the rows changed. */
  setNameHidden(week: string, name: string, hidden: boolean): number {
    const result = this.db
      .prepare('UPDATE challenge_entries SET name_hidden = ? WHERE week = ? AND name = ?')
      .run(hidden ? 1 : 0, week, name);
    return Number(result.changes);
  }

  /**
   * Delete everything stored about one player. Returns the number of picks
   * removed. Their weekly challenge entries go too (they leave the leaderboards).
   */
  deleteClientData(clientId: string): number {
    const result = this.db.prepare('DELETE FROM picks WHERE client_id = ?').run(clientId);
    this.db.prepare('DELETE FROM challenge_entries WHERE client_id = ?').run(clientId);
    return Number(result.changes);
  }

  listGames(): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM games ORDER BY started_at, id').all() as Record<
      string,
      unknown
    >[];
  }

  countPicks(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM picks').get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
