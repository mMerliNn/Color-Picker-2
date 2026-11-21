import 'vanilla-colorful/hex-color-picker.js';
import { formatClock, formatSeconds, matchLabel } from '../shared/labels.js';
import {
  MAX_NAME_LENGTH,
  ROOM_CODE_LENGTH,
  ROUND_OPTIONS,
  SECONDS_OPTIONS,
  UNLIMITED_SECONDS,
  type Standing,
} from '../shared/protocol.js';
import type { Ctx, View } from './ctx.js';
import { clear, h, setText, swatch } from './dom.js';
import { profileQuery } from './identity.js';
import { openReview } from './review.js';

const NEUTRAL = '#808080';

function normalizeHex(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (s.startsWith('#')) s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = [...s].map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/.test(s) ? `#${s}` : null;
}

function seconds(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

// ---------------------------------------------------------------------------
// Home: choose a name, create or join a room
// ---------------------------------------------------------------------------

export function homeView(ctx: Ctx): View {
  const nameInput = h('input', {
    id: 'name',
    type: 'text',
    maxlength: MAX_NAME_LENGTH,
    autocomplete: 'nickname',
    placeholder: 'Your name',
    value: ctx.model.name,
    'aria-label': 'Your name',
  });
  const codeInput = h('input', {
    id: 'code',
    type: 'text',
    maxlength: ROOM_CODE_LENGTH,
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'ROOM CODE',
    class: 'code-input',
    value: ctx.model.prefillCode,
    'aria-label': 'Room code',
  });
  const createBtn = h('button', { class: 'btn primary', type: 'button' }, 'Create a room');
  const joinBtn = h('button', { class: 'btn', type: 'button' }, 'Join');

  const needName = (): string | null => {
    const name = nameInput.value.trim();
    if (!name) {
      ctx.actions.notify('Enter a name first.');
      nameInput.focus();
      return null;
    }
    return name;
  };
  const doCreate = () => {
    const name = needName();
    if (name) ctx.actions.create(name);
  };
  const doJoin = () => {
    const name = needName();
    if (!name) return;
    const code = codeInput.value.trim();
    if (code.length !== ROOM_CODE_LENGTH) {
      ctx.actions.notify(`Room codes have ${ROOM_CODE_LENGTH} characters.`);
      codeInput.focus();
      return;
    }
    ctx.actions.join(code, name);
  };
  createBtn.addEventListener('click', doCreate);
  joinBtn.addEventListener('click', doJoin);
  codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && doJoin());
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (codeInput.value.trim() ? doJoin : doCreate)();
  });

  const el = h(
    'section',
    { class: 'card home' },
    h('h1', null, 'Color Match'),
    h(
      'p',
      { class: 'lead' },
      'Everyone gets the same colors. Match each one as closely as you can, and see who has the sharpest eye.',
    ),
    h('label', { for: 'name', class: 'label' }, 'Your name'),
    nameInput,
    h('div', { class: 'stack' }, createBtn),
    h('div', { class: 'divider' }, h('span', null, 'or join a friend')),
    h('div', { class: 'row' }, codeInput, joinBtn),
    h('a', { class: 'btn link', href: `/stats${profileQuery()}` }, 'See my stats'),
  );

  const view: View = {
    el,
    update() {
      const busy = ctx.model.busy;
      createBtn.disabled = busy;
      joinBtn.disabled = busy;
    },
  };
  view.update?.();
  // Focus the first thing still missing.
  queueMicrotask(() => (ctx.model.name ? (ctx.model.prefillCode ? joinBtn : createBtn) : nameInput).focus());
  return view;
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

