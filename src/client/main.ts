import './styles.css';
import type { ServerMessage } from '../shared/protocol.js';
import type { Actions, Ctx, Model, View } from './ctx.js';
import { h } from './dom.js';
import { Connection, type Status } from './net.js';
import { countdownView, finalView, homeView, lobbyView, playView, revealView, syncView } from './views.js';
import { getClientId, profile, readStore, writeStore } from './identity.js';

// ---- persistence ----------------------------------------------------------
// Identity and storage helpers live in identity.ts (shared with the stats page).

const params = new URLSearchParams(location.search);
const local = 'local' as const;
const session = 'session' as const;
const clientId = getClientId();

// ---- model ----------------------------------------------------------------

const model: Model = {
  status: 'connecting',
  name: readStore(local, 'name') ?? '',
  room: null,
  startsAt: 0,
  round: null,
  reveal: null,
  final: null,
  prefillCode: (params.get('room') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5),
  busy: false,
};

// Server clock estimate. Each ping/pong gives a sample; the sample with the
// smallest round trip is the most trustworthy (least delay asymmetry), so that
// one wins. Before the first pong we fall back to timestamps on other messages.
interface ClockSample {
  rtt: number;
  offset: number;
}
const clockSamples: ClockSample[] = [];
let clockSynced = false;
let clockOffset = 0;
const now = () => Date.now() + clockOffset;

function onPong(msg: Extract<ServerMessage, { t: 'pong' }>): void {
  const received = Date.now();
  const rtt = received - msg.c;
  if (!(rtt >= 0 && rtt < 10_000)) return; // nonsense (clock jump): ignore
  // The server stamped its time about half a round trip ago.
  clockSamples.push({ rtt, offset: msg.serverNow + rtt / 2 - received });
  if (clockSamples.length > 8) clockSamples.shift();
  const best = clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  clockOffset = best.offset;
  clockSynced = true;
}

/** Silent (no toast if the socket is down): a missed ping just means a later one fixes it. */
function sendPing(): void {
  conn.send({ t: 'ping', c: Date.now() });
}
setInterval(() => {
  if (conn.isOpen()) sendPing();
}, 5000);

const banner = document.getElementById('banner') as HTMLElement;
const toast = document.getElementById('toast') as HTMLElement;
const app = document.getElementById('app') as HTMLElement;

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function notify(message: string): void {
  toast.textContent = message;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 4500);
}

// ---- networking -----------------------------------------------------------

const conn = new Connection({
  onStatus(status: Status) {
    model.status = status;
    if (status === 'open') {
      // Sync the clock straight away (a few samples, the best one is used).
      sendPing();
      setTimeout(sendPing, 500);
      setTimeout(sendPing, 1500);
      // Resume the saved room after a reload or a dropped connection.
      const code = readStore(session, 'room');
      if (code && model.name) conn.send({ t: 'join', clientId, name: model.name, code });
    }
    renderBanner();
  },
  onMessage: handleMessage,
  onReplaced() {
    app.replaceChildren(
      h(
        'section',
        { class: 'card center' },
        h('h2', null, 'Open somewhere else'),
        h('p', { class: 'muted' }, 'This game was opened in another tab or device, which took over your seat.'),
        h('button', { class: 'btn primary', type: 'button', onClick: () => location.reload() }, 'Use this tab instead'),
      ),
    );
    banner.hidden = true;
  },
});

function send(msg: Parameters<Connection['send']>[0]): boolean {
  const ok = conn.send(msg);
  if (!ok) notify('Not connected yet. Retrying…');
  return ok;
}

