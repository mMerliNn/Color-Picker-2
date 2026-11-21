import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deltaE, round2, scoreFromDeltaE } from '../src/shared/colors.js';
import { MAX_PLAYERS, type ServerMessage } from '../src/shared/protocol.js';
import { GameStore } from '../src/server/db.js';
import { GameServer, type Session } from '../src/server/game-server.js';
import { DEFAULT_TIMING, type Conn } from '../src/server/room.js';

/** How long after the deadline a late pick or draft is still accepted. */
const GRACE = DEFAULT_TIMING.graceMs;

class FakeConn implements Conn {
  msgs: ServerMessage[] = [];
  closed = false;
  send(m: ServerMessage) {
    this.msgs.push(m);
  }
  close() {
    this.closed = true;
  }
  all<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.msgs.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.all(t).at(-1);
  }
}

interface Client {
  conn: FakeConn;
  session: Session;
  clientId: string;
  name: string;
}

let store: GameStore;
let server: GameServer;

function connect(name: string, n = 1): Client {
  const conn = new FakeConn();
  return { conn, session: server.connect(conn), clientId: `cid-${name.toLowerCase()}-${n}0000`, name };
}
function send(c: Client, msg: unknown) {
  server.handle(c.session, JSON.stringify(msg));
}
function create(c: Client, settings?: object): string {
  send(c, { t: 'create', clientId: c.clientId, name: c.name, settings });
  const state = c.conn.last('state');
  if (!state) throw new Error('no state after create');
  return state.code;
}
function join(c: Client, code: string) {
  send(c, { t: 'join', clientId: c.clientId, name: c.name, code });
}
/** Host plus guests in a fresh room, game not started. */
function lobby(names: string[], settings?: object) {
  const clients = names.map((n) => connect(n));
  const code = create(clients[0] as Client, settings);
  for (const c of clients.slice(1)) join(c, code);
  return { clients, code };
}
function start(host: Client) {
  send(host, { t: 'start' });
  vi.advanceTimersByTime(3000); // "get ready" countdown
}

beforeEach(() => {
  vi.useFakeTimers();
  store = new GameStore(':memory:');
  server = new GameServer(store);
});
afterEach(() => {
  server.close();
  store.close();
  vi.useRealTimers();
});

