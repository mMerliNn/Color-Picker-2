import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type App } from '../src/server/app.js';
import type { PickRecord } from '../src/server/db.js';
import type { StatsResponse } from '../src/shared/stats.js';

let app: App;
let base: string;
let dir: string;

const ALICE = 'cid-alice-0000001';
const BOB = 'cid-bob-000000002';

function seed(clientId: string, name: string, rounds: number, deltaE: number, mode: 'classic' | 'memory' = 'classic'): void {
  const gameId = `game-${clientId}-${mode}`;
  app.store.startGame({
    id: gameId,
    roomCode: 'TEST1',
    seed: 1,
    rounds,
    roundSeconds: 20,
    mode,
    memorizeSeconds: mode === 'memory' ? 3 : null,
    playerCount: 1,
    startedAt: 1000,
  });
  const picks: PickRecord[] = Array.from({ length: rounds }, (_, i) => ({
    gameId,
    round: i,
    clientId,
    playerName: name,
    targetHex: '#3366cc',
    pickHex: '#3a6ad0',
    deltaE,
    score: 70,
    timeMs: 6000 + i * 100,
  }));
  app.store.logRound(picks, 2000);
}

async function post(path: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colormatch-api-'));
  writeFileSync(join(dir, 'index.html'), '<title>game</title>');
  writeFileSync(join(dir, 'stats.html'), '<title>stats page</title>');
  mkdirSync(join(dir, 'assets'));
  app = await startApp({ port: 0, host: '127.0.0.1', dbFile: ':memory:', staticDir: dir, allowedOrigins: [], statsCacheMs: 0 });
  base = `http://127.0.0.1:${app.port}`;
  seed(ALICE, 'Alice', 8, 4);
  seed(BOB, 'Bob', 6, 9);
  seed(ALICE, 'Alice', 5, 15, 'memory');
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/stats', () => {
  it("returns the caller's own statistics", async () => {
    const res = await post('/api/stats', { clientId: ALICE });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const stats = (await res.json()) as StatsResponse;
    expect(stats.totals).toMatchObject({ games: 1, rounds: 8, answered: 8, misses: 0, avgDeltaE: 4 });
    expect(stats.hue).toHaveLength(12);
  });

  it("never mixes in another player's picks", async () => {
    const alice = (await (await post('/api/stats', { clientId: ALICE })).json()) as StatsResponse;
    const bob = (await (await post('/api/stats', { clientId: BOB })).json()) as StatsResponse;
    expect(alice.totals.rounds).toBe(8);
    expect(bob.totals.rounds).toBe(6);
    expect(bob.totals.avgDeltaE).toBe(9);
  });

  it('gives an unknown player empty stats instead of an error', async () => {
    const res = await post('/api/stats', { clientId: 'cid-nobody-0000003' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as StatsResponse).totals.rounds).toBe(0);
  });

  it('gives each game mode its own statistics', async () => {
    const classic = (await (await post('/api/stats', { clientId: ALICE })).json()) as StatsResponse;
    const named = (await (await post('/api/stats', { clientId: ALICE, mode: 'classic' })).json()) as StatsResponse;
    const memory = (await (await post('/api/stats', { clientId: ALICE, mode: 'memory' })).json()) as StatsResponse;
    expect(named).toEqual(classic); // no mode means the default page
    expect(classic.totals).toMatchObject({ games: 1, rounds: 8, avgDeltaE: 4 });
    expect(memory.totals).toMatchObject({ games: 1, rounds: 5, avgDeltaE: 15 });
    const bobMemory = (await (await post('/api/stats', { clientId: BOB, mode: 'memory' })).json()) as StatsResponse;
    expect(bobMemory.totals.rounds).toBe(0);
  });

  it('rejects bad input', async () => {
    expect((await post('/api/stats', { clientId: ALICE, mode: 'blind' })).status).toBe(400);
    expect((await post('/api/stats', { clientId: ALICE, mode: 1 })).status).toBe(400);
    expect((await post('/api/stats', { clientId: 'short' })).status).toBe(400);
    expect((await post('/api/stats', { clientId: 'has spaces and/slashes!!' })).status).toBe(400);
    expect((await post('/api/stats', { nothing: true })).status).toBe(400);
    expect((await post('/api/stats', 'not json')).status).toBe(400);
    expect((await post('/api/stats', { clientId: ALICE, pad: 'x'.repeat(2000) })).status).toBe(413);
  });

  it('only accepts POST and known paths, and does not take ids from the URL', async () => {
    const get = await fetch(`${base}/api/stats?clientId=${ALICE}`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await post('/api/unknown', { clientId: ALICE })).status).toBe(404);
    expect(await get.text()).not.toContain('totals');
  });

  it('sends no CORS headers, so other sites cannot read it from a browser', async () => {
    const res = await post('/api/stats', { clientId: ALICE }, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('the stats page and everyone-comparison', () => {
  it('serves stats.html at /stats and at every mode page, and the game for unknown modes', async () => {
    for (const path of ['/stats', '/stats/', '/stats/classic', '/stats/memory', '/stats/memory/']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain('stats page');
    }
    // Like any unknown address: the game page, never a stats page for a mode that does not exist.
    for (const path of ['/stats/blind', '/stats/memory/extra', '/stats/MEMORY']) {
      expect(await (await fetch(`${base}${path}`)).text(), path).toContain('<title>game</title>');
    }
    expect(await (await fetch(`${base}/`)).text()).toContain('<title>game</title>');
  });

  it('leaves simulated bots out of the comparison numbers', async () => {
    seed('bot-aaaaaaaa-1', 'Ada (bot)', 60, 30);
    const stats = (await (await post('/api/stats', { clientId: ALICE })).json()) as StatsResponse;
    // 14 human picks only: far below the minimum for comparisons.
    expect(stats.totals.everyoneAvgDeltaE).toBeNull();
    expect(stats.hue.every((h) => h.everyoneAvgDeltaE === null)).toBe(true);
  });
});

describe('POST /api/delete', () => {
  // The API allows bursts of 20 requests, then 10 a second; let it refill after the tests above.
  beforeAll(() => new Promise((done) => setTimeout(done, 1500)));

  it("removes only the caller's data", async () => {
    const before = app.store.countPicks();
    const res = await post('/api/delete', { clientId: BOB });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 6 });
    expect(app.store.countPicks()).toBe(before - 6);

    const bob = (await (await post('/api/stats', { clientId: BOB })).json()) as StatsResponse;
    expect(bob.totals.rounds).toBe(0);
    const alice = (await (await post('/api/stats', { clientId: ALICE })).json()) as StatsResponse;
    expect(alice.totals.rounds).toBe(8);
  });

  it('is idempotent and validates input', async () => {
    expect(await (await post('/api/delete', { clientId: BOB })).json()).toEqual({ deleted: 0 });
    expect((await post('/api/delete', { clientId: '' })).status).toBe(400);
    expect((await fetch(`${base}/api/delete`)).status).toBe(405);
  });
});

describe('rate limiting', () => {
  it('answers 429 when the API is hammered', async () => {
    const statuses = await Promise.all(Array.from({ length: 60 }, () => post('/api/stats', { clientId: ALICE }).then((r) => r.status)));
    expect(statuses).toContain(429);
    expect(statuses).toContain(200);
  });
});