export function lobbyView(ctx: Ctx): View {
  const room = () => ctx.model.room!;
  const link = `${location.origin}/?room=${room().code}`;

  const linkInput = h('input', {
    type: 'text',
    readonly: true,
    value: link,
    class: 'link-input',
    'aria-label': 'Invite link',
  });
  linkInput.addEventListener('focus', () => linkInput.select());
  const copyBtn = h('button', { class: 'btn small', type: 'button' }, 'Copy invite link');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy invite link'), 1500);
    } catch {
      linkInput.focus(); // clipboard API needs a secure context: select it instead
      ctx.actions.notify('Press Ctrl+C / Cmd+C to copy the link.');
    }
  });

  const list = h('ul', { class: 'players' });
  const count = h('h2', null);

  const roundsSel = h('select', { id: 'rounds' });
  for (const n of ROUND_OPTIONS) roundsSel.append(h('option', { value: n }, `${n} rounds`));
  const secondsSel = h('select', { id: 'seconds' });
  const secondsOptions = new Map<number, HTMLOptionElement>();
  for (const n of SECONDS_OPTIONS) {
    const option = h('option', { value: n }, formatSeconds(n));
    secondsOptions.set(n, option);
    secondsSel.append(option);
  }
  roundsSel.addEventListener('change', () => ctx.actions.setSettings({ rounds: Number(roundsSel.value) }));
  secondsSel.addEventListener('change', () => ctx.actions.setSettings({ roundSeconds: Number(secondsSel.value) }));
  const settings = h(
    'div',
    { class: 'settings' },
    h('label', { for: 'rounds' }, 'Length'),
    roundsSel,
    h('label', { for: 'seconds' }, 'Time per round'),
    secondsSel,
  );
  const unlimitedHint = h(
    'p',
    { class: 'muted fine', hidden: true },
    'No timer: each round ends when you lock in. Unlimited is for solo games; it switches back to 20 seconds if someone joins.',
  );

  const startBtn = h('button', { class: 'btn primary big', type: 'button' }, 'Start game');
  startBtn.addEventListener('click', () => ctx.actions.start());
  const waiting = h('p', { class: 'muted center' }, 'Waiting for the host to start the game…');
  const leaveBtn = h('button', { class: 'btn link', type: 'button' }, 'Leave room');
  leaveBtn.addEventListener('click', () => ctx.actions.leave());

  const el = h(
    'section',
    { class: 'card lobby' },
    h('p', { class: 'muted center' }, 'Room code'),
    h('div', { class: 'room-code', 'aria-label': `Room code ${room().code.split('').join(' ')}` }, room().code),
    h('div', { class: 'row' }, linkInput, copyBtn),
    count,
    list,
    settings,
    unlimitedHint,
    startBtn,
    waiting,
    leaveBtn,
  );

  const view: View = {
    el,
    update() {
      const r = room();
      const isHost = r.hostId === r.youId;
      count.textContent = `Players (${r.players.length})`;
      clear(list);
      for (const p of r.players) {
        list.append(
          h(
            'li',
            { class: p.connected ? '' : 'offline' },
            h('span', { class: 'name' }, p.name),
            p.id === r.youId && h('span', { class: 'tag' }, 'you'),
            p.id === r.hostId && h('span', { class: 'tag host' }, 'host'),
            !p.connected && h('span', { class: 'tag' }, 'reconnecting…'),
          ),
        );
      }
      roundsSel.value = String(r.settings.rounds);
      secondsSel.value = String(r.settings.roundSeconds);
      // Unlimited is solo-only: unavailable while anyone else is in the room.
      const others = r.players.filter((p) => p.connected).length > 1;
      const unlimitedOption = secondsOptions.get(UNLIMITED_SECONDS);
      if (unlimitedOption) unlimitedOption.disabled = others;
      unlimitedHint.hidden = r.settings.roundSeconds !== UNLIMITED_SECONDS;
      roundsSel.disabled = secondsSel.disabled = !isHost;
      startBtn.hidden = !isHost;
      waiting.hidden = isHost;
    },
  };
  view.update?.();
  return view;
}

// ---------------------------------------------------------------------------
// "Get ready" countdown
// ---------------------------------------------------------------------------

