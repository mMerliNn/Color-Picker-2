import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startApp, type App } from '../src/server/app.js';
import { MAX_PLAYERS, type ClientMessage, type ServerMessage } from '../src/shared/protocol.js';

/** A real websocket client that records everything it receives. */
class Bot {
  inbox: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; ok: (m: ServerMessage) => void }[] = [];
  readonly ws: WebSocket;
  closeCode: number | null = null;

  constructor(
    port: number,
    readonly name: string,
    readonly clientId: string,
    headers: Record<string, string> = {},
  ) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      this.inbox.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.ok(msg);
        return false;
      });
    });
    this.ws.on('close', (code) => (this.closeCode = code));
    this.ws.on('error', () => {});
  }

  opened(): Promise<void> {
    return new Promise((ok, fail) => {
      this.ws.once('open', () => ok());
      this.ws.once('error', fail);
      this.ws.once('unexpected-response', (_req, res) => fail(new Error(`HTTP ${res.statusCode}`)));
    });
  }
  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }
  /** Resolves with the first message (already received or future) matching `pred`. */
  waitFor<T extends ServerMessage['t']>(type: T, extra: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 8000) {
    type M = Extract<ServerMessage, { t: T }>;
    const pred = (m: ServerMessage): m is M => m.t === type && extra(m as M);
    const seen = this.inbox.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise<M>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`${this.name}: timed out waiting for ${type}`)), ms);
      this.waiters.push({
        pred,
        ok: (m) => {
          clearTimeout(timer);
          ok(m as M);
        },
      });
    });
  }
  last<T extends ServerMessage['t']>(type: T) {
    return this.inbox.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === type).at(-1);
  }
  close() {
    this.ws.close();
  }
}

let app: App;
let staticDir: string;
let port: number;
const bots: Bot[] = [];

async function bot(name: string, n = 0, headers?: Record<string, string>): Promise<Bot> {
  const b = new Bot(port, name, `cid-${name.toLowerCase().replace(/\W/g, '')}-${n}`.padEnd(12, '0'), headers);
  bots.push(b);
  await b.opened();
  return b;
}

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), 'colormatch-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>test app</title>');
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  app = await startApp({
    port: 0,
    host: '127.0.0.1',
    dbFile: ':memory:',
    staticDir,
    allowedOrigins: [],
    game: { timing: { startDelayMs: 40, revealMs: 80, graceMs: 40 } },
  });
  port = app.port;
});

afterAll(async () => {
  for (const b of bots) b.close();
  await app.close();
  rmSync(staticDir, { recursive: true, force: true });
});

describe('http', () => {
  it('serves the app, assets, health check and security headers', async () => {
    const index = await fetch(`http://127.0.0.1:${port}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('test app');
    expect(index.headers.get('x-content-type-options')).toBe('nosniff');
    expect(index.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(index.headers.get('cache-control')).toBe('no-cache');

    const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');

    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    // Client-side route -> app shell; missing file with extension -> 404
    expect(await (await fetch(`http://127.0.0.1:${port}/some/route`)).text()).toContain('test app');
    expect((await fetch(`http://127.0.0.1:${port}/nope.js`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })).status).toBe(405);
  });

  it('does not serve files outside the static root', async () => {
    for (const path of ['/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fpackage.json']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const body = await res.text();
      expect(body).not.toContain('"colormatch"');
    }
  });
});