describe('lobby', () => {
  it('creates a room and shares membership with everyone', () => {
    const { clients, code } = lobby(['Ann', 'Bob']);
    expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{5}$/);
    const [ann, bob] = clients as [Client, Client];
    const state = ann.conn.last('state')!;
    expect(state.players.map((p) => p.name)).toEqual(['Ann', 'Bob']);
    expect(state.hostId).toBe(state.youId);
    expect(bob.conn.last('state')!.hostId).toBe(state.hostId);
    expect(bob.conn.last('state')!.youId).not.toBe(state.youId);
  });

  it('never leaks private client ids', () => {
    const { clients } = lobby(['Ann', 'Bob']);
    for (const c of clients) expect(JSON.stringify(c.conn.msgs)).not.toContain('cid-');
  });

  it('is case-insensitive for room codes and rejects unknown ones', () => {
    const { code } = lobby(['Ann']);
    const eve = connect('Eve');
    join(eve, code.toLowerCase());
    expect(eve.conn.last('state')?.code).toBe(code);
    const zed = connect('Zed');
    join(zed, 'ZZZZZ');
    expect(zed.conn.last('error')?.code).toBe('no_room');
  });

  it('de-duplicates names and strips markup characters', () => {
    const { clients, code } = lobby(['Sam']);
    const sam2 = connect('Sam', 2); // different person, same display name
    join(sam2, code);
    const names = clients[0]!.conn.last('state')!.players.map((p) => p.name);
    expect(names).toEqual(['Sam', 'Sam 2']);
    const x = connect('x');
    send(x, { t: 'join', clientId: x.clientId, name: '<b>Eve</b>', code });
    expect(x.conn.last('state')!.players.at(-1)!.name).toBe('bEve/b');
  });

  it(`caps a room at ${MAX_PLAYERS} players`, () => {
    const { code } = lobby(Array.from({ length: MAX_PLAYERS }, (_, i) => `P${i}`));
    const extra = connect('Extra');
    join(extra, code);
    expect(extra.conn.last('error')?.code).toBe('room_full');
  });

  it('only the host can change settings or start', () => {
    const { clients } = lobby(['Ann', 'Bob']);
    const bob = clients[1]!;
    send(bob, { t: 'start' });
    expect(bob.conn.last('error')?.code).toBe('not_host');
    send(bob, { t: 'settings', settings: { rounds: 5 } });
    expect(bob.conn.last('error')?.code).toBe('not_host');
    send(clients[0]!, { t: 'settings', settings: { rounds: 5, roundSeconds: 30 } });
    expect(bob.conn.last('state')!.settings).toEqual({ rounds: 5, roundSeconds: 30 });
  });

  it('transfers host when the host disconnects', () => {
    const { clients } = lobby(['Ann', 'Bob']);
    const [ann, bob] = clients as [Client, Client];
    server.disconnect(ann.session);
    const state = bob.conn.last('state')!;
    expect(state.hostId).toBe(state.youId);
    expect(state.players.find((p) => p.name === 'Ann')!.connected).toBe(false);
  });

  it('drops a disconnected lobby player after the purge delay', () => {
    const { clients } = lobby(['Ann', 'Bob']);
    server.disconnect(clients[1]!.session);
    vi.advanceTimersByTime(31_000);
    expect(clients[0]!.conn.last('state')!.players.map((p) => p.name)).toEqual(['Ann']);
  });

  it('removes a player immediately when they leave the lobby', () => {
    const { clients } = lobby(['Ann', 'Bob']);
    send(clients[1]!, { t: 'leave' });
    expect(clients[0]!.conn.last('state')!.players.map((p) => p.name)).toEqual(['Ann']);
  });
});

describe('validation and abuse', () => {
  it('rejects malformed messages', () => {
    const c = connect('Ann');
    server.handle(c.session, 'not json');
    expect(c.conn.last('error')?.code).toBe('bad_message');
    send(c, { t: 'create', clientId: 'x', name: 'Ann' }); // client id too short
    send(c, { t: 'create', clientId: c.clientId, name: '' });
    send(c, { t: 'create', clientId: c.clientId, name: 'a'.repeat(40) });
    send(c, { t: 'create', clientId: c.clientId, name: 'Ann', settings: { rounds: 999 } });
    send(c, { t: 'whatever' });
    expect(c.conn.all('error').every((e) => e.code === 'bad_message')).toBe(true);
    expect(c.conn.all('error')).toHaveLength(6);
    expect(server.roomCount()).toBe(0);
  });

  it('requires being in a room for game actions', () => {
    const c = connect('Ann');
    send(c, { t: 'pick', hex: '#123456' });
    expect(c.conn.last('error')?.code).toBe('not_in_room');
  });

  it('rate limits message floods', () => {
    const c = connect('Ann');
    for (let i = 0; i < 40; i++) send(c, { t: 'pick', hex: '#123456' });
    expect(c.conn.all('error').some((e) => e.code === 'rate_limited')).toBe(true);
  });

  it('refuses new rooms past the server cap', () => {
    server = new GameServer(store, { maxRooms: 2 });
    create(connect('A'));
    create(connect('B'));
    const c = connect('C');
    send(c, { t: 'create', clientId: c.clientId, name: 'C' });
    expect(c.conn.last('error')?.code).toBe('server_busy');
  });

  it('sweeps abandoned rooms', () => {
    const { clients } = lobby(['Ann']);
    server.disconnect(clients[0]!.session);
    expect(server.roomCount()).toBe(1);
    server.sweep(Date.now() + 11 * 60_000);
    expect(server.roomCount()).toBe(0);
  });
});

