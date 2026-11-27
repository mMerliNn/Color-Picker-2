import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEADERBOARD_SIZE, challengeWeek, previousWeek, timeLeft } from '../src/shared/challenge.js';
import { COLOR_L_RANGE, PRIOR_DIFFICULTY, generateChallengeColors, generateColors, toLch } from '../src/shared/colors.js';
import type { ServerMessage } from '../src/shared/protocol.js';
import { ChallengeService, HIDDEN_NAME } from '../src/server/challenge.js';
import { GameStore } from '../src/server/db.js';
import { buildDifficulty, PRIOR_WEIGHT } from '../src/server/difficulty.js';
import { GameServer, type Session } from '../src/server/game-server.js';
import type { Conn } from '../src/server/room.js';

// ---------------------------------------------------------------------------
// Weeks (Tokyo time)
// ---------------------------------------------------------------------------

describe('challengeWeek', () => {
  it('numbers weeks like ISO weeks of the Tokyo date', () => {
    const w = challengeWeek(Date.parse('2026-11-27T12:00:00Z'));
    expect(w.id).toBe('2026-W48');
    expect(w.number).toBe(48);
    // Monday 23 November, 00:00 in Tokyo is Sunday 22 November, 15:00 UTC.
    expect(new Date(w.startsAt).toISOString()).toBe('2026-11-22T15:00:00.000Z');
    expect(w.endsAt - w.startsAt).toBe(7 * 24 * 3600 * 1000);
  });

  it('starts a new week at Monday 00:00 in Tokyo, whatever the time elsewhere', () => {
    const boundary = Date.parse('2026-11-29T15:00:00Z'); // Monday 30 November, 00:00 JST
    expect(challengeWeek(boundary - 1).id).toBe('2026-W48');
    expect(challengeWeek(boundary).id).toBe('2026-W49');
    // Still Sunday in London and New York, already Monday in Tokyo.
    expect(challengeWeek(Date.parse('2026-11-29T20:00:00Z')).id).toBe('2026-W49');
  });

  it('handles the turn of the year', () => {
    expect(challengeWeek(Date.parse('2026-01-01T03:00:00Z')).id).toBe('2026-W01'); // a Thursday
    expect(challengeWeek(Date.parse('2027-01-01T03:00:00Z')).id).toBe('2026-W53'); // 2026 has 53 weeks
    expect(challengeWeek(Date.parse('2027-01-04T03:00:00Z')).id).toBe('2027-W01');
    expect(previousWeek(challengeWeek(Date.parse('2027-01-04T03:00:00Z'))).id).toBe('2026-W53');
  });

  it('says how long is left in plain words', () => {
    expect(timeLeft(3 * 24 * 3600_000 + 5)).toBe('3 days');
    expect(timeLeft(30 * 3600_000)).toBe('30 hours');
    expect(timeLeft(60_000)).toBe('1 minute');
    expect(timeLeft(0)).toBe('1 minute');
  });
});

// ---------------------------------------------------------------------------
// Colors and difficulty
// ---------------------------------------------------------------------------

describe('generateChallengeColors', () => {
  it('is deterministic and covers every hue sector and lightness band once', () => {
    const a = generateChallengeColors(1234, 10);
    expect(generateChallengeColors(1234, 10)).toEqual(a);
    expect(generateChallengeColors(1235, 10)).not.toEqual(a);
    expect(a).toHaveLength(10);
    const sectors = a.map((c) => Math.floor(((toLch(c).h ?? 0) % 360) / 36)).sort((x, y) => x - y);
    // Gamut clipping can nudge a hue a little, so allow a near miss but expect broad coverage.
    expect(new Set(sectors).size).toBeGreaterThanOrEqual(8);
    const bands = a.map((c) => Math.floor((toLch(c).l - COLOR_L_RANGE[0]) / 5.5)).sort((x, y) => x - y);
    expect(new Set(bands).size).toBeGreaterThanOrEqual(8);
  });

  it('leans toward the colors the difficulty model calls hard', () => {
    const avgChroma = (colors: string[]) => colors.reduce((s, c) => s + toLch(c).c, 0) / colors.length;
    const plain: string[] = [];
    const challenge: string[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      plain.push(...generateColors(seed, 10));
      challenge.push(...generateChallengeColors(seed, 10));
    }
    // The prior calls muted colors hard.
    expect(avgChroma(challenge)).toBeLessThan(avgChroma(plain) - 4);
  });
});

