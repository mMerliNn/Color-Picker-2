/**
 * Write a fake play history into a SEPARATE database so the stats page has
 * something to show:
 *
 *   npm run seed-demo                       # creates data/demo.db
 *   $env:DB_FILE = 'data/demo.db'; npm start
 *   # then, in the browser console on the game page:
 *   #   localStorage.setItem('cm.clientId', 'demo-client-0001')
 *   # and open /stats
 *
 * "demo-client-0001" plays like a real person with habits: picks run lighter and
 * more vivid than the target, blues are hard and drift toward violet, quick
 * picks are sloppier than slow ones, and the player slowly improves. Twelve
 * other simulated players supply the "everyone" comparison.
 */
import chroma from 'chroma-js';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { GameStore, type PickRecord } from '../src/server/db.js';
import { deltaE, generateColors, mulberry32, round2, scoreFromDeltaE, toLch } from '../src/shared/colors.js';

const clientId = process.argv[2] ?? 'demo-client-0001';
const dbFile = process.argv[3] ?? 'data/demo.db';

if (existsSync(dbFile)) rmSync(dbFile);
for (const ext of ['-wal', '-shm']) if (existsSync(dbFile + ext)) rmSync(dbFile + ext);
const store = new GameStore(dbFile);
const rand = mulberry32(2024);
const gauss = () => {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

interface Persona {
  name: string;
  clientId: string;
  lightBias: number;
  chromaBias: number;
  sigma: number; // overall sloppiness multiplier
  blueTrouble: number; // extra hue sloppiness on blues
  blueDrift: number; // degrees toward violet on blues
  missRate: number;
  improves: boolean;
}

function playGame(p: Persona, gameIndex: number, gamesTotal: number, rounds: number, startedAt: number): void {
  const gameId = randomUUID();
  const seed = Math.floor(rand() * 2 ** 32);
  const colors = generateColors(seed, rounds);
  store.startGame({ id: gameId, roomCode: 'DEMO1', seed, rounds, roundSeconds: 20, playerCount: 1, startedAt });
  const learning = p.improves ? 1.5 - 0.75 * (gameIndex / Math.max(1, gamesTotal - 1)) : 1;
  const picks: PickRecord[] = colors.map((target, round) => {
    if (rand() < p.missRate) {
      return { gameId, round, clientId: p.clientId, playerName: p.name, targetHex: target, pickHex: null, deltaE: null, score: 0, timeMs: null };
    }
    const t = toLch(target);
    const hue = t.h ?? 0;
    const isBlue = hue >= 235 && hue < 300;
    const timeMs = Math.round(3000 + rand() * 14_000);
    const careful = clamp(1.5 - timeMs / 16_000, 0.55, 1.4); // slower picks are more accurate
    const k = p.sigma * learning * careful;
    const l = clamp(t.l + p.lightBias + gauss() * 3.5 * k, 5, 97);
    const c = Math.max(2, t.c + p.chromaBias + gauss() * 4.5 * k);
    const h = hue + (isBlue ? p.blueDrift : 0) + gauss() * 5 * k * (isBlue ? p.blueTrouble : 1);
    const pickHex = chroma.lch(l, c, h).hex();
    const dE = round2(deltaE(target, pickHex));
    return { gameId, round, clientId: p.clientId, playerName: p.name, targetHex: target, pickHex, deltaE: dE, score: scoreFromDeltaE(dE), timeMs };
  });
  store.logRound(picks, startedAt + 60_000);
  store.finishGame(gameId, startedAt + 5 * 60_000);
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

// The person whose page we will look at.
const me: Persona = { name: 'Demo', clientId, lightBias: 4, chromaBias: 5, sigma: 1, blueTrouble: 2.4, blueDrift: 9, missRate: 0.04, improves: true };
const GAMES = 24;
for (let g = 0; g < GAMES; g++) playGame(me, g, GAMES, g % 3 === 0 ? 5 : 10, now - (GAMES - g) * DAY);

// Everyone else (for the "everyone" comparison).
for (let i = 0; i < 12; i++) {
  const other: Persona = {
    name: `Player ${i + 1}`,
    clientId: `other-client-${String(i).padStart(4, '0')}`,
    lightBias: gauss() * 2,
    chromaBias: gauss() * 2,
    sigma: 0.8 + rand() * 1.2,
    blueTrouble: 1 + rand() * 0.8,
    blueDrift: 0,
    missRate: 0.05,
    improves: false,
  };
  for (let g = 0; g < 10; g++) playGame(other, g, 10, 10, now - (10 - g) * DAY);
}

console.log(`Seeded ${store.countPicks()} picks into ${dbFile}. Demo player id: ${clientId}`);
store.close();