describe('a full game', () => {
  function target(c: Client): string {
    return c.conn.last('round')!.color;
  }

  it('gives everyone the same colors, scores on the server and logs every pick', () => {
    const { clients } = lobby(['Ann', 'Bob', 'Cat'], { rounds: 5 });
    const [ann, bob, cat] = clients as [Client, Client, Client];
    start(ann);

    const targets: string[] = [];
    for (let round = 0; round < 5; round++) {
      const color = target(ann);
      targets.push(color);
      expect(target(bob)).toBe(color);
      expect(target(cat)).toBe(color);
      expect(ann.conn.last('round')!.index).toBe(round);

      send(ann, { t: 'pick', hex: color }); // perfect
      send(bob, { t: 'pick', hex: '#808080' }); // way off for most colors
      expect(ann.conn.last('reveal')?.index).not.toBe(round); // still waiting for Cat
      send(cat, { t: 'pick', hex: color.toUpperCase() }); // case must not matter

      const reveal = ann.conn.last('reveal')!;
      expect(reveal.index).toBe(round);
      expect(reveal.target).toBe(color);
      const byName = Object.fromEntries(reveal.results.map((r) => [r.name, r]));
      expect(byName.Ann!.score).toBe(100);
      expect(byName.Ann!.deltaE).toBe(0);
      expect(byName.Bob!.deltaE).toBe(round2(deltaE(color, '#808080')));
      expect(byName.Bob!.score).toBe(scoreFromDeltaE(deltaE(color, '#808080')));
      expect(reveal.results.at(-1)!.name).toBe('Bob');
      vi.advanceTimersByTime(7000); // reveal screen
    }

    expect(new Set(targets).size).toBe(5);
    const final = ann.conn.last('final')!;
    expect(final.colors).toEqual(targets);
    expect(final.standings[0]!.total).toBe(500);
    expect(final.standings.at(-1)!.name).toBe('Bob');
    // Ann and Cat tie (same score, same time because the fake clock never moved).
    expect(final.standings.map((s) => s.rank)).toEqual([1, 1, 3]);

    // Each player gets their own rounds for the review, and nobody else's.
    expect(final.yourRounds).toEqual(targets.map((t) => ({ target: t, pick: t, deltaE: 0, score: 100 })));
    const bobFinal = bob.conn.last('final')!;
    expect(bobFinal.yourRounds.map((r) => r.pick)).toEqual(Array(5).fill('#808080'));
    expect(bobFinal.yourRounds.map((r) => r.target)).toEqual(targets);
    expect(bobFinal.yourRounds.map((r) => r.score)).toEqual(targets.map((t) => scoreFromDeltaE(deltaE(t, '#808080'))));

    // Raw data for the future analysis page: one row per player per round.
    expect(store.countPicks()).toBe(15);
    const [game] = store.listGames();
    expect(game!.rounds).toBe(5);
    expect(game!.player_count).toBe(3);
    expect(game!.ended_at).not.toBeNull();
    const rows = store.picksForGame(game!.id as string);
    expect(rows).toHaveLength(15);
    const bobRows = rows.filter((r) => r.player_name === 'Bob');
    expect(bobRows.map((r) => r.pick_hex)).toEqual(Array(5).fill('#808080'));
    expect(bobRows.map((r) => r.target_hex)).toEqual(targets);
    expect(bobRows.every((r) => typeof r.target_l === 'number' && typeof r.pick_l === 'number')).toBe(true);
    expect(rows.every((r) => String(r.client_id).startsWith('cid-'))).toBe(true);
  });

  it('closes the round at the deadline and scores a missed round as 0', () => {
    const { clients } = lobby(['Ann', 'Bob'], { rounds: 5, roundSeconds: 15 });
    const [ann, bob] = clients as [Client, Client];
    start(ann);
    send(ann, { t: 'pick', hex: target(ann) });
    expect(ann.conn.last('reveal')).toBeUndefined(); // waiting for Bob
    vi.advanceTimersByTime(15_000 + GRACE);
    const reveal = ann.conn.last('reveal')!;
    const bobResult = reveal.results.find((r) => r.name === 'Bob')!;
    expect(bobResult).toMatchObject({ pick: null, deltaE: null, score: 0, timeMs: null });
    expect(bob.conn.last('reveal')).toEqual(reveal);
    const rows = store.picksForGame(store.listGames()[0]!.id as string);
    expect(rows.find((r) => r.player_name === 'Bob')).toMatchObject({ pick_hex: null, score: 0 });
  });

  it('accepts a laggy pick inside the grace window but not after it', () => {
    const { clients } = lobby(['Ann', 'Bob'], { rounds: 5, roundSeconds: 15 });
    const [ann, bob] = clients as [Client, Client];
    start(ann);
    send(ann, { t: 'pick', hex: target(ann) });
    vi.advanceTimersByTime(15_000 + GRACE - 400); // past the deadline, inside grace
    send(bob, { t: 'pick', hex: target(bob) });
    expect(ann.conn.last('reveal')!.results.every((r) => r.score === 100)).toBe(true);

    vi.advanceTimersByTime(7000); // next round begins
    send(ann, { t: 'pick', hex: target(ann) });
    vi.advanceTimersByTime(15_000 + GRACE + 1);
    send(bob, { t: 'pick', hex: target(bob) }); // too late
    expect(bob.conn.last('error')?.code).toBe('wrong_phase');
    expect(ann.conn.last('reveal')!.results.find((r) => r.name === 'Bob')!.pick).toBeNull();
  });

  it('keeps the first pick and ignores later ones', () => {
    const { clients } = lobby(['Ann', 'Bob'], { rounds: 5 });
    const [ann, bob] = clients as [Client, Client];
    start(ann);
    const color = target(ann);
    send(ann, { t: 'pick', hex: '#808080' });
    send(ann, { t: 'pick', hex: color });
    send(bob, { t: 'pick', hex: color });
    expect(ann.conn.last('reveal')!.results.find((r) => r.name === 'Ann')!.pick).toBe('#808080');
  });

  it('breaks ties by speed', () => {
    const { clients } = lobby(['Ann', 'Bob'], { rounds: 5 });
    const [ann, bob] = clients as [Client, Client];
    start(ann);
    for (let i = 0; i < 5; i++) {
      send(bob, { t: 'pick', hex: target(bob) });
      vi.advanceTimersByTime(1000);
      send(ann, { t: 'pick', hex: target(ann) });
      vi.advanceTimersByTime(7000);
    }
    const final = ann.conn.last('final')!;
    expect(final.standings.map((s) => s.name)).toEqual(['Bob', 'Ann']);
    expect(final.standings.map((s) => s.rank)).toEqual([1, 2]);
  });

  it("doesn't wait for players who disconnected", () => {
    const { clients } = lobby(['Ann', 'Bob', 'Cat'], { rounds: 5 });
    const [ann, bob, cat] = clients as [Client, Client, Client];
    start(ann);
    send(ann, { t: 'pick', hex: target(ann) });
    send(bob, { t: 'pick', hex: target(bob) });
    expect(ann.conn.last('reveal')).toBeUndefined();
    server.disconnect(cat.session); // the only one still missing
    const reveal = ann.conn.last('reveal')!;
    expect(reveal.results.find((r) => r.name === 'Cat')!.score).toBe(0);
    expect(reveal.standings.find((s) => s.name === 'Cat')!.connected).toBe(false);
  });

  it('shows progress to everyone', () => {
    const { clients } = lobby(['Ann', 'Bob', 'Cat'], { rounds: 5 });
    const [ann, bob] = clients as [Client, Client, Client];
    start(ann);
    send(bob, { t: 'pick', hex: target(bob) });
    expect(ann.conn.last('progress')).toEqual({ t: 'progress', submitted: 1, expected: 3 });
  });

  it('lets a player resume mid-round with their pick and the same target', () => {
    const { clients, code } = lobby(['Ann', 'Bob'], { rounds: 5 });
    const [ann, bob] = clients as [Client, Client];
    start(ann);
    const color = target(bob);
    send(bob, { t: 'pick', hex: '#123456' });
    server.disconnect(bob.session);

    const again = { ...connect('Bob'), clientId: bob.clientId }; // new socket, same identity
    join(again, code);
    const state = again.conn.last('state')!;
    expect(state.phase).toBe('picking');
    expect(state.players.find((p) => p.name === 'Bob')!.connected).toBe(true);
    expect(again.conn.last('round')).toMatchObject({ color, youPick: '#123456', index: 0 });
  });

  it('a second tab takes over the seat and closes the old socket', () => {
    const { clients, code } = lobby(['Ann', 'Bob']);
    const bob = clients[1]!;
    const tab2 = { ...connect('Bob'), clientId: bob.clientId };
    join(tab2, code);
    expect(bob.conn.closed).toBe(true);
    server.disconnect(bob.session); // the old socket's close event must not evict tab 2
    expect(clients[0]!.conn.last('state')!.players.find((p) => p.name === 'Bob')!.connected).toBe(true);
  });

  it('rejects new players once the game has started', () => {
    const { clients, code } = lobby(['Ann', 'Bob']);
    start(clients[0]!);
    const late = connect('Late');
    join(late, code);
    expect(late.conn.last('error')?.code).toBe('in_progress');
    send(clients[0]!, { t: 'start' });
    expect(clients[0]!.conn.last('error')?.code).toBe('wrong_phase');
  });

  it('lets a reconnecting player catch up on the reveal and final screens', () => {
    const { clients, code } = lobby(['Ann', 'Bob'], { rounds: 5 });
    const [ann, bob] = clients as [Client, Client];
    start(ann);
    send(ann, { t: 'pick', hex: target(ann) });
    send(bob, { t: 'pick', hex: target(bob) });
    server.disconnect(bob.session);
    const b2 = { ...connect('Bob'), clientId: bob.clientId };
    join(b2, code);
    expect(b2.conn.last('reveal')?.index).toBe(0);

    for (let i = 1; i < 5; i++) {
      vi.advanceTimersByTime(7000);
      send(ann, { t: 'pick', hex: target(ann) });
      send(b2, { t: 'pick', hex: target(b2) });
    }
    vi.advanceTimersByTime(7000);
    expect(b2.conn.last('final')).toBeDefined();
    const b3 = { ...connect('Bob'), clientId: bob.clientId };
    join(b3, code);
    expect(b3.conn.last('final')?.standings).toHaveLength(2);
    // The review survives reconnects: all five of Bob's rounds, including the one before the drop.
    expect(b3.conn.last('final')?.yourRounds.map((r) => r.score)).toEqual([100, 100, 100, 100, 100]);
  });

  it('lets the host start a new game from the final screen', () => {
    const { clients, code } = lobby(['Ann', 'Bob', 'Cat'], { rounds: 5 });
    const [ann, bob, cat] = clients as [Client, Client, Client];
    start(ann);
    server.disconnect(cat.session);
    for (let i = 0; i < 5; i++) {
      send(ann, { t: 'pick', hex: target(ann) });
      send(bob, { t: 'pick', hex: target(bob) });
      vi.advanceTimersByTime(7000);
    }
    expect(ann.conn.last('final')).toBeDefined();

    send(bob, { t: 'again' });
    expect(bob.conn.last('error')?.code).toBe('not_host');
    send(ann, { t: 'again' });
    const state = ann.conn.last('state')!;
    expect(state.phase).toBe('lobby');
    expect(state.players.map((p) => p.name)).toEqual(['Ann', 'Bob']); // disconnected Cat dropped

    start(ann);
    expect(ann.conn.last('round')!.index).toBe(0);
    expect(store.listGames()).toHaveLength(2);

    const secondTargets: string[] = [];
    for (let i = 0; i < 5; i++) {
      secondTargets.push(target(ann));
      send(ann, { t: 'pick', hex: target(ann) });
      send(bob, { t: 'pick', hex: target(bob) });
      vi.advanceTimersByTime(7000);
    }
    // The review covers only the new game, not the one before it.
    expect(ann.conn.last('final')!.yourRounds.map((r) => r.target)).toEqual(secondTargets);
    void code;
  });
});