describe('buildDifficulty', () => {
  it('uses the prior until there is data, then moves toward what players measure', () => {
    const lch = { l: 50, c: 40, h: 200 };
    expect(buildDifficulty([]).fn(lch)).toBe(PRIOR_DIFFICULTY(lch));
    const hard = Array.from({ length: PRIOR_WEIGHT }, () => ({ targetL: 50, targetC: 40, targetH: 200, relError: 2 }));
    const model = buildDifficulty(hard);
    expect(model.samples).toBe(PRIOR_WEIGHT);
    // Equal weight for prior and data: halfway between them.
    expect(model.fn(lch)).toBeCloseTo((PRIOR_DIFFICULTY(lch) + 2) / 2, 5);
    // Other cells are untouched.
    expect(model.fn({ l: 50, c: 40, h: 20 })).toBe(PRIOR_DIFFICULTY({ l: 50, c: 40, h: 20 }));
  });
});

// ---------------------------------------------------------------------------
// Playing the challenge
// ---------------------------------------------------------------------------

class FakeConn implements Conn {
  msgs: ServerMessage[] = [];
  send(m: ServerMessage) {
    this.msgs.push(m);
  }
  close() {}
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.msgs.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t).at(-1);
  }
}

let store: GameStore;
let challenges: ChallengeService;
let server: GameServer;
const NOW = Date.parse('2026-11-27T03:00:00Z'); // Friday of 2026-W48
const WEEK = '2026-W48';

function player(name: string, id = `cid-${name.toLowerCase()}-0000`) {
  const conn = new FakeConn();
  const session: Session = server.connect(conn);
  const send = (msg: object) => server.handle(session, JSON.stringify(msg));
  return { conn, session, send, id, name, play: () => send({ t: 'challenge', clientId: id, name }) };
}

/** Lock in `hex` for the current round and skip the result pause. */
function playRound(p: ReturnType<typeof player>, hex: string) {
  p.send({ t: 'pick', hex });
  p.send({ t: 'next' });
  vi.advanceTimersByTime(500); // stay under the message rate limit
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store = new GameStore(':memory:');
  challenges = new ChallengeService(store, { secret: 'test-secret', cacheMs: 0 });
  server = new GameServer(store, { challenges });
});
afterEach(() => {
  server.close();
  store.close();
  vi.useRealTimers();
});