export function countdownView(ctx: Ctx): View {
  const number = h('div', { class: 'big-number', 'aria-hidden': 'true' }, '3');
  const el = h(
    'section',
    { class: 'card center' },
    h('h2', null, 'Get ready!'),
    number,
    h('p', { class: 'muted' }, 'The first color appears when the countdown ends.'),
  );
  return {
    el,
    tick() {
      setText(number, String(Math.max(1, seconds(ctx.model.startsAt - ctx.now()))));
    },
  };
}

// ---------------------------------------------------------------------------
// A round: match the target with the picker
// ---------------------------------------------------------------------------

type PickerElement = HTMLElement & { color: string };

export function playView(ctx: Ctx): View {
  const round = ctx.model.round!;
  const unlimited = round.endsAt === null; // solo game without a time limit
  const totalMs = ctx.model.room!.settings.roundSeconds * 1000;
  let current = round.youPick ?? NEUTRAL;
  let locked = round.youPick !== null;
  // Only a color the player actually chose is auto-submitted at the deadline.
  // Otherwise the untouched starting gray would score points for doing nothing.
  let touched = locked;

  // Drafts: while the player is still choosing, keep the server informed of the
  // color on screen (at most 4 times a second). If time runs out first, the
  // server uses the latest draft, so a slow connection or a late timer on a
  // phone can no longer turn a color they chose into a miss.
  let lastDraft: string | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  const flushDraft = () => {
    draftTimer = null;
    if (locked || !touched || current === lastDraft) return;
    if (ctx.actions.draft(current)) lastDraft = current; // not sent (offline)? retried on the next change
  };
  const queueDraft = () => {
    if (!locked && touched && !draftTimer) draftTimer = setTimeout(flushDraft, 250);
  };

  const target = swatch(round.color, 'Target color', 'target');
  const mine = swatch(current, 'Your color');
  const hexInput = h('input', {
    type: 'text',
    class: 'hex-input',
    value: current,
    maxlength: 7,
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Hex color',
  });
  const picker = document.createElement('hex-color-picker') as PickerElement;
  picker.color = current;
  picker.className = 'picker';
  // Belt and braces next to CSS `touch-action: none` (older iPhones ignore it): a
  // touch that begins on the picker never scrolls or rubber-bands the page. The
  // library attaches its own touchmove listener to the document, where browsers
  // treat it as passive and ignore preventDefault, so we do it here, non-passive.
  for (const type of ['touchstart', 'touchmove'] as const) {
    picker.addEventListener(type, (e) => e.cancelable && e.preventDefault(), { passive: false });
  }

  const setCurrent = (hex: string, fromInput = false) => {
    current = hex;
    mine.style.backgroundColor = hex;
    mine.setAttribute('aria-label', `Your color: ${hex}`);
    if (!fromInput) hexInput.value = hex;
    queueDraft();
  };
  // The picker fires this only when the user actually moves it (never for
  // programmatic changes), so it is a reliable "the player chose this color".
  picker.addEventListener('color-changed', (e) => {
    if (locked) return;
    touched = true;
    setCurrent((e as CustomEvent<{ value: string }>).detail.value);
  });
  const markTouched = () => {
    touched = true;
  };
  picker.addEventListener('pointerdown', markTouched);
  picker.addEventListener('keydown', markTouched);
  hexInput.addEventListener('input', () => {
    const hex = normalizeHex(hexInput.value);
    if (hex && !locked) {
      touched = true;
      setCurrent(hex, true);
      picker.color = hex;
    }
  });
  hexInput.addEventListener('blur', () => (hexInput.value = current));

  const timeLabel = h('span', { class: `time-label${unlimited ? ' muted' : ''}`, 'aria-hidden': 'true' }, unlimited ? 'No time limit' : null);
  const bar = h('div', { class: 'timer-fill' });
  const progress = h('p', { class: 'muted center', role: 'status' });
  const submitBtn = h('button', { class: 'btn primary big', type: 'button' }, 'Lock in');

  const lock = () => {
    locked = true;
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Locked in ✓';
    picker.setAttribute('inert', '');
    hexInput.disabled = true;
    if (round.youPick) setCurrent(round.youPick);
  };
  const submit = () => {
    if (locked) return;
    if (ctx.actions.pick(current)) lock();
  };
  submitBtn.addEventListener('click', submit);
  if (locked) lock();

  const el = h(
    'section',
    { class: 'card play' },
    h(
      'div',
      { class: 'play-head' },
      h('h2', null, `Round ${round.index + 1} of ${round.total}`),
      timeLabel,
    ),
    h('div', { class: 'timer', 'aria-hidden': 'true', hidden: unlimited }, bar),
    h(
      'div',
      { class: 'stage' },
      h('figure', null, target, h('figcaption', null, 'Match this')),
      h('figure', null, mine, h('figcaption', null, 'Your color')),
    ),
    picker,
    h('div', { class: 'row center' }, h('label', { for: 'hex', class: 'muted' }, 'Hex'), hexInput),
    submitBtn,
    progress,
  );
  hexInput.id = 'hex';

  const view: View = {
    el,
    update() {
      const r = ctx.model.round;
      if (!r) return;
      setText(progress, `${r.submitted} of ${r.expected} locked in`);
      if (r.youPick && !locked) {
        round.youPick = r.youPick;
        lock();
      }
      queueDraft(); // after a reconnect: resend the draft if the last one never got through
    },
    tick() {
      if (round.endsAt === null) return; // no deadline: nothing to count down
      const remaining = round.endsAt - ctx.now();
      // The bar moves by transform (cheap); text and class change only when their value does.
      const fraction = Math.max(0, Math.min(1, remaining / totalMs));
      bar.style.transform = `scaleX(${fraction.toFixed(3)})`;
      setText(timeLabel, formatClock(seconds(remaining)));
      const urgent = remaining < 5000;
      if (urgent !== el.classList.contains('urgent')) el.classList.toggle('urgent', urgent);
      // Lock in the chosen color just before time runs out.
      if (!locked && touched && remaining <= 400) submit();
    },
  };
  view.update?.();
  view.tick?.();
  return view;
}