describe('time per round options', () => {
  const target = (c: Client) => c.conn.last('round')!.color;

  it('offers a 1 minute round and closes it after 60 seconds', () => {
    const { clients } = lobby(['Ann', 'Bob'], { rounds: 5, roundSeconds: 60 });
    const [ann, bob] = clients as [Client, Client];
    expect(ann.conn.last('state')!.settings.roundSeconds).toBe(60);
    start(ann);
    const round = ann.conn.last('round')!;
    expect(round.endsAt! - round.serverNow).toBe(60_000);
    send(ann, { t: 'pick', hex: target(ann) });
    vi.advanceTimersByTime(59_000);
    expect(ann.conn.last('reveal')).toBeUndefined(); // still waiting for Bob
    vi.advanceTimersByTime(1_000 + GRACE); // 59 s + 1 s + grace = deadline + grace
    expect(ann.conn.last('reveal')!.results.find((r) => r.name === 'Bob')!.pick).toBeNull();
    expect(bob.conn.last('reveal')).toBeDefined();
  });

  it('only accepts known time options', () => {
    const { clients } = lobby(['Ann']);
    const ann = clients[0]!;
    send(ann, { t: 'settings', settings: { roundSeconds: 45 } });
    send(ann, { t: 'settings', settings: { roundSeconds: -1 } });
    expect(ann.conn.all('error').map((e) => e.code)).toEqual(['bad_message', 'bad_message']);
    send(ann, { t: 'settings', settings: { roundSeconds: 60 } });
    expect(ann.conn.last('state')!.settings.roundSeconds).toBe(60);
  });
});