describe('weekly challenge games', () => {
  it('plays 10 rounds of 30 s Classic with the week’s colors, the same for everyone', () => {
    const ann = player('Ann');
    ann.play();
    const state = ann.conn.last('state');
    expect(state?.challenge).toEqual({ week: WEEK, number: 48 });
    expect(state?.settings).toMatchObject({ mode: 'classic', rounds: 10, roundSeconds: 30 });
    expect(state?.phase).toBe('starting');
    // Never a lobby: the browser reads a challenge room in the lobby as "stopped".
    expect(ann.conn.msgs.some((m) => m.t === 'state' && m.phase === 'lobby')).toBe(false);
    vi.advanceTimersByTime(3000);
    const round = ann.conn.last('round');
    expect(round?.total).toBe(10);
    expect((round?.endsAt ?? 0) - (round?.startedAt ?? 0)).toBe(30_000);

    const bob = player('Bob');
    bob.play();
    vi.advanceTimersByTime(3000);
    expect(bob.conn.last('round')?.color).toBe(round?.color);
    expect(store.getChallenge(WEEK)?.colors[0]).toBe(round?.color);
  });

  it('only counts an attempt once the first color appears', () => {
    const ann = player('Ann');
    ann.play();
    expect(store.entry(WEEK, ann.id)).toBeNull(); // countdown: nothing shown yet
    ann.send({ t: 'leave' });
    ann.play(); // may start again
    vi.advanceTimersByTime(3000);
    expect(store.entry(WEEK, ann.id)).not.toBeNull();
  });

  it('keeps the points so far when the player quits, and allows one attempt only', () => {
    const ann = player('Ann');
    ann.play();
    vi.advanceTimersByTime(3000);
    const target = ann.conn.last('round')?.color as string;
    playRound(ann, target);
    playRound(ann, '#000000');
    ann.send({ t: 'leave' });
    const entry = store.entry(WEEK, ann.id);
    expect(entry).toMatchObject({ rounds: 2, finishedAt: null });
    expect(entry?.score).toBeGreaterThanOrEqual(100);

    ann.play();
    expect(ann.conn.last('error')?.code).toBe('already_played');
    expect(challenges.status(ann.id).you).toMatchObject({ rank: 1, rounds: 2, finished: false, inProgress: false });
  });

  it('records the whole game and the place this week at the end', () => {
    const ann = player('Ann');
    ann.play();
    vi.advanceTimersByTime(3000);
    for (let i = 0; i < 10; i++) playRound(ann, ann.conn.last('round')?.color as string);
    const final = ann.conn.last('final');
    expect(final?.challenge).toEqual({ rank: 1, players: 1 });
    expect(store.entry(WEEK, ann.id)).toMatchObject({ rounds: 10, score: 1000 });
    expect(store.entry(WEEK, ann.id)?.finishedAt).not.toBeNull();
    expect(store.listGames()[0]).toMatchObject({ challenge_week: WEEK, mode: 'classic' });
    // No "play again" in a challenge.
    ann.send({ t: 'again' });
    expect(ann.conn.last('error')?.code).toBe('wrong_phase');
  });

  it('resumes a running attempt instead of starting a second one', () => {
    const ann = player('Ann');
    ann.play();
    vi.advanceTimersByTime(3000);
    const code = ann.conn.last('state')?.code;
    server.disconnect(ann.session); // the tab was closed
    expect(challenges.status(ann.id).you?.inProgress).toBe(true);
    const again = player('Ann');
    again.play();
    expect(again.conn.last('state')?.code).toBe(code);
    expect(again.conn.last('round')?.index).toBe(0);
  });

  it('never lets anyone else into a challenge room', () => {
    const ann = player('Ann');
    ann.play();
    const code = ann.conn.last('state')?.code;
    const bob = player('Bob');
    bob.send({ t: 'join', clientId: bob.id, name: 'Bob', code });
    expect(bob.conn.last('error')?.code).toBe('no_room');
  });

  it('uses a secret seed: the same secret gives the same week, another secret another', () => {
    const other = new ChallengeService(new GameStore(':memory:'), { secret: 'another-secret' });
    expect(challenges.seedFor(WEEK, 'classic')).toBe(new ChallengeService(new GameStore(':memory:'), { secret: 'test-secret' }).seedFor(WEEK, 'classic'));
    expect(other.seedFor(WEEK, 'classic')).not.toBe(challenges.seedFor(WEEK, 'classic'));
    expect(challenges.seedFor('2026-W49', 'classic')).not.toBe(challenges.seedFor(WEEK, 'classic'));
  });
});