// ---------------------------------------------------------------------------
// Round result
// ---------------------------------------------------------------------------

function standingsTable(rows: Standing[], youId: string, withAvg: boolean): HTMLElement {
  const table = h(
    'table',
    { class: 'table' },
    h(
      'thead',
      null,
      h('tr', null, h('th', null, '#'), h('th', null, 'Player'), withAvg && h('th', { title: 'Average color distance (lower is better)' }, 'Avg ΔE'), h('th', null, 'Points')),
    ),
  );
  const body = h('tbody');
  for (const s of rows) {
    body.append(
      h(
        'tr',
        { class: `${s.id === youId ? 'me' : ''} ${s.connected ? '' : 'offline'}`.trim() },
        h('td', null, s.rank),
        h('td', { class: 'name' }, s.name),
        withAvg && h('td', null, s.avgDeltaE === null ? '–' : s.avgDeltaE.toFixed(1)),
        h('td', { class: 'num' }, s.total),
      ),
    );
  }
  table.append(body);
  return table;
}

export function revealView(ctx: Ctx): View {
  const rv = ctx.model.reveal!;
  const youId = ctx.model.room!.youId;
  const mine = rv.results.find((r) => r.id === youId);
  const isLast = rv.index >= rv.total - 1;

  const headline =
    mine && mine.deltaE !== null
      ? `${matchLabel(mine.deltaE)}  ·  ΔE ${mine.deltaE.toFixed(1)}  ·  +${mine.score} points`
      : 'No pick this round  ·  +0 points';

  const countdown = h('p', { class: 'muted center', role: 'status' });
  const roundList = h('ol', { class: 'round-results' });
  for (const r of rv.results) {
    roundList.append(
      h(
        'li',
        { class: r.id === youId ? 'me' : '' },
        swatch(r.pick, `${r.name}'s pick`, 'mini'),
        h('span', { class: 'name' }, r.name),
        h('span', { class: 'muted' }, r.deltaE === null ? 'missed' : `ΔE ${r.deltaE.toFixed(1)}`),
        h('span', { class: 'num' }, `+${r.score}`),
      ),
    );
  }

  const el = h(
    'section',
    { class: 'card reveal' },
    h('h2', null, `Round ${rv.index + 1} result`),
    h(
      'div',
      { class: 'stage' },
      h('figure', null, swatch(rv.target, 'Target color', 'target'), h('figcaption', null, 'Target')),
      h('figure', null, swatch(mine?.pick ?? null, 'Your pick', 'target'), h('figcaption', null, 'Your pick')),
    ),
    h('p', { class: 'headline', role: 'status' }, headline),
    countdown,
    h('h3', null, 'This round'),
    roundList,
    h('h3', null, 'Standings'),
    standingsTable(rv.standings, youId, true),
  );

  return {
    el,
    tick() {
      const s = seconds(rv.nextAt - ctx.now());
      setText(countdown, `${isLast ? 'Final results' : 'Next round'} in ${s}s`);
    },
  };
}

