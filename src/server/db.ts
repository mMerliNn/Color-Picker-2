import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toLch } from '../shared/colors.js';
import type { GameMode } from '../shared/protocol.js';

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

export interface GlobalBin {
  bin: number;
  n: number;
  avg: number;
}

// 1: games and picks. 2: games.mode and games.memorize_seconds (memory mode).
// 3: games.shot_seconds, from the first Rapid version (a fixed 5 or 10 s shot
// clock). Kept so every database has the same shape, but no longer filled:
// the shot clock now halves the time left, which needs no setting.
const SCHEMA_VERSION = 3;

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
                            player_count, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        game.id,
        game.roomCode,
        game.seed,
        game.rounds,
        game.roundSeconds,
        game.mode ?? 'classic',
        game.memorizeSeconds ?? null,
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

  /** Delete everything stored about one player. Returns the number of picks removed. */
  deleteClientData(clientId: string): number {
    const result = this.db.prepare('DELETE FROM picks WHERE client_id = ?').run(clientId);
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
