import { randomInt, randomUUID } from 'node:crypto';
import { deltaE, generateColors, round2, scoreFromDeltaE, speedBonus } from '../shared/colors.js';
import {
  DEFAULT_SETTINGS,
  MAX_PLAYERS,
  MEMORY_STATIC_MS,
  UNLIMITED_SECONDS,
  isMemoryMode,
  isRapidMode,
  shotClockDeadline,
  type ErrorCode,
  type GameSettings,
  type Phase,
  type PlayerInfo,
  type RoundResult,
  type RoundReview,
  type ServerMessage,
  type Standing,
} from '../shared/protocol.js';
import type { GameStore, PickRecord } from './db.js';

/** A connected client, abstracted so rooms can be tested without sockets. */
export interface Conn {
  send(msg: ServerMessage): void;
  close(): void;
}

export interface RoomTiming {
  /** "Get ready" countdown before round 1. */
  startDelayMs: number;
  /** How long each round's results stay on screen. */
  revealMs: number;
  /**
   * Extra time after the deadline in which a late pick or draft is still
   * accepted. The same for everyone (a per-player allowance could be gamed by
   * pretending to be laggy). Generous enough for a phone on a far-away network.
   */
  graceMs: number;
  /** A disconnected lobby player is dropped after this long. */
  lobbyPurgeMs: number;
}

export const DEFAULT_TIMING: RoomTiming = {
  startDelayMs: 3000,
  revealMs: 7000,
  graceMs: 1500,
  lobbyPurgeMs: 30_000,
};

/** In unlimited games a pick's recorded time is capped here (one hour). */
export const MAX_UNLIMITED_TIME_MS = 60 * 60 * 1000;

export interface Player {
  id: string; // public per-room id
  clientId: string; // private anonymous identity; never sent to other players
  name: string;
  conn: Conn | null;
  joinedAt: number;
  total: number;
  totalTimeMs: number;
  deltaEs: number[];
  /** This game's rounds as this player played them, for their own review at the end. */
  rounds: RoundReview[];
  pick: { hex: string; timeMs: number } | null;
  /** Latest color the player had on screen without locking in (never shown to others). */
  draft: string | null;
  purgeTimer: ReturnType<typeof setTimeout> | null;
}

export type JoinResult =
  | { ok: true; player: Player }
  | { ok: false; code: ErrorCode; message: string };

type RevealMessage = Extract<ServerMessage, { t: 'reveal' }>;
/** The part of the final results that is the same for everyone; each player also gets their own rounds. */
type FinalMessage = Omit<Extract<ServerMessage, { t: 'final' }>, 'yourRounds'>;

export class Room {
  readonly code: string;
  settings: GameSettings;
  phase: Phase = 'lobby';
  hostId = '';
  lastActivity = Date.now();

  private readonly players = new Map<string, Player>();
  private readonly byClient = new Map<string, Player>();
  private nextPlayerNumber = 1;

  private gameId: string | null = null;
  private colors: string[] = [];
  private roundIndex = -1;
  /** When the picker unlocks: the round start in classic, after the color and static in memory mode. */
  private roundStartedAt = 0;
  /** Memory mode: when the color hides (null in classic). */
  private roundHideAt: number | null = null;
  private roundEndsAt: number | null = null; // null = no time limit
  /** Rapid modes: the shot clock has already started this round (it starts once). */
  private shotClockStarted = false;
  private startsAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastReveal: RevealMessage | null = null;
  /** What follows the round result now on screen (next round or final results). */
  private afterReveal: (() => void) | null = null;
  private lastFinal: FinalMessage | null = null;

  constructor(
    code: string,
    settings: Partial<GameSettings>,
    private readonly store: GameStore,
    private readonly timing: RoomTiming = DEFAULT_TIMING,
  ) {
    this.code = code;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    if (isRapidMode(this.settings.mode) && this.unlimited) {
      this.settings = { ...this.settings, roundSeconds: DEFAULT_SETTINGS.roundSeconds };
    }
  }

  // ---- membership ---------------------------------------------------------

  connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.conn) n++;
    return n;
  }

  playerCount(): number {
    return this.players.size;
  }

  /** No time limit per round. Only allowed while a single player is connected. */
  private get unlimited(): boolean {
    return this.settings.roundSeconds === UNLIMITED_SECONDS;
  }

  /**
   * An unlimited round only ends when everyone locks in, so with two or more
   * players one of them could stall the others forever. If a second player
   * shows up in a lobby set to unlimited, fall back to the default time.
   */
  private enforceSoloRule(): void {
    if (this.phase === 'lobby' && this.unlimited && this.connectedCount() > 1) {
      this.settings = { ...this.settings, roundSeconds: DEFAULT_SETTINGS.roundSeconds };
    }
  }

  join(clientId: string, name: string, conn: Conn): JoinResult {
    this.touch();
    const existing = this.byClient.get(clientId);
    if (existing) {
      // Reconnect (or a second tab taking over the seat).
      if (existing.conn && existing.conn !== conn) {
        const old = existing.conn;
        existing.conn = null;
        old.close();
      }
      existing.conn = conn;
      this.cancelPurge(existing);
      this.ensureHost();
      this.enforceSoloRule();
      this.broadcastState();
      this.catchUp(existing);
      return { ok: true, player: existing };
    }

    if (this.phase !== 'lobby') {
      return { ok: false, code: 'in_progress', message: 'That game has already started.' };
    }
    if (this.players.size >= MAX_PLAYERS) {
      return { ok: false, code: 'room_full', message: `This room is full (${MAX_PLAYERS} players).` };
    }

    const player: Player = {
      id: `p${this.nextPlayerNumber++}`,
      clientId,
      name: this.uniqueName(name),
      conn,
      joinedAt: Date.now(),
      total: 0,
      totalTimeMs: 0,
      deltaEs: [],
      rounds: [],
      pick: null,
      draft: null,
      purgeTimer: null,
    };
    this.players.set(player.id, player);
    this.byClient.set(clientId, player);
    this.ensureHost();
    this.enforceSoloRule();
    this.broadcastState();
    return { ok: true, player };
  }

  /** The socket dropped. The seat is kept so the player can resume. */
  detach(player: Player, conn: Conn): void {
    if (player.conn !== conn) return; // already replaced by a newer connection
    player.conn = null;
    this.afterDeparture(player);
  }

  /** The player chose to leave. */
  leave(player: Player): void {
    player.conn = null;
    if (this.phase === 'lobby') this.removePlayer(player);
    else if (this.inGame() && this.connectedCount() === 0) this.abandon();
    else this.afterDeparture(player);
  }

  private inGame(): boolean {
    return this.phase === 'starting' || this.phase === 'picking' || this.phase === 'reveal';
  }

  /**
   * Everyone chose to quit mid-game: stop here instead of playing the remaining
   * rounds to an empty room (which would log them all as misses). The game stays
   * in the log as unfinished; the room is cleaned up like any empty room.
   */
  private abandon(): void {
    this.clearTimer();
    this.afterReveal = null;
    this.phase = 'lobby';
    this.colors = [];
    this.gameId = null;
    this.roundIndex = -1;
    this.roundHideAt = null;
    this.lastReveal = null;
    this.lastFinal = null;
    this.touch();
  }

  private afterDeparture(player: Player): void {
    this.touch();
    if (this.phase === 'lobby') {
      this.cancelPurge(player);
      player.purgeTimer = setTimeout(() => {
        player.purgeTimer = null;
        if (!player.conn) this.removePlayer(player);
      }, this.timing.lobbyPurgeMs);
    }
    this.ensureHost();
    this.broadcastState();
    if (this.phase === 'picking') this.progress();
  }

  private removePlayer(player: Player): void {
    this.cancelPurge(player);
    this.players.delete(player.id);
    this.byClient.delete(player.clientId);
    this.ensureHost();
    this.broadcastState();
  }

  private cancelPurge(player: Player): void {
    if (player.purgeTimer) clearTimeout(player.purgeTimer);
    player.purgeTimer = null;
  }

  private ensureHost(): void {
    const host = this.players.get(this.hostId);
    if (host?.conn) return;
    const next = [...this.players.values()]
      .filter((p) => p.conn)
      .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id, 'en', { numeric: true }))[0];
    if (next) this.hostId = next.id;
  }

  private uniqueName(name: string): string {
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const candidate = `${name} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  // ---- host actions -------------------------------------------------------

  setSettings(player: Player, patch: Partial<GameSettings>): ErrorResult | null {
    if (player.id !== this.hostId) return err('not_host', 'Only the host can change settings.');
    if (this.phase !== 'lobby') return err('wrong_phase', 'Settings are locked once the game starts.');
    if (patch.roundSeconds === UNLIMITED_SECONDS && this.connectedCount() > 1) {
      return err('solo_only', 'Unlimited time is only for solo games. Pick a time limit instead.');
    }
    this.touch();
    this.settings = { ...this.settings, ...patch };
    // The rapid modes' speed bonus shrinks towards the deadline, so they need one.
    if (isRapidMode(this.settings.mode) && this.unlimited) {
      this.settings = { ...this.settings, roundSeconds: DEFAULT_SETTINGS.roundSeconds };
    }
    this.broadcastState();
    return null;
  }

  start(player: Player): ErrorResult | null {
    if (player.id !== this.hostId) return err('not_host', 'Only the host can start the game.');
    if (this.phase !== 'lobby') return err('wrong_phase', 'The game has already started.');
    if (this.unlimited && this.connectedCount() > 1) {
      return err('solo_only', 'Unlimited time is only for solo games. Pick a time limit instead.');
    }
    this.touch();

    const seed = randomInt(0, 2 ** 32);
    this.colors = generateColors(seed, this.settings.rounds);
    this.gameId = randomUUID();
    for (const p of this.players.values()) {
      p.total = 0;
      p.totalTimeMs = 0;
      p.deltaEs = [];
      p.rounds = [];
      p.pick = null;
      p.draft = null;
      this.cancelPurge(p);
    }
    // Players who are not connected at the start are not part of this game.
    for (const p of [...this.players.values()]) if (!p.conn) this.dropSilently(p);

    try {
      this.store.startGame({
        id: this.gameId,
        roomCode: this.code,
        seed,
        rounds: this.settings.rounds,
        roundSeconds: this.settings.roundSeconds,
        mode: this.settings.mode,
        memorizeSeconds: isMemoryMode(this.settings.mode) ? this.settings.memorizeSeconds : null,
        playerCount: this.players.size,
        startedAt: Date.now(),
      });
    } catch (e) {
      console.error('failed to log game start', e);
    }

    this.phase = 'starting';
    this.roundIndex = -1;
    this.lastReveal = null;
    this.lastFinal = null;
    this.startsAt = Date.now() + this.timing.startDelayMs;
    this.broadcastState();
    this.each(() => ({ t: 'starting', serverNow: Date.now(), startsAt: this.startsAt }));
    this.schedule(this.timing.startDelayMs, () => this.beginRound(0));
    return null;
  }

  again(player: Player): ErrorResult | null {
    if (player.id !== this.hostId) return err('not_host', 'Only the host can start a new game.');
    if (this.phase !== 'final') return err('wrong_phase', 'The current game is not finished.');
    this.touch();
    for (const p of [...this.players.values()]) {
      if (!p.conn) this.dropSilently(p);
      else {
        p.total = 0;
        p.totalTimeMs = 0;
        p.deltaEs = [];
        p.rounds = [];
        p.pick = null;
        p.draft = null;
      }
    }
    this.phase = 'lobby';
    this.colors = [];
    this.gameId = null;
    this.roundIndex = -1;
    this.lastReveal = null;
    this.lastFinal = null;
    this.ensureHost();
    this.broadcastState();
    return null;
  }

  private dropSilently(p: Player): void {
    this.cancelPurge(p);
    this.players.delete(p.id);
    this.byClient.delete(p.clientId);
  }

  // ---- gameplay -----------------------------------------------------------

  pick(player: Player, hex: string): ErrorResult | null {
    if (this.phase !== 'picking') return err('wrong_phase', 'No round is in progress.');
    const now = Date.now();
    if (this.tooEarly(now)) return err('wrong_phase', 'Wait for the picker to unlock.');
    if (this.roundEndsAt !== null && now > this.roundEndsAt + this.timing.graceMs) {
      return err('wrong_phase', 'Too late.');
    }
    if (player.pick) return null; // first pick wins; duplicates are ignored
    this.touch();
    const limitMs = this.unlimited ? MAX_UNLIMITED_TIME_MS : this.settings.roundSeconds * 1000;
    const timeMs = Math.min(Math.max(0, now - this.roundStartedAt), limitMs);
    player.pick = { hex, timeMs };
    this.sendTo(player, { t: 'picked', hex });
    this.startShotClock(player, now);
    this.progress();
    return null;
  }

  /**
   * Rapid modes: the first lock-in of a round halves the time left for everyone
   * still choosing (never below 5 s, see shotClockDeadline). Only once per
   * round, only when someone else is still choosing, and it never gives anyone
   * extra time: when too little is left to cut, the deadline stays (everyone is
   * still told who locked in). Late picks and drafts get the usual grace after
   * the new deadline.
   */
  private startShotClock(by: Player, now: number): void {
    if (!isRapidMode(this.settings.mode) || this.shotClockStarted || this.roundEndsAt === null) return;
    const othersChoosing = [...this.players.values()].some((p) => p !== by && p.conn && !p.pick);
    if (!othersChoosing) return;
    this.shotClockStarted = true;
    const shotEnd = shotClockDeadline(now, this.roundEndsAt);
    const shortened = shotEnd < this.roundEndsAt;
    if (shortened) {
      this.roundEndsAt = shotEnd;
      this.schedule(shotEnd - now + this.timing.graceMs, () => this.closeRound());
    }
    const endsAt = this.roundEndsAt;
    this.each(() => ({ t: 'shotClock', serverNow: now, by: by.id, endsAt, shortened }));
  }

  /**
   * Remember the color a player has on screen but has not locked in yet. It is
   * only used if the round ends first. Drafts are frequent and not worth an
   * error reply, so anything unusable (wrong phase, already locked in, too
   * late) is ignored silently.
   */
  draft(player: Player, hex: string): ErrorResult | null {
    if (this.phase !== 'picking' || player.pick) return null;
    if (this.tooEarly(Date.now())) return null;
    if (this.roundEndsAt !== null && Date.now() > this.roundEndsAt + this.timing.graceMs) return null;
    player.draft = hex;
    return null;
  }

  /**
   * Memory mode: a pick or draft while the color is still on screen would be a
   * copy, not a memory. Anything from the moment it hides is accepted (the
   * static after it is a safety margin for a client clock that runs a little
   * ahead), so a fair pick right at the unlock is never refused.
   */
  private tooEarly(now: number): boolean {
    return this.roundHideAt !== null && now < this.roundHideAt;
  }

  private beginRound(index: number): void {
    const now = Date.now();
    this.phase = 'picking';
    this.roundIndex = index;
    this.afterReveal = null;
    if (isMemoryMode(this.settings.mode)) {
      this.roundHideAt = now + this.settings.memorizeSeconds * 1000;
      this.roundStartedAt = this.roundHideAt + MEMORY_STATIC_MS;
    } else {
      this.roundHideAt = null;
      this.roundStartedAt = now;
    }
    // The time to pick (and the grace after it) counts from the unlock.
    this.roundEndsAt = this.unlimited ? null : this.roundStartedAt + this.settings.roundSeconds * 1000;
    this.shotClockStarted = false;
    for (const p of this.players.values()) {
      p.pick = null;
      p.draft = null;
    }
    this.each((p) => this.roundMessage(p));
    if (this.roundEndsAt === null) {
      // No deadline: the round ends when every connected player has locked in.
      this.clearTimer();
    } else {
      this.schedule(this.roundEndsAt - now + this.timing.graceMs, () => this.closeRound());
    }
  }

  /** Solo only: skip the rest of the pause after a round result. */
  next(player: Player): ErrorResult | null {
    if (this.phase !== 'reveal' || !this.afterReveal) {
      return err('wrong_phase', 'There is no round result to skip.');
    }
    if (!player.conn || this.connectedCount() !== 1) {
      return err('solo_only', 'Everyone moves on together in a game with other players.');
    }
    this.touch();
    const go = this.afterReveal;
    this.afterReveal = null;
    this.clearTimer();
    go();
    return null;
  }

  private submittedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.conn && p.pick) n++;
    return n;
  }

  private progress(): void {
    const submitted = this.submittedCount();
    const expected = this.connectedCount();
    this.each(() => ({ t: 'progress', submitted, expected }));
    if (expected > 0 && submitted >= expected) this.closeRound();
  }

  private closeRound(): void {
    if (this.phase !== 'picking') return;
    this.clearTimer();
    this.phase = 'reveal';

    const now = Date.now();
    const index = this.roundIndex;
    const target = this.colors[index] as string;
    const results: RoundResult[] = [];
    const records: PickRecord[] = [];

    const fullRoundMs = this.unlimited ? MAX_UNLIMITED_TIME_MS : this.settings.roundSeconds * 1000;
    const rapid = isRapidMode(this.settings.mode);

    for (const p of this.sortedPlayers()) {
      // Time ran out while the player was still choosing: their last draft counts,
      // as if they had locked in at the buzzer. Never a "miss" for a color they chose.
      const pick = p.pick ?? (p.draft ? { hex: p.draft, timeMs: fullRoundMs } : null);
      let dE: number | null = null;
      let score = 0;
      let bonus = 0;
      let timeMs: number | null = null;
      if (pick) {
        dE = round2(deltaE(target, pick.hex));
        const accuracy = scoreFromDeltaE(dE);
        // Rapid modes: only a color the player actually locked in earns a speed bonus.
        bonus = rapid && p.pick ? speedBonus(accuracy, p.pick.timeMs, fullRoundMs) : 0;
        score = accuracy + bonus;
        timeMs = pick.timeMs;
        p.deltaEs.push(dE);
        p.totalTimeMs += timeMs;
      } else {
        p.totalTimeMs += fullRoundMs;
      }
      p.total += score;
      p.rounds.push({ target, pick: pick?.hex ?? null, deltaE: dE, score, timeMs, lockedIn: p.pick !== null, bonus });
      results.push({ id: p.id, name: p.name, pick: pick?.hex ?? null, deltaE: dE, score, bonus, timeMs, lockedIn: p.pick !== null });
      records.push({
        gameId: this.gameId as string,
        round: index,
        clientId: p.clientId,
        playerName: p.name,
        targetHex: target,
        pickHex: pick?.hex ?? null,
        deltaE: dE,
        score,
        timeMs,
      });
    }

    try {
      this.store.logRound(records, now);
    } catch (e) {
      console.error('failed to log round', e);
    }

    results.sort(
      (a, b) =>
        b.score - a.score || (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity) || a.name.localeCompare(b.name),
    );

    const isLast = index >= this.settings.rounds - 1;
    this.lastReveal = {
      t: 'reveal',
      serverNow: now,
      index,
      total: this.settings.rounds,
      target,
      results,
      standings: this.standings(),
      nextAt: now + this.timing.revealMs,
    };
    const reveal = this.lastReveal;
    this.each(() => reveal);
    const after = () => (isLast ? this.finish() : this.beginRound(index + 1));
    this.afterReveal = after;
    this.schedule(this.timing.revealMs, () => {
      this.afterReveal = null;
      after();
    });
  }

  private finish(): void {
    this.phase = 'final';
    this.afterReveal = null;
    this.roundHideAt = null;
    this.clearTimer();
    try {
      if (this.gameId) this.store.finishGame(this.gameId, Date.now());
    } catch (e) {
      console.error('failed to log game end', e);
    }
    this.lastFinal = { t: 'final', serverNow: Date.now(), standings: this.standings(), colors: this.colors };
    const final = this.lastFinal;
    this.each((p) => ({ ...final, yourRounds: p.rounds }));
  }

  // ---- views --------------------------------------------------------------

  private sortedPlayers(): Player[] {
    return [...this.players.values()].sort(
      (a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id, 'en', { numeric: true }),
    );
  }

  private standings(): Standing[] {
    const sorted = this.sortedPlayers().sort(
      (a, b) => b.total - a.total || a.totalTimeMs - b.totalTimeMs,
    );
    const out: Standing[] = [];
    sorted.forEach((p, i) => {
      const prev = sorted[i - 1];
      const tied = prev && prev.total === p.total && prev.totalTimeMs === p.totalTimeMs;
      out.push({
        id: p.id,
        name: p.name,
        total: p.total,
        avgDeltaE: p.deltaEs.length ? round2(p.deltaEs.reduce((a, b) => a + b, 0) / p.deltaEs.length) : null,
        avgTimeMs: avgLockInMs(p.rounds),
        rank: tied ? (out[i - 1] as Standing).rank : i + 1,
        connected: p.conn !== null,
      });
    });
    return out;
  }

  private stateMessage(p: Player): ServerMessage {
    const players: PlayerInfo[] = this.sortedPlayers().map((q) => ({
      id: q.id,
      name: q.name,
      connected: q.conn !== null,
    }));
    return {
      t: 'state',
      serverNow: Date.now(),
      code: this.code,
      youId: p.id,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      players,
    };
  }

  private roundMessage(p: Player): ServerMessage {
    const now = Date.now();
    const memory = this.roundHideAt !== null;
    // Once hidden, the color is never sent again (a reconnect must not show it).
    const hidden = memory && now >= (this.roundHideAt as number);
    return {
      t: 'round',
      serverNow: now,
      index: this.roundIndex,
      total: this.settings.rounds,
      color: hidden ? null : (this.colors[this.roundIndex] as string),
      hideAt: this.roundHideAt,
      unlockAt: memory ? this.roundStartedAt : null,
      startedAt: this.roundStartedAt,
      endsAt: this.roundEndsAt,
      submitted: this.submittedCount(),
      expected: this.connectedCount(),
      youPick: p.pick?.hex ?? null,
    };
  }

  /** Bring a (re)connected player up to date with the current phase. */
  private catchUp(p: Player): void {
    switch (this.phase) {
      case 'starting':
        this.sendTo(p, { t: 'starting', serverNow: Date.now(), startsAt: this.startsAt });
        break;
      case 'picking':
        this.sendTo(p, this.roundMessage(p));
        break;
      case 'reveal':
        if (this.lastReveal) this.sendTo(p, { ...this.lastReveal, serverNow: Date.now() });
        break;
      case 'final':
        if (this.lastFinal) this.sendTo(p, { ...this.lastFinal, serverNow: Date.now(), yourRounds: p.rounds });
        break;
      default:
        break;
    }
  }

  // ---- plumbing -----------------------------------------------------------

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private sendTo(p: Player, msg: ServerMessage): void {
    try {
      p.conn?.send(msg);
    } catch (e) {
      console.error('send failed', e);
    }
  }

  private each(build: (p: Player) => ServerMessage | null): void {
    for (const p of this.players.values()) {
      if (!p.conn) continue;
      const msg = build(p);
      if (msg) this.sendTo(p, msg);
    }
  }

  private broadcastState(): void {
    this.each((p) => this.stateMessage(p));
  }

  private schedule(ms: number, fn: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Stop timers and drop all connections (room is being deleted). */
  dispose(): void {
    this.clearTimer();
    for (const p of this.players.values()) {
      this.cancelPurge(p);
      const conn = p.conn;
      p.conn = null;
      conn?.close();
    }
  }
}

/** Mean time of the rounds a player locked in (rounded to whole ms), or null when there were none. */
function avgLockInMs(rounds: readonly RoundReview[]): number | null {
  const times = rounds.filter((r) => r.lockedIn && r.timeMs !== null).map((r) => r.timeMs as number);
  return times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
}

export interface ErrorResult {
  code: ErrorCode;
  message: string;
}

function err(code: ErrorCode, message: string): ErrorResult {
  return { code, message };
}