describe('unlimited time (solo only)', () => {
  const target = (c: Client) => c.conn.last('round')!.color;
  const HOUR = 60 * 60 * 1000;

  it('has no deadline: the round waits for the player and then scores normally', () => {
    const { clients } = lobby(['Ann'], { rounds: 5, roundSeconds: 0 });
    const ann = clients[0]!;
    expect(ann.conn.last('state')!.settings.roundSeconds).toBe(0);
    start(ann);
    expect(ann.conn.last('round')!.endsAt).toBeNull();

    vi.advanceTimersByTime(10 * 60_000); // ten minutes of thinking
    expect(ann.conn.last('reveal')).toBeUndefined();
    send(ann, { t: 'pick', hex: target(ann) });
    expect(ann.conn.last('reveal')!.results[0]).toMatchObject({ score: 100, timeMs: 600_000 });

    for (let i = 1; i < 5; i++) {
      vi.advanceTimersByTime(7000);
      expect(ann.conn.last('round')!.endsAt).toBeNull();
      send(ann, { t: 'pick', hex: target(ann) });
    }
    vi.advanceTimersByTime(7000);
    expect(ann.conn.last('final')!.standings[0]).toMatchObject({ total: 500, rank: 1 });

    const [game] = store.listGames();
    expect(game).toMatchObject({ round_seconds: 0, rounds: 5, player_count: 1 });
    expect(game!.ended_at).not.toBeNull();
  });

  it('caps the recorded time at one hour', () => {
    const { clients } = lobby(['Ann'], { rounds: 5, roundSeconds: 0 });
    const ann = clients[0]!;
    start(ann);
    vi.advanceTimersByTime(2 * HOUR);
    send(ann, { t: 'pick', hex: target(ann) });
    expect(ann.conn.last('reveal')!.results[0]!.timeMs).toBe(HOUR);
    const rows = store.picksForGame(store.listGames()[0]!.id as string);
    expect(rows[0]!.time_ms).toBe(HOUR);
  });

  it('keeps waiting while the player is away and lets them resume', () => {
    const { clients, code } = lobby(['Ann'], { rounds: 5, roundSeconds: 0 });
    const ann = clients[0]!;
    start(ann);
    const color = target(ann);
    server.disconnect(ann.session);
    vi.advanceTimersByTime(30 * 60_000);
    expect(ann.conn.last('reveal')).toBeUndefined();

    const back = { ...connect('Ann'), clientId: ann.clientId };
    join(back, code);
    expect(back.conn.last('round')).toMatchObject({ color, index: 0, endsAt: null });
    send(back, { t: 'pick', hex: color });
    expect(back.conn.last('reveal')!.results[0]!.score).toBe(100);
  });

  it('falls back to the default time when a second player joins', () => {
    const { clients, code } = lobby(['Ann'], { roundSeconds: 0 });
    const ann = clients[0]!;
    expect(ann.conn.last('state')!.settings.roundSeconds).toBe(0);
    const bob = connect('Bob');
    join(bob, code);
    expect(ann.conn.last('state')!.settings.roundSeconds).toBe(20);
    expect(bob.conn.last('state')!.settings.roundSeconds).toBe(20);
  });

  it('refuses to switch to unlimited while others are in the room', () => {
    const { clients } = lobby(['Ann', 'Bob']);
    const ann = clients[0]!;
    send(ann, { t: 'settings', settings: { roundSeconds: 0 } });
    expect(ann.conn.last('error')?.code).toBe('solo_only');
    expect(ann.conn.last('state')!.settings.roundSeconds).toBe(20);
  });

  it('is allowed again once everyone else has left or disconnected', () => {
    const { clients } = lobby(['Ann', 'Bob', 'Cat']);
    const [ann, bob, cat] = clients as [Client, Client, Client];
    send(bob, { t: 'leave' });
    server.disconnect(cat.session); // still listed for a while, but not connected
    send(ann, { t: 'settings', settings: { roundSeconds: 0, rounds: 5 } });
    expect(ann.conn.last('error')).toBeUndefined();
    expect(ann.conn.last('state')!.settings.roundSeconds).toBe(0);
    start(ann); // the disconnected player is dropped, so this is a solo game
    expect(ann.conn.last('round')!.endsAt).toBeNull();
  });
});