describe('leaderboard', () => {
  function seedEntries(n: number, week = WEEK, startedAt = NOW) {
    for (let i = 0; i < n; i++) {
      const clientId = `cid-seed-${String(i).padStart(4, '0')}`;
      store.startEntry({ week, clientId, name: `P${i}`, gameId: `g${i}`, startedAt });
      store.updateEntry({ week, clientId, gameId: `g${i}`, score: 900 - i * 10, totalTimeMs: 100_000, rounds: 10, avgDeltaE: 3, finishedAt: startedAt });
    }
  }

  it('is only for players who have played this week', () => {
    seedEntries(3);
    expect(challenges.leaderboard('cid-nobody-0000')).toBeNull();
    expect(challenges.leaderboard('cid-seed-0001')?.rows).toHaveLength(3);
  });

  it('shows the top 30 and always the player’s own row', () => {
    seedEntries(40);
    const board = challenges.leaderboard('cid-seed-0035');
    expect(board?.rows).toHaveLength(LEADERBOARD_SIZE);
    expect(board?.rows.some((r) => r.you)).toBe(false);
    expect(board?.you).toMatchObject({ rank: 36, name: 'P35', you: true });
    expect(board?.week.players).toBe(40);
    const top = challenges.leaderboard('cid-seed-0002');
    expect(top?.you).toBeNull();
    expect(top?.rows[2]).toMatchObject({ rank: 3, you: true });
    expect(challenges.status('cid-seed-0035').you?.rank).toBe(36);
  });

  it('breaks ties on points by total time', () => {
    for (const [id, time] of [['cid-slow-0000', 200_000], ['cid-fast-0000', 100_000]] as const) {
      store.startEntry({ week: WEEK, clientId: id, name: id, gameId: id, startedAt: NOW });
      store.updateEntry({ week: WEEK, clientId: id, gameId: id, score: 500, totalTimeMs: time, rounds: 10, avgDeltaE: 5, finishedAt: NOW });
    }
    expect(challenges.leaderboard('cid-slow-0000')?.rows.map((r) => r.name)).toEqual(['cid-fast-0000', 'cid-slow-0000']);
  });

  it('hides a moderated name from everyone but its owner', () => {
    seedEntries(2);
    store.setNameHidden(WEEK, 'P0', true);
    expect(challenges.leaderboard('cid-seed-0001')?.rows[0]?.name).toBe(HIDDEN_NAME);
    expect(challenges.leaderboard('cid-seed-0000')?.rows[0]?.name).toBe('P0');
  });

  it('shows last week’s top 3 on the home card for the first days of a week', () => {
    const lastWeekTime = Date.parse('2026-11-20T03:00:00Z');
    seedEntries(5, '2026-W47', lastWeekTime);
    // Friday: too late in the week.
    expect(challenges.status('cid-x-00000000').lastWeek).toBeNull();
    vi.setSystemTime(Date.parse('2026-11-24T03:00:00Z')); // Tuesday of W48
    const status = challenges.status('cid-x-00000000');
    expect(status.lastWeek?.number).toBe(47);
    expect(status.lastWeek?.top.map((r) => r.name)).toEqual(['P0', 'P1', 'P2']);
    expect(status.you).toBeNull();
  });

  it('forgets a player who deletes their history', () => {
    seedEntries(2);
    store.deleteClientData('cid-seed-0000');
    expect(challenges.leaderboard('cid-seed-0001')?.rows).toHaveLength(1);
  });
});

describe('the week’s colors on the leaderboard', () => {
  it('shows each color with everyone’s average error and the player’s own answer', () => {
    const ann = player('Ann');
    ann.play();
    vi.advanceTimersByTime(3000);
    const first = ann.conn.last('round')?.color as string;
    playRound(ann, first); // exact: error 0
    playRound(ann, '#000000');
    ann.send({ t: 'leave' });

    const bob = player('Bob');
    bob.play();
    vi.advanceTimersByTime(3000);
    playRound(bob, '#808080');
    bob.send({ t: 'leave' });

    const colors = challenges.leaderboard(ann.id)?.colors ?? [];
    expect(colors).toHaveLength(10);
    expect(colors.map((c) => c.hex)).toEqual(store.getChallenge(WEEK)?.colors);
    const bobError = store.entry(WEEK, bob.id)?.avgDeltaE as number;
    expect(colors[0]).toMatchObject({ round: 0, answered: 2, missed: 0, yourPick: first, yourError: 0 });
    expect(colors[0]?.avgError).toBeCloseTo(bobError / 2, 1);
    expect(colors[1]).toMatchObject({ answered: 1, yourPick: '#000000' });
    // Not reached by anyone: no numbers yet.
    expect(colors[5]).toMatchObject({ avgError: null, answered: 0, yourPick: null, yourError: null });
    // Bob only played round 1.
    expect(challenges.leaderboard(bob.id)?.colors[1]).toMatchObject({ yourPick: null, yourError: null });
  });
});