// ---------------------------------------------------------------------------
// Final results
// ---------------------------------------------------------------------------

export function finalView(ctx: Ctx): View {
  const fin = ctx.model.final!;
  const room = ctx.model.room!;
  const isHost = room.hostId === room.youId;

  const podium = h('ol', { class: 'podium' });
  for (const s of fin.standings.filter((x) => x.rank <= 3).slice(0, 5)) {
    podium.append(
      h(
        'li',
        { class: `place place-${s.rank}${s.id === room.youId ? ' me' : ''}` },
        h('span', { class: 'medal', 'aria-hidden': 'true' }, ['🥇', '🥈', '🥉'][s.rank - 1] ?? ''),
        h('span', { class: 'name' }, s.name),
        h('span', { class: 'num' }, `${s.total} pts`),
        h('span', { class: 'sr-only' }, `rank ${s.rank}`),
      ),
    );
  }

  // Your own rounds (pick, ΔE, score), for the "Review my rounds" sheet.
  const me = fin.standings.find((s) => s.id === room.youId);
  const rounds = fin.yourRounds ?? []; // missing from a server older than this client
  const review =
    me && rounds.length > 0
      ? (startAt?: number) =>
          openReview({ player: me.name, total: me.total, avgDeltaE: me.avgDeltaE, date: new Date(), rounds }, el, startAt)
      : null;

  const strip = h('div', { class: 'strip' });
  fin.colors.forEach((c, i) => {
    if (!review) {
      strip.append(swatch(c, `Color ${i + 1}`, 'chip'));
      return;
    }
    // Each chip opens the review at its own round.
    const chip = h('button', { class: 'swatch chip chip-btn', type: 'button', 'aria-label': `Review round ${i + 1} (${c})` });
    chip.style.backgroundColor = c;
    chip.addEventListener('click', () => review(i));
    strip.append(chip);
  });
  const reviewBtn = review && h('button', { class: 'btn big', type: 'button' }, 'Review my rounds');
  reviewBtn?.addEventListener('click', () => review?.());

  const againBtn = h('button', { class: 'btn primary big', type: 'button' }, 'Play again');
  againBtn.addEventListener('click', () => ctx.actions.again());
  const leaveBtn = h('button', { class: 'btn link', type: 'button' }, 'Leave room');
  leaveBtn.addEventListener('click', () => ctx.actions.leave());

  const el = h(
    'section',
    { class: 'card final' },
    h('h2', null, 'Final results'),
    podium,
    standingsTable(fin.standings, room.youId, true),
    h('h3', null, 'The colors'),
    strip,
    reviewBtn,
    isHost ? againBtn : h('p', { class: 'muted center' }, 'Waiting for the host to start another game…'),
    h('a', { class: 'btn link', href: `/stats${profileQuery()}` }, 'See my stats'),
    leaveBtn,
  );
  return { el };
}

export function syncView(): View {
  return { el: h('section', { class: 'card center' }, h('p', { class: 'muted', role: 'status' }, 'Syncing with the game…')) };
}