describe('drafts: the color on screen counts if time runs out', () => {
  const target = (c: Client) => c.conn.last('round')!.color;
  const twoPlayers = () => {
    const { clients } = lobby(['Ann', 'Bob'], { rounds: 5, roundSeconds: 15 });
    const [ann, bob] = clients as [Client, Client];
    start(ann);
    return { ann, bob };
  };
  const bobResult = (ann: Client) => ann.conn.last('reveal')!.results.find((r) => r.name === 'Bob')!;

  it('scores the latest draft when the round ends before the player locks in', () => {
    const { ann, bob } = twoPlayers();
    send(ann, { t: 'pick', hex: target(ann) });
    send(bob, { t: 'draft', hex: '#112233' });
    send(bob, { t: 'draft', hex: '#445566' }); // the later one wins
    vi.advanceTimersByTime(15_000 + GRACE);
    expect(bobResult(ann)).toMatchObject({ pick: '#445566', timeMs: 15_000 });
    expect(bobResult(ann).score).toBeGreaterThan(0);
    const rows = store.picksForGame(store.listGames()[0]!.id as string);
    expect(rows.find((r) => r.player_name === 'Bob')).toMatchObject({ pick_hex: '#445566', time_ms: 15_000 });
  });

  it('is case-insensitive and still needs a valid color', () => {
    const { ann, bob } = twoPlayers();
    send(bob, { t: 'draft', hex: '#ABCDEF' });
    send(bob, { t: 'draft', hex: 'not a color' });
    send(bob, { t: 'draft', hex: '#12345' });
    expect(bob.conn.all('error').map((e) => e.code)).toEqual(['bad_message', 'bad_message']);
    send(ann, { t: 'pick', hex: target(ann) });
    vi.advanceTimersByTime(15_000 + GRACE);
    expect(bobResult(ann).pick).toBe('#abcdef'); // the invalid ones did not replace it
  });

  it('a real lock-in beats an earlier draft', () => {
    const { ann, bob } = twoPlayers();
    send(bob, { t: 'draft', hex: '#112233' });
    send(bob, { t: 'pick', hex: target(bob) });
    send(ann, { t: 'pick', hex: target(ann) });
    expect(bobResult(ann)).toMatchObject({ pick: target(bob), score: 100 });
  });

  it('is not a lock-in: the round keeps waiting and the counter does not move', () => {
    const { ann, bob } = twoPlayers();
    send(bob, { t: 'draft', hex: '#112233' });
    send(ann, { t: 'pick', hex: target(ann) });
    expect(ann.conn.last('progress')).toEqual({ t: 'progress', submitted: 1, expected: 2 });
    expect(ann.conn.last('reveal')).toBeUndefined();
  });

  it('still counts when it arrives late but inside the grace window, not after the round closed', () => {
    const { ann, bob } = twoPlayers();
    send(ann, { t: 'pick', hex: target(ann) });
    send(bob, { t: 'draft', hex: '#111111' });
    vi.advanceTimersByTime(15_000 + GRACE - 100); // 100 ms before the round closes
    send(bob, { t: 'draft', hex: '#222222' });
    vi.advanceTimersByTime(100); // round closes now
    expect(bobResult(ann).pick).toBe('#222222');
    send(bob, { t: 'draft', hex: '#333333' }); // too late
    expect(bob.conn.last('error')).toBeUndefined(); // ignored quietly
    expect(bobResult(ann).pick).toBe('#222222');
  });

  it('does not carry over to the next round', () => {
    const { ann, bob } = twoPlayers();
    send(bob, { t: 'draft', hex: '#112233' });
    send(ann, { t: 'pick', hex: target(ann) });
    vi.advanceTimersByTime(15_000 + GRACE); // round 1 ends, Bob's draft counts
    expect(bobResult(ann).pick).toBe('#112233');
    vi.advanceTimersByTime(7000); // round 2 begins
    send(ann, { t: 'pick', hex: target(ann) });
    vi.advanceTimersByTime(15_000 + GRACE);
    expect(ann.conn.last('reveal')!.index).toBe(1);
    expect(bobResult(ann)).toMatchObject({ pick: null, score: 0 }); // no draft this time: a miss
  });

  it('counts for a player who dropped off after choosing a color', () => {
    const { ann, bob } = twoPlayers();
    send(bob, { t: 'draft', hex: '#778899' });
    server.disconnect(bob.session);
    send(ann, { t: 'pick', hex: target(ann) }); // the only connected player: round ends
    expect(bobResult(ann).pick).toBe('#778899');
  });

  it('is ignored quietly in the lobby and before a round starts', () => {
    const { clients } = lobby(['Ann']);
    send(clients[0]!, { t: 'draft', hex: '#112233' });
    expect(clients[0]!.conn.last('error')).toBeUndefined();
  });

  it('never ends an unlimited round by itself', () => {
    const { clients } = lobby(['Ann'], { rounds: 5, roundSeconds: 0 });
    const ann = clients[0]!;
    start(ann);
    send(ann, { t: 'draft', hex: '#112233' });
    vi.advanceTimersByTime(5 * 60_000);
    expect(ann.conn.last('reveal')).toBeUndefined();
    send(ann, { t: 'pick', hex: target(ann) });
    expect(ann.conn.last('reveal')!.results[0]).toMatchObject({ pick: target(ann), score: 100 });
  });
});

describe('clock sync (ping / pong)', () => {
  it('echoes the client timestamp together with the server time, even before joining a room', () => {
    const c = connect('Ann');
    send(c, { t: 'ping', c: 12345 });
    expect(c.conn.last('pong')).toEqual({ t: 'pong', c: 12345, serverNow: Date.now() });
  });

  it('rejects malformed pings', () => {
    const c = connect('Ann');
    send(c, { t: 'ping' });
    send(c, { t: 'ping', c: 'soon' });
    send(c, { t: 'ping', c: Number.POSITIVE_INFINITY });
    expect(c.conn.all('error').every((e) => e.code === 'bad_message')).toBe(true);
    expect(c.conn.all('pong')).toHaveLength(0);
  });

  it('works during a game', () => {
    const { clients } = lobby(['Ann'], { rounds: 5, roundSeconds: 15 });
    start(clients[0]!);
    vi.advanceTimersByTime(4000);
    send(clients[0]!, { t: 'ping', c: 1 });
    expect(clients[0]!.conn.last('pong')!.serverNow).toBe(Date.now());
  });
});
