import { createHmac, randomBytes } from 'node:crypto';
import {
  LAST_WEEK_VISIBLE_MS,
  LEADERBOARD_SIZE,
  challengeConfig,
  challengeWeek,
  previousWeek,
  type ChallengeStatus,
  type ChallengeWeek,
  type ColorStat,
  type LeaderRow,
  type LeaderboardResponse,
  type WeekSummary,
} from '../shared/challenge.js';
import { generateChallengeColors, generateGrays, round2 } from '../shared/colors.js';
import { isGrayMode, type ErrorCode, type GameSettings } from '../shared/protocol.js';
import type { ChallengeRecord, EntryRow, GameStore } from './db.js';
import { buildDifficulty } from './difficulty.js';
import type { ChallengeHooks } from './room.js';

/** A week's leaderboard as cached: the top rows, the player count and everyone's results per round. */
interface Board {
  at: number;
  top: EntryRow[];
  players: number;
  rounds: { round: number; answered: number; missed: number; avg: number | null }[];
}

/** Shown instead of a name that was hidden by hand. */
export const HIDDEN_NAME = 'Anonymous player';
const SECRET_KEY = 'challenge_secret';

export interface ChallengeServiceOptions {
  /** Secret key for the weekly seeds. Default: CHALLENGE_SECRET, else one made once and kept in the database. */
  secret?: string;
  /** How long the top of a leaderboard and the player count are cached (default 5 s). */
  cacheMs?: number;
  /** The clock (tests move it). */
  now?: () => number;
}

export type Prepared =
  | { ok: true; settings: GameSettings; hooks: ChallengeHooks }
  | { ok: false; code: ErrorCode; message: string };

/**
 * The weekly challenge: which colors each week gets, who has played, and the
 * leaderboards. Rooms do the playing (a challenge is a solo game with fixed
 * settings and colors chosen in advance) and report back through ChallengeHooks.
 *
 * Seeds: HMAC-SHA256(secret, week id + mode). The open game code shows how
 * colors are made from a seed, but without the secret nobody can work out a
 * future week's seed, and so its colors. The colors are stored when a week is
 * first played, so they stay the same all week even if the generator changes.
 */
export class ChallengeService {
  private readonly secret: string;
  private readonly cacheMs: number;
  readonly now: () => number;
  private readonly cache = new Map<string, Board>();
  /** Set by the game server: whether a player's attempt is being played right now. */
  isPlaying: (clientId: string) => boolean = () => false;

  constructor(
    private readonly store: GameStore,
    options: ChallengeServiceOptions = {},
  ) {
    this.secret = options.secret || process.env.CHALLENGE_SECRET || this.storedSecret();
    this.cacheMs = options.cacheMs ?? 5000;
    this.now = options.now ?? Date.now;
  }

  private storedSecret(): string {
    const saved = this.store.getMeta(SECRET_KEY);
    if (saved) return saved;
    const made = randomBytes(32).toString('hex');
    this.store.setMeta(SECRET_KEY, made);
    return made;
  }

  /** The seed for a week. Exported for tests: the same secret and week always give the same seed. */
  seedFor(weekId: string, mode: string): number {
    return createHmac('sha256', this.secret).update(`colormatch-challenge:v1:${weekId}:${mode}`).digest().readUInt32BE(0);
  }

  /** The week's challenge, chosen and stored the first time anyone plays it. */
  challengeFor(week: ChallengeWeek): ChallengeRecord {
    const existing = this.store.getChallenge(week.id);
    if (existing) return existing;
    const settings = challengeConfig(week);
    const seed = this.seedFor(week.id, settings.mode);
    let colors: string[];
    let samples = 0;
    if (isGrayMode(settings.mode)) {
      colors = generateGrays(seed, settings.rounds);
    } else {
      // Lean toward the colors players find hardest in this mode so far.
      const model = buildDifficulty(this.store.difficultySamples(settings.mode));
      samples = model.samples;
      colors = generateChallengeColors(seed, settings.rounds, model.fn);
    }
    return this.store.saveChallenge({ week: week.id, settings, seed, colors, difficultySamples: samples, createdAt: this.now() });
  }

  /**
   * Everything a room needs to play this week's challenge for one player, or
   * why they cannot (one attempt per week). Names are not filtered: one can be
   * hidden by hand afterwards (README: weekly challenge).
   */
  prepare(clientId: string): Prepared {
    const week = challengeWeek(this.now());
    if (this.store.entry(week.id, clientId)) {
      return { ok: false, code: 'already_played', message: 'You’ve already played this week’s challenge. A new one starts on Monday.' };
    }
    const c = this.challengeFor(week);
    const settings: GameSettings = { ...c.settings };
    const hooks: ChallengeHooks = {
      week: week.id,
      number: week.number,
      seed: c.seed,
      colors: c.colors,
      begin: (p) => {
        const ok = this.store.startEntry({ week: week.id, ...p });
        this.cache.delete(week.id);
        return ok;
      },
      update: (p) => {
        this.store.updateEntry({ week: week.id, ...p, avgDeltaE: p.avgDeltaE === null ? null : round2(p.avgDeltaE) });
        this.cache.delete(week.id);
      },
      standing: (id) => {
        const me = this.store.entry(week.id, id);
        return me ? { rank: this.store.rankOf(week.id, me), players: this.store.countEntries(week.id) } : null;
      },
    };
    return { ok: true, settings, hooks };
  }