describe('websocket', () => {
  it('rejects non-/ws upgrade paths and disallowed origins', async () => {
    const wrongPath = new WebSocket(`ws://127.0.0.1:${port}/other`);
    await new Promise((ok) => {
      wrongPath.on('error', ok);
      wrongPath.on('open', ok);
    });
    expect(wrongPath.readyState).not.toBe(WebSocket.OPEN);

    const strict = await startApp({
      port: 0,
      host: '127.0.0.1',
      dbFile: ':memory:',
      staticDir,
      allowedOrigins: ['https://colorpick.fun'],
    });
    try {
      const bad = new WebSocket(`ws://127.0.0.1:${strict.port}/ws`, { headers: { Origin: 'https://evil.example' } });
      const failed = await new Promise<boolean>((ok) => {
        bad.on('error', () => ok(true));
        bad.on('open', () => ok(false));
      });
      expect(failed).toBe(true);
      const good = new WebSocket(`ws://127.0.0.1:${strict.port}/ws`, { headers: { Origin: 'https://colorpick.fun' } });
      await new Promise<void>((ok, fail) => {
        good.on('open', () => ok());
        good.on('error', fail);
      });
      good.close();
    } finally {
      await strict.close();
    }
  });

  it('drops oversized and binary frames without crashing the server', async () => {
    const b = await bot('Spammer', 99);
    b.ws.send(Buffer.from('x'.repeat(5000)));
    await new Promise((ok) => b.ws.once('close', ok));
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(ok.status).toBe(200);
  });

  it(`plays a complete 5-round game with ${MAX_PLAYERS} simultaneous players`, async () => {
    const host = await bot('Host', 1);
    host.send({ t: 'create', clientId: host.clientId, name: 'Host', settings: { rounds: 5, roundSeconds: 15 } });
    const created = await host.waitFor('state');
    const code = created.code;

    const guests: Bot[] = [];
    for (let i = 1; i < MAX_PLAYERS; i++) guests.push(await bot(`Guest${i}`, i + 1));
    for (const g of guests) g.send({ t: 'join', clientId: g.clientId, name: g.name, code });
    await Promise.all(guests.map((g) => g.waitFor('state')));
    await host.waitFor('state', (s) => s.players.length === MAX_PLAYERS);

    // Room is full now.
    const extra = await bot('Extra', 500);
    extra.send({ t: 'join', clientId: extra.clientId, name: 'Extra', code });
    expect((await extra.waitFor('error')).code).toBe('room_full');

    // Everyone plays: the host is perfect, guest 1 is off by a lot, the rest are close.
    const everyone = [host, ...guests];
    const seen = new Map<Bot, string[]>();
    for (const b of everyone) {
      seen.set(b, []);
      b.ws.on('message', (data) => {
        const m = JSON.parse(String(data)) as ServerMessage;
        if (m.t !== 'round') return;
        seen.get(b)!.push(m.color);
        const hex =
          b === host ? m.color : b === guests[0] ? '#808080' : m.color.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
        b.send({ t: 'pick', hex });
      });
    }
    host.send({ t: 'start' });
    const final = await host.waitFor('final', () => true, 15_000);

    // Everyone saw the same five colors, in the same order.
    const hostColors = seen.get(host)!;
    expect(hostColors).toHaveLength(5);
    expect(final.colors).toEqual(hostColors);
    for (const b of everyone) expect(seen.get(b)).toEqual(hostColors);

    expect(final.standings).toHaveLength(MAX_PLAYERS);
    expect(final.standings[0]!.name).toBe('Host');
    expect(final.standings[0]!.total).toBe(500);
    expect(final.standings.at(-1)!.name).toBe('Guest1');
    const rounds = (await Promise.all(everyone.map((b) => b.waitFor('reveal', (r) => r.index === 4)))).length;
    expect(rounds).toBe(MAX_PLAYERS);

    // Every pick of every player was logged.
    expect(app.store.countPicks()).toBe(MAX_PLAYERS * 5);
    const games = app.store.listGames();
    expect(games).toHaveLength(1);
    expect(games[0]!.player_count).toBe(MAX_PLAYERS);
    expect(games[0]!.ended_at).not.toBeNull();
  }, 30_000);

  it('resumes a game after a real socket drop', async () => {
    const host = await bot('Hostess', 700);
    host.send({ t: 'create', clientId: host.clientId, name: 'Hostess', settings: { rounds: 5, roundSeconds: 15 } });
    const code = (await host.waitFor('state')).code;
    const friend = await bot('Friend', 701);
    friend.send({ t: 'join', clientId: friend.clientId, name: 'Friend', code });
    await friend.waitFor('state');

    host.send({ t: 'start' });
    const round = await friend.waitFor('round');
    friend.ws.terminate(); // network drop, no goodbye
    await new Promise((ok) => setTimeout(ok, 30));

    const again = new Bot(port, 'Friend', friend.clientId);
    bots.push(again);
    await again.opened();
    again.send({ t: 'join', clientId: again.clientId, name: 'Friend', code });
    const resumed = await again.waitFor('round');
    expect(resumed.color).toBe(round.color);
    expect(resumed.index).toBe(0);
    expect((await again.waitFor('state', (s) => s.phase === 'picking')).youId).toBe(
      (await friend.waitFor('state')).youId,
    );
  }, 15_000);
});
