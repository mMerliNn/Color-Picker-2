import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deltaE, round2, scoreFromDeltaE } from '../src/shared/colors.js';
import { MAX_PLAYERS, type ServerMessage } from '../src/shared/protocol.js';
import { GameStore } from '../src/server/db.js';
import { GameServer, type Session } from '../src/server/game-server.js';
import type { Conn } from '../src/server/room.js';

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
    vi.advanceTimersByTime(15_000 + 800);
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
    vi.advanceTimersByTime(15_000 + 400); // past the deadline, inside grace
    send(bob, { t: 'pick', hex: target(bob) });
    expect(ann.conn.last('reveal')!.results.every((r) => r.score === 100)).toBe(true);

    vi.advanceTimersByTime(7000); // next round begins
    send(ann, { t: 'pick', hex: target(ann) });
    vi.advanceTimersByTime(15_000 + 801);
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
    void code;
  });
});