  // ---- what the pages show ------------------------------------------------

  private board(weekId: string): Board {
    const hit = this.cache.get(weekId);
    const now = this.now();
    if (hit && now - hit.at < this.cacheMs) return hit;
    const fresh: Board = {
      at: now,
      top: this.store.topEntries(weekId, LEADERBOARD_SIZE),
      players: this.store.countEntries(weekId),
      rounds: this.store.challengeRoundStats(weekId),
    };
    this.cache.set(weekId, fresh);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value as string);
    return fresh;
  }

  private summary(week: ChallengeWeek, players: number): WeekSummary {
    // Before anyone has played, the week's settings come from the schedule; afterwards from what was stored.
    const settings = this.store.getChallenge(week.id)?.settings ?? challengeConfig(week);
    return {
      id: week.id,
      number: week.number,
      startsAt: week.startsAt,
      endsAt: week.endsAt,
      mode: settings.mode,
      rounds: settings.rounds,
      roundSeconds: settings.roundSeconds,
      players,
    };
  }

  private row(e: EntryRow, rank: number, clientId: string): LeaderRow {
    const you = e.clientId === clientId;
    return {
      rank,
      // A hidden name stays visible to its owner, so they are not confused by their own row.
      name: e.nameHidden && !you ? HIDDEN_NAME : e.name,
      score: e.score,
      avgDeltaE: e.avgDeltaE,
      totalTimeMs: e.totalTimeMs,
      rounds: e.rounds,
      you,
    };
  }

  /** The home card: public numbers, plus this player's own place. */
  status(clientId: string): ChallengeStatus {
    const now = this.now();
    const week = challengeWeek(now);
    const { players } = this.board(week.id);
    const me = this.store.entry(week.id, clientId);
    let lastWeek: ChallengeStatus['lastWeek'] = null;
    if (now - week.startsAt < LAST_WEEK_VISIBLE_MS) {
      const prev = previousWeek(week);
      const top = this.board(prev.id).top.slice(0, 3);
      if (top.length) lastWeek = { id: prev.id, number: prev.number, top: top.map((e, i) => this.row(e, i + 1, clientId)) };
    }
    return {
      serverNow: now,
      week: this.summary(week, players),
      you: me
        ? {
            rank: this.store.rankOf(week.id, me),
            score: me.score,
            rounds: me.rounds,
            finished: me.finishedAt !== null,
            inProgress: me.finishedAt === null && this.isPlaying(clientId),
          }
        : null,
      lastWeek,
    };
  }

  /** This week's top 30 and the player's own row. Only for players who have played this week (null otherwise). */
  leaderboard(clientId: string): LeaderboardResponse | null {
    const week = challengeWeek(this.now());
    const me = this.store.entry(week.id, clientId);
    if (!me) return null;
    const { top, players } = this.board(week.id);
    const rows = top.map((e, i) => this.row(e, i + 1, clientId));
    // The cached top can be a few seconds old: always show the player's own row as it is now.
    const myIndex = rows.findIndex((r) => r.you);
    const mine = this.row(me, this.store.rankOf(week.id, me), clientId);
    if (myIndex >= 0) rows[myIndex] = { ...mine, rank: rows[myIndex]?.rank ?? mine.rank };
    return { week: this.summary(week, Math.max(players, mine.rank)), rows, you: myIndex >= 0 ? null : mine, colors: this.colorStats(week, me) };
  }

  /** The week's colors in round order, everyone's average error on each, and the player's own answer. */
  private colorStats(week: ChallengeWeek, me: EntryRow): ColorStat[] {
    const challenge = this.store.getChallenge(week.id);
    if (!challenge) return [];
    const everyone = new Map(this.board(week.id).rounds.map((r) => [r.round, r]));
    const mine = new Map(this.store.picksOf(me.gameId, me.clientId).map((p) => [p.round, p]));
    return challenge.colors.map((hex, round) => {
      const all = everyone.get(round);
      const own = mine.get(round);
      return {
        round,
        hex,
        avgError: all?.avg === null || all?.avg === undefined ? null : round2(all.avg),
        answered: all?.answered ?? 0,
        missed: all?.missed ?? 0,
        yourPick: own?.pickHex ?? null,
        yourError: own?.deltaE ?? null,
      };
    });
  }
}
