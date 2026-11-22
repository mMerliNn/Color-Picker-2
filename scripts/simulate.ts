/**
 * Fill a room with simulated players, for testing the UI and load-testing the
 * server:
 *
 *   npm run simulate -- ABCDE 20
 *   npm run simulate -- ABCDE 29 wss://colorpick.fun/ws
 *
 * Each bot joins room ABCDE, then picks a noisy version of every target a
 * random 1-6 seconds into the round, with its own "skill". The host still
 * starts the game from the browser. Exits when everyone has seen the final
 * results.
 */
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';

const [code, countArg, urlArg] = process.argv.slice(2);
if (!code) {
  console.error('usage: npm run simulate -- <ROOM CODE> [bot count] [ws url]');
  process.exit(1);
}
const roomCode: string = code;
const count = Math.max(1, Math.min(60, Number(countArg ?? 10)));
const url = urlArg ?? 'ws://127.0.0.1:3000/ws';

const NAMES = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jon', 'Kai', 'Lia', 'Max', 'Nia', 'Oz'];

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
/** Shift each RGB channel by up to +-spread. */
function noisy(hex: string, spread: number): string {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (
    '#' +
    channels
      .map((c) => clamp(c + (Math.random() * 2 - 1) * spread))
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')
  );
}

let finished = 0;

function startBot(index: number): void {
  const name = `${NAMES[index % NAMES.length]}${index >= NAMES.length ? index : ''} (bot)`.slice(0, 20);
  const clientId = `bot-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`;
  const skill = 5 + Math.random() * 70; // RGB spread: lower is better
  const ws = new WebSocket(url);
  const send = (m: ClientMessage) => ws.send(JSON.stringify(m));

  ws.on('open', () => send({ t: 'join', clientId, name, code: roomCode }));
  ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as ServerMessage;
    if (m.t === 'round') {
      const color = m.color;
      if (!color) return; // memory mode, joined after the color was hidden: sit this round out
      // Memory mode: wait for the picker to unlock, like a person would.
      const wait = m.unlockAt === null ? 0 : Math.max(0, m.unlockAt - m.serverNow);
      const delay = wait + 1000 + Math.random() * 5000;
      setTimeout(() => ws.readyState === WebSocket.OPEN && send({ t: 'pick', hex: noisy(color, skill) }), delay);
    } else if (m.t === 'error') {
      console.error(`${name}: ${m.code} - ${m.message}`);
      ws.close();
      finished++;
    } else if (m.t === 'final') {
      const me = m.standings.find((s) => s.name === name);
      console.log(`${name.padEnd(12)} skill ±${skill.toFixed(0).padStart(2)}  rank ${me?.rank}/${m.standings.length}  ${me?.total} pts`);
      ws.close();
      finished++;
      if (finished >= count) process.exit(0);
    }
  });
  ws.on('error', (e) => console.error(`${name}: ${e.message}`));
}

console.log(`Adding ${count} bots to room ${roomCode.toUpperCase()} at ${url}`);
for (let i = 0; i < count; i++) setTimeout(() => startBot(i), i * 40);