function handleMessage(msg: ServerMessage): void {
  if (msg.t === 'pong') {
    onPong(msg);
    return;
  }
  // Rough estimate (ignores travel time) until the first ping/pong has measured the real one.
  if ('serverNow' in msg && !clockSynced) clockOffset = msg.serverNow - Date.now();

  switch (msg.t) {
    case 'state':
      model.busy = false;
      model.room = {
        code: msg.code,
        youId: msg.youId,
        hostId: msg.hostId,
        phase: msg.phase,
        settings: msg.settings,
        players: msg.players,
      };
      if (msg.phase === 'lobby') {
        model.round = null;
        model.reveal = null;
        model.final = null;
      }
      writeStore(session, 'room', msg.code);
      if (params.has('room')) history.replaceState(null, '', profile ? `/?profile=${profile}` : '/');
      break;

    case 'starting':
      if (model.room) model.room.phase = 'starting';
      model.startsAt = msg.startsAt;
      break;

    case 'round':
      sendPing(); // refresh the clock estimate at the start of every round
      if (model.room) model.room.phase = 'picking';
      model.round = {
        index: msg.index,
        total: msg.total,
        color: msg.color,
        endsAt: msg.endsAt,
        submitted: msg.submitted,
        expected: msg.expected,
        youPick: msg.youPick,
      };
      break;

    case 'progress':
      if (model.round) {
        model.round.submitted = msg.submitted;
        model.round.expected = msg.expected;
      }
      break;

    case 'picked':
      if (model.round) model.round.youPick = msg.hex;
      break;

    case 'reveal':
      if (model.room) model.room.phase = 'reveal';
      model.reveal = msg;
      break;

    case 'final':
      if (model.room) model.room.phase = 'final';
      model.final = msg;
      break;

    case 'error':
      model.busy = false;
      if (!model.room && (msg.code === 'no_room' || msg.code === 'in_progress' || msg.code === 'room_full')) {
        writeStore(session, 'room', null); // a failed auto-resume must not retry forever
      }
      notify(msg.message);
      break;
  }
  render();
}

// ---- actions --------------------------------------------------------------

const actions: Actions = {
  create(name) {
    model.name = name;
    writeStore(local, 'name', name);
    model.busy = send({ t: 'create', clientId, name });
    render();
  },
  join(code, name) {
    model.name = name;
    writeStore(local, 'name', name);
    model.busy = send({ t: 'join', clientId, name, code });
    render();
  },
  start: () => void send({ t: 'start' }),
  setSettings: (settings) => void send({ t: 'settings', settings }),
  pick: (hex) => send({ t: 'pick', hex }),
  draft: (hex) => conn.send({ t: 'draft', hex }),
  again: () => void send({ t: 'again' }),
  leave() {
    send({ t: 'leave' });
    writeStore(session, 'room', null);
    model.room = null;
    model.round = null;
    model.reveal = null;
    model.final = null;
    render();
  },
  notify,
};

const ctx: Ctx = { model, actions, now };

// ---- rendering ------------------------------------------------------------

let currentKey = '';
let current: View | null = null;

function screenKey(): string {
  const { room, round, reveal, final } = model;
  if (!room) return 'home';
  switch (room.phase) {
    case 'lobby':
      return 'lobby';
    case 'starting':
      return 'countdown';
    case 'picking':
      return round ? `play-${round.index}` : 'sync';
    case 'reveal':
      return reveal ? `reveal-${reveal.index}` : 'sync';
    case 'final':
      return final ? 'final' : 'sync';
  }
}

function build(key: string): View {
  if (key === 'home') return homeView(ctx);
  if (key === 'lobby') return lobbyView(ctx);
  if (key === 'countdown') return countdownView(ctx);
  if (key.startsWith('play-')) return playView(ctx);
  if (key.startsWith('reveal-')) return revealView(ctx);
  if (key === 'final') return finalView(ctx);
  return syncView();
}

function render(): void {
  const key = screenKey();
  if (key !== currentKey) {
    currentKey = key;
    current = build(key);
    app.replaceChildren(current.el);
    window.scrollTo(0, 0);
    current.tick?.();
  } else {
    current?.update?.();
  }
  document.title = model.room ? `Color Match · ${model.room.code}` : 'Color Match';
  renderBanner();
}

function renderBanner(): void {
  const lost = model.status !== 'open';
  banner.hidden = !lost;
  banner.textContent = model.status === 'connecting' ? 'Connecting…' : 'Connection lost. Reconnecting…';
}

setInterval(() => current?.tick?.(), 100);

render();
conn.start();
