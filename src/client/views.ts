import 'vanilla-colorful/hex-color-picker.js';
import { formatClock, formatSeconds, matchLabel } from '../shared/labels.js';
import { RAPID_MAX_BONUS, grayOf, grayValue } from '../shared/colors.js';
import {
  MAX_NAME_LENGTH,
  MEMORIZE_OPTIONS,
  MODE_CATEGORIES,
  ROOM_CODE_LENGTH,
  ROUND_OPTIONS,
  UNLIMITED_SECONDS,
  categoryOf,
  isGrayMode,
  isMemoryMode,
  isRapidMode,
  secondsOptions,
  type GameMode,
  type GameSettings,
  type ModeCategory,
  type ModeVariant,
  type PlayerInfo,
  type Standing,
} from '../shared/protocol.js';
import type { Ctx, View } from './ctx.js';
import { clear, h, setText, swatch } from './dom.js';
import { profileQuery } from './identity.js';
import { openReview, pickTime } from './review.js';
import { statsPath } from '../shared/stats.js';
import { timeLeft, type ChallengeStatus } from '../shared/challenge.js';

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

  const home = h(
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
  const challenge = challengeCard(ctx, needName);
  const el = h('div', null, home, challenge.el);

  const view: View = {
    el,
    update() {
      const busy = ctx.model.busy;
      createBtn.disabled = busy;
      joinBtn.disabled = busy;
      challenge.setBusy(busy);
    },
  };
  view.update?.();
  // Focus the first thing still missing.
  queueMicrotask(() => (ctx.model.name ? (ctx.model.prefillCode ? joinBtn : createBtn) : nameInput).focus());
  return view;
}

// ---------------------------------------------------------------------------
// Home: the weekly challenge card
// ---------------------------------------------------------------------------

const MEDALS = ['🥇', '🥈', '🥉'];

function playersText(n: number): string {
  return n === 0 ? 'no players yet' : n === 1 ? '1 player' : `${n} players`;
}

/**
 * "Weekly challenge · Week 48 · ends in 3 days · 85 players" with a Play
 * button, or your place once you have played (and a Resume button while your
 * attempt is still running in another tab). Last week's top 3 show during the
 * first days of a new week. The numbers come from /api/challenge.
 */
function challengeCard(ctx: Ctx, needName: () => string | null): { el: HTMLElement; setBusy(busy: boolean): void } {
  const week = h('span', { class: 'challenge-week' });
  const meta = h('p', { class: 'muted challenge-meta' }, 'Loading…');
  const rules = h('p', { class: 'muted fine' });
  const you = h('p', { class: 'challenge-you', hidden: true });
  const playBtn = h('button', { class: 'btn primary big', type: 'button', hidden: true }, 'Play');
  const boardLink = h('a', { class: 'btn big board-link', href: `/challenge${profileQuery()}`, hidden: true }, 'See the leaderboard');
  const winners = h('div', { class: 'challenge-winners', hidden: true });
  playBtn.addEventListener('click', () => {
    const name = needName();
    if (name) ctx.actions.challenge(name);
  });

  const show = (st: ChallengeStatus | null) => {
    if (!st) {
      setText(meta, 'The weekly challenge is not available right now.');
      return;
    }
    const w = st.week;
    setText(week, `Week ${w.number}`);
    setText(meta, `Ends in ${timeLeft(w.endsAt - st.serverNow)} · ${playersText(w.players)}`);
    setText(rules, `${w.rounds} colors, ${w.roundSeconds} s each. One try per browser: it counts from the moment the first color appears.`);
    const me = st.you;
    playBtn.hidden = me !== null && !me.inProgress;
    setText(playBtn, me?.inProgress ? 'Resume' : 'Play');
    boardLink.hidden = me === null;
    boardLink.classList.toggle('primary', me !== null && !me.inProgress);
    you.hidden = me === null;
    if (me) {
      const place = `#${me.rank} of ${w.players}`;
      if (me.inProgress) setText(you, `You’re playing: ${me.rounds} of ${w.rounds} rounds so far.`);
      else if (me.finished) setText(you, `You: ${place} · ${me.score} points`);
      else setText(you, `You: ${place} · ${me.score} points (stopped after ${me.rounds} of ${w.rounds} rounds)`);
    }
    winners.hidden = !st.lastWeek;
    if (st.lastWeek) {
      winners.replaceChildren(
        h('h3', null, `Last week’s winners · Week ${st.lastWeek.number}`),
        h(
          'ol',
          { class: 'winners' },
          ...st.lastWeek.top.map((r) =>
            h(
              'li',
              { class: r.you ? 'me' : '' },
              h('span', { class: 'medal', 'aria-hidden': 'true' }, MEDALS[r.rank - 1] ?? ''),
              h('span', { class: 'name' }, r.name),
              h('span', { class: 'num' }, `${r.score}`),
              h('span', { class: 'sr-only' }, `place ${r.rank}, ${r.score} points`),
            ),
          ),
        ),
      );
    }
  };
  void ctx.actions.challengeStatus().then(show);

  const el = h(
    'section',
    { class: 'card challenge-card', 'aria-labelledby': 'challenge-title' },
    h('div', { class: 'challenge-head' }, h('h2', { id: 'challenge-title' }, 'Weekly challenge (beta ver.)'), week),
    meta,
    rules,
    you,
    playBtn,
    boardLink,
    winners,
  );
  return {
    el,
    setBusy(busy) {
      playBtn.disabled = busy;
    },
  };
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

/** A variant's own setting, shown inside its button once it is selected ("Standard · 3 s"). */
interface VariantSetting {
  key: 'memorizeSeconds';
  label: string; // for screen readers
  options: readonly number[];
}
const SHOW_TIME: VariantSetting = { key: 'memorizeSeconds', label: 'Show color for', options: MEMORIZE_OPTIONS };
/** Only the memory modes have one (how long the color shows); the rapid modes need no setting. */
function variantSetting(mode: GameMode): VariantSetting | null {
  return isMemoryMode(mode) ? SHOW_TIME : null;
}

/** One line under the settings: what the chosen mode is about. At most two lines on a phone. */
function modeHint(s: GameSettings): string {
  switch (s.mode) {
    case 'rapid':
      return 'Lock in early for up to +50% points. The first lock-in halves the time left (10 s max).';
    case 'memory':
      return `The color shows for ${s.memorizeSeconds} s, then hides behind static. Match it from memory.`;
    case 'grayscale':
      return 'How light is each gray, from 0 (black) to 100 (white)? Turn off night mode first.';
    case 'grayscale-rapid':
      return 'Rate each gray from 0 (black) to 100 (white). Lock in early for up to +50%.';
    case 'memory-rapid':
      // Short enough for two lines even on a 320 px phone.
      return `Shown for ${s.memorizeSeconds} s. Lock in early for up to +50%; the first lock-in halves the time (10 s max).`;
    default:
      return 'The color stays on screen while you match it. Points for accuracy only.';
  }
}

/**
 * The lobby's mode choice: a category first (Mode: Classic, Memory), then a
 * variant inside it (Variant: Standard, Rapid). The Variant row is always there
 * and a variant's own setting sits inside its button, so switching modes never
 * adds or removes a row and the lobby never shifts. Everything is built once
 * and only updated, so a dropdown keeps its focus while the server confirms.
 */
function modePicker(ctx: Ctx): { mode: HTMLElement; variant: HTMLElement; set(s: GameSettings, isHost: boolean): void } {
  // Switching back to a category returns to the variant last chosen in it.
  const lastVariant = new Map<ModeCategory, GameMode>();

  const catButtons = MODE_CATEGORIES.map((c) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false' }, c.label);
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-checked') === 'true') return;
      ctx.actions.setSettings({ mode: lastVariant.get(c) ?? (c.variants[0] as ModeVariant).mode });
    });
    return b;
  });
  const mode = h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 'mode-label' }, ...catButtons);

  const groups = MODE_CATEGORIES.map((cat) => {
    const opts = cat.variants.map((v) => {
      const btn = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false' }, v.label);
      btn.addEventListener('click', () => {
        if (btn.getAttribute('aria-checked') !== 'true') ctx.actions.setSettings({ mode: v.mode });
      });
      const opt = h('span', { class: 'seg-opt' }, btn);
      const setting = variantSetting(v.mode);
      let extra: { dot: HTMLElement; pick: HTMLElement; select: HTMLSelectElement; value: HTMLElement; setting: VariantSetting } | null = null;
      if (setting) {
        // A plain dropdown: phones open their own picker for it (a wheel on iPhone).
        const select = h(
          'select',
          { class: 'seg-select', 'aria-label': setting.label },
          ...setting.options.map((n) => h('option', { value: n }, `${n} s`)),
        );
        select.addEventListener('change', () => ctx.actions.setSettings({ [setting.key]: Number(select.value) }));
        const dot = h('span', { class: 'seg-dot', 'aria-hidden': 'true' }, '·');
        const pick = h('span', { class: 'seg-pick' }, select, h('span', { class: 'seg-caret', 'aria-hidden': 'true' }));
        const value = h('span', { class: 'seg-value' }); // what players other than the host see
        opt.append(dot, pick, value);
        extra = { dot, pick, select, value, setting };
      }
      return { mode: v.mode, btn, opt, extra };
    });
    const el = h('div', { class: 'seg seg-sub', role: 'radiogroup', 'aria-labelledby': 'variant-label' }, ...opts.map((o) => o.opt));
    return { cat, el, opts };
  });
  const variant = h(
    'div',
    { class: 'mode-sub' },
    h('span', { id: 'variant-label', class: 'seg-label sub-label' }, 'Variant'),
    h('div', null, ...groups.map((g) => g.el)),
  );

  return {
    mode,
    variant,
    set(s, isHost) {
      const current = categoryOf(s.mode);
      lastVariant.set(current, s.mode);
      catButtons.forEach((b, i) => {
        b.setAttribute('aria-checked', String(MODE_CATEGORIES[i] === current));
        b.disabled = !isHost;
      });
      for (const g of groups) {
        g.el.hidden = g.cat !== current;
        for (const o of g.opts) {
          const on = o.mode === s.mode;
          o.btn.setAttribute('aria-checked', String(on));
          o.btn.disabled = !isHost;
          o.opt.classList.toggle('on', on);
          o.opt.classList.toggle('has-setting', on && o.extra !== null);
          if (!o.extra) continue;
          const n = s[o.extra.setting.key];
          o.extra.dot.hidden = !on;
          o.extra.pick.hidden = !on || !isHost;
          o.extra.value.hidden = !on || isHost;
          o.extra.select.value = String(n);
          setText(o.extra.value, `${n} s`);
          o.extra.value.setAttribute('aria-label', `${o.extra.setting.label}: ${n} seconds`);
        }
      }
    },
  };
}

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
  // Each mode offers its own times (Grayscale: 10, 20 or 30 s), so the choices
  // are rebuilt whenever the mode changes.
  const secondsSel = h('select', { id: 'seconds' });
  let shownTimes = '';
  roundsSel.addEventListener('change', () => ctx.actions.setSettings({ rounds: Number(roundsSel.value) }));
  secondsSel.addEventListener('change', () => ctx.actions.setSettings({ roundSeconds: Number(secondsSel.value) }));
  const modes = modePicker(ctx);
  // Always two lines tall, whatever the mode, so the Start button never moves.
  const hint = h('p', { class: 'muted fine mode-hint' });
  const settings = h(
    'div',
    { class: 'settings' },
    h('span', { id: 'mode-label', class: 'seg-label' }, 'Mode'),
    modes.mode,
    modes.variant,
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
    hint,
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
      modes.set(r.settings, isHost);
      setText(hint, modeHint(r.settings));
      roundsSel.value = String(r.settings.rounds);
      const times = secondsOptions(r.settings.mode);
      if (times.join(',') !== shownTimes) {
        shownTimes = times.join(',');
        secondsSel.replaceChildren(...times.map((n) => h('option', { value: n }, formatSeconds(n))));
      }
      secondsSel.value = String(r.settings.roundSeconds);
      // Unlimited is solo-only (unavailable while anyone else is in the room),
      // and never in the rapid modes, whose speed bonus needs a deadline.
      const others = r.players.filter((p) => p.connected).length > 1;
      const unlimitedOption = secondsSel.querySelector<HTMLOptionElement>(`option[value="${UNLIMITED_SECONDS}"]`);
      if (unlimitedOption) unlimitedOption.disabled = others || isRapidMode(r.settings.mode);
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
// Grayscale modes: the stage
// ---------------------------------------------------------------------------

/**
 * Black and white references with the gray (or, on the result, the real gray
 * beside your answer) between them. The references sit apart from the gray, so
 * they anchor the scale without tinting it.
 */
function grayStage(middle: HTMLElement, caption: string): HTMLElement {
  const ref = (hex: string, label: string) => {
    const s = h('div', { class: 'gray-swatch gray-ref', role: 'img', 'aria-label': `${label}, reference` });
    s.style.backgroundColor = hex;
    return h('figure', null, s, h('figcaption', null, label));
  };
  return h(
    'div',
    { class: 'gray-stage' },
    ref(grayOf(0), '0 · black'),
    h('figure', null, middle, h('figcaption', null, caption)),
    ref(grayOf(100), '100 · white'),
  );
}

/** The result's middle square: the real gray on the left, your answer on the right. */
function grayPair(target: string, pick: string | null): HTMLElement {
  const real = h('div');
  real.style.backgroundColor = target;
  const yours = h('div', { class: pick ? '' : 'swatch-empty' });
  if (pick) yours.style.backgroundColor = pick;
  const label = pick ? `It was ${grayValue(target)}, you said ${grayValue(pick)}` : `It was ${grayValue(target)}, no answer`;
  return h('div', { class: 'gray-swatch gray-pair', role: 'img', 'aria-label': label }, real, yours);
}

/** "You said 40, it was 42: 2 too dark." */
function grayVerdict(pick: string, target: string): string {
  const said = grayValue(pick);
  const was = grayValue(target);
  const off = said - was;
  return off === 0 ? `You said ${said}, it was ${was}: exactly right.` : `You said ${said}, it was ${was}: ${Math.abs(off)} too ${off < 0 ? 'dark' : 'light'}.`;
}

// ---------------------------------------------------------------------------
// "Get ready" countdown
// ---------------------------------------------------------------------------

export function countdownView(ctx: Ctx): View {
  const number = h('div', { class: 'big-number', 'aria-hidden': 'true' }, '3');
  const challenge = ctx.model.room?.challenge;
  const el = h(
    'section',
    { class: 'card center' },
    challenge && h('p', { class: 'muted challenge-kicker' }, `Weekly challenge · Week ${challenge.number}`),
    h('h2', null, 'Get ready!'),
    number,
    h('p', { class: 'muted' }, 'The first color appears when the countdown ends.'),
    quitLink(ctx),
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
  // Memory mode: the color shows until hideAt, then static until unlockAt, then
  // the player picks from memory. Classic: both are null and picking starts now.
  const memory = round.unlockAt !== null;
  const hideAt = round.hideAt ?? 0;
  const unlockAt = round.unlockAt ?? 0;
  const watchMs = ctx.model.room!.settings.memorizeSeconds * 1000;
  // Rapid modes: a speed bonus that shrinks as the round goes on, and a shot clock.
  const rapid = isRapidMode(ctx.model.room!.settings.mode);
  // Grayscale modes: the answer is a number on a slider instead of a color.
  const gray = isGrayMode(ctx.model.room!.settings.mode);
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

  // Memory mode keeps the picker locked until the color has been hidden.
  let unlocked = !memory;
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
    if (locked || !unlocked) return;
    touched = true;
    setCurrent((e as CustomEvent<{ value: string }>).detail.value);
  });
  const markTouched = () => {
    if (unlocked) touched = true;
  };
  picker.addEventListener('pointerdown', markTouched);
  picker.addEventListener('keydown', markTouched);
  hexInput.addEventListener('input', () => {
    const hex = normalizeHex(hexInput.value);
    if (hex && !locked && unlocked) {
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
  const announce = h('p', { class: 'sr-only', role: 'status' });

  // Rapid: the bonus still on offer, in the header. When someone locks in, it
  // turns amber for a moment and says who; the colors are never covered and
  // the header never changes height.
  const chip = rapid ? h('span', { class: 'bonus-chip', title: 'Lock in sooner for more points' }) : null;
  let lockedPct: number | null = null; // the bonus when you locked in (unknown after a reconnect)
  let alertUntil = 0;
  let shotShown = false;
  const bonusPct = (t: number) =>
    Math.round(RAPID_MAX_BONUS * 100 * Math.max(0, Math.min(1, 1 - (t - round.startedAt) / totalMs)));
  const showShot = (shot: { by: string; shortened: boolean }) => {
    if (!chip) return;
    const rm = ctx.model.room!;
    // Seconds left for the others now (the shot clock halved it: 5 to 10 s).
    const n = seconds(((ctx.model.round ?? round).endsAt ?? ctx.now()) - ctx.now());
    let parts: (string | { name: string })[];
    let spoken: string;
    if (shot.by === rm.youId) {
      if (!shot.shortened) return; // nobody was hurried
      const others = rm.players.filter((p) => p.connected && p.id !== rm.youId);
      const only = others.length === 1 ? (others[0] as PlayerInfo) : null;
      parts = only ? [{ name: only.name }, ` has ${n} s`] : [`Others have ${n} s`];
      spoken = only
        ? `You locked in first. ${only.name} has ${n} seconds left.`
        : `You locked in first. The others have ${n} seconds left.`;
    } else {
      const name = rm.players.find((p) => p.id === shot.by)?.name ?? 'Someone';
      parts = [{ name }, ' locked in'];
      spoken = shot.shortened ? `${name} locked in. ${n} seconds left.` : `${name} locked in.`;
    }
    // A long name is cut short with "…"; the words after it always stay whole.
    chip.replaceChildren(
      ...parts.map((p) =>
        typeof p === 'string' ? h('span', { class: 'chip-text' }, p) : h('span', { class: 'chip-name', title: p.name }, p.name),
      ),
    );
    chip.classList.remove('done', 'alert');
    void chip.offsetWidth; // restart the pop animation
    chip.classList.add('alert');
    alertUntil = ctx.now() + 3000;
    setText(announce, spoken);
  };

  // ---- the stage ----
  // Classic: target and your color side by side. Memory: while watching (and
  // during the static) one wide color is laid over the two squares, which stay
  // in place but invisible, so the stage is the same height in every phase and
  // nothing below it ever moves. Then the target square shows a "?".
  const targetCaption = h('figcaption', null, memory ? 'From memory' : 'Match this');
  const targetSlot = memory
    ? h('div', { class: 'swatch memory-hidden', role: 'img', 'aria-label': 'Target color: hidden' }, h('span', { 'aria-hidden': 'true' }, '?'))
    : swatch(round.color, 'Target color', 'target');
  const stage = h(
    'div',
    { class: 'stage' },
    h('figure', null, targetSlot, targetCaption),
    h('figure', null, mine, h('figcaption', null, 'Your color')),
  );
  const wideCaption = h('figcaption', null, 'Watch carefully');
  const wide = h('figure', { class: 'memory-wide' });
  // In memory mode the hex code never goes into the page, not even for screen readers.
  const shown = round.color ? swatch(round.color, 'Target color') : null;
  shown?.setAttribute('aria-label', 'Target color: watch carefully');
  const noise = h('div', { class: 'swatch memory-noise', 'aria-hidden': 'true' });

  // ---- grayscale modes: judge the gray with a slider ----
  // A plain 0-100 slider: no gradient on it, which would turn judging into
  // matching. It starts in the middle but counts as no answer (and Lock in stays
  // off) until the player moves it, so leaving it alone never earns a free 50.
  // Its answer travels as the gray it stands for, like any other pick.
  const grayTarget = h('div', { class: 'gray-swatch gray-target', role: 'img', 'aria-label': 'The gray to judge' });
  if (round.color) grayTarget.style.backgroundColor = round.color;
  const grayReadout = h('span', { class: 'num' }, round.youPick ? String(grayValue(round.youPick)) : '–');
  const grayRange = h('input', {
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    value: round.youPick ? grayValue(round.youPick) : 50,
    class: 'gray-range',
    'aria-label': 'How light is the gray, from 0 black to 100 white',
  });
  grayRange.addEventListener('input', () => {
    if (locked) return;
    touched = true;
    submitBtn.disabled = false;
    setText(grayReadout, grayRange.value);
    setCurrent(grayOf(Number(grayRange.value)));
  });
  const grayAnswer = h(
    'div',
    { class: 'gray-answer' },
    h('div', { class: 'gray-readout' }, h('span', { class: 'muted' }, 'Your estimate (0–100)'), grayReadout),
    grayRange,
    h('div', { class: 'gray-ends muted', 'aria-hidden': 'true' }, h('span', null, '0 black'), h('span', null, 'white 100')),
  );

  const lock = () => {
    locked = true;
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = null;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Locked in ✓';
    picker.setAttribute('inert', '');
    hexInput.disabled = true;
    grayRange.disabled = true;
    if (round.youPick) {
      setCurrent(round.youPick);
      grayRange.value = String(grayValue(round.youPick));
      setText(grayReadout, grayRange.value);
    }
  };
  const submit = () => {
    if (locked || !unlocked || (gray && !touched)) return;
    if (ctx.actions.pick(current)) {
      if (rapid) lockedPct = bonusPct(ctx.now());
      lock();
    }
  };
  submitBtn.addEventListener('click', submit);

  const el = h(
    'section',
    { class: `card play${memory ? ' memory' : ''}` },
    h(
      'div',
      { class: 'play-head' },
      h('h2', null, `Round ${round.index + 1} of ${round.total}`),
      chip,
      timeLabel,
    ),
    h('div', { class: 'timer', 'aria-hidden': 'true', hidden: unlimited && !memory }, bar),
    ...(gray
      ? [grayStage(grayTarget, 'How light is it?'), grayAnswer]
      : [stage, picker, h('div', { class: 'row center' }, h('label', { for: 'hex', class: 'muted' }, 'Hex'), hexInput)]),
    submitBtn,
    progress,
    quitLink(ctx),
    announce,
  );
  hexInput.id = 'hex';
  if (gray && !touched) submitBtn.disabled = true; // nothing to lock in yet

  // ---- memory phases ----
  type Phase = 'watch' | 'static' | 'pick';
  let phase: Phase | null = null;
  const enter = (next: Phase) => {
    if (phase === next) return;
    phase = next;
    el.dataset.phase = next;
    if (next === 'watch' && shown) {
      wide.replaceChildren(shown, wideCaption);
      stage.append(wide);
      setText(announce, 'Watch the color carefully. It will be hidden in a moment.');
    } else if (next === 'static' || (next === 'watch' && !shown)) {
      setText(wideCaption, '…');
      wide.replaceChildren(noise, wideCaption);
      stage.append(wide);
    } else if (next === 'pick') {
      wide.remove();
      unlocked = true;
      if (!locked) {
        picker.removeAttribute('inert');
        hexInput.disabled = false;
        submitBtn.disabled = false;
        setText(submitBtn, 'Lock in');
      }
      if (memory) setText(announce, 'The color is hidden. Pick it from memory.');
    }
  };
  if (memory) {
    picker.setAttribute('inert', '');
    hexInput.disabled = true;
    submitBtn.disabled = true;
  }
  if (locked) lock();

  const view: View = {
    el,
    update() {
      const r = ctx.model.round;
      if (!r) return;
      setText(progress, `${r.submitted} of ${r.expected} locked in`);
      if (r.shot && !shotShown) {
        shotShown = true;
        showShot(r.shot);
      }
      el.classList.toggle('shot', r.shot?.shortened === true);
      if (r.youPick && !locked) {
        round.youPick = r.youPick;
        lock();
      }
      queueDraft(); // after a reconnect: resend the draft if the last one never got through
    },
    tick() {
      const now = ctx.now();
      if (chip && now >= alertUntil) {
        chip.classList.remove('alert');
        chip.classList.toggle('done', locked);
        setText(chip, locked ? (lockedPct === null ? 'Locked in' : `Locked · +${lockedPct}%`) : `Bonus +${bonusPct(now)}%`);
      }
      if (memory && now < unlockAt) {
        if (now < hideAt && shown) {
          enter('watch');
          const left = hideAt - now;
          bar.style.transform = `scaleX(${Math.min(1, left / watchMs).toFixed(3)})`;
          setText(timeLabel, String(seconds(left)));
        } else {
          enter('static');
          bar.style.transform = 'scaleX(1)';
          setText(timeLabel, unlimited ? 'No time limit' : formatClock(seconds(totalMs)));
        }
        if (!locked) setText(submitBtn, `Picker unlocks in ${seconds(unlockAt - now)}`);
        return;
      }
      if (memory) enter('pick');
      // Read live: Rapid's shot clock can move the deadline mid-round.
      const endsAt = (ctx.model.round ?? round).endsAt;
      if (endsAt === null) {
        // No deadline: nothing to count down.
        if (memory) {
          bar.style.transform = 'scaleX(1)';
          setText(timeLabel, 'No time limit');
        }
        return;
      }
      const remaining = endsAt - now;
      // The bar moves by transform (cheap); text and class change only when their value does.
      const fraction = Math.max(0, Math.min(1, remaining / totalMs));
      bar.style.transform = `scaleX(${fraction.toFixed(3)})`;
      setText(timeLabel, formatClock(seconds(remaining)));
      const urgent = remaining < 5000;
      if (urgent !== el.classList.contains('urgent')) el.classList.toggle('urgent', urgent);
      // Just before time runs out: lock in the chosen color. In Rapid, only make
      // sure the server has it: a color used at the buzzer earns no speed bonus,
      // so it must not turn into a lock-in.
      if (!locked && touched && remaining <= 400) {
        if (!rapid) submit();
        else if (current !== lastDraft) {
          if (draftTimer) clearTimeout(draftTimer);
          flushDraft();
        }
      }
    },
  };
  view.update?.();
  view.tick?.();
  return view;
}

// ---------------------------------------------------------------------------
// Round result
// ---------------------------------------------------------------------------

/**
 * `withTime`: the final ranking also shows each player's average time to lock in (it breaks ties).
 * `gray`: a grayscale mode, whose average error is "off by" on the 0-100 scale rather than ΔE.
 */
function standingsTable(rows: Standing[], youId: string, withAvg: boolean, withTime = false, gray = false): HTMLElement {
  const table = h(
    'table',
    { class: 'table' },
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', null, '#'),
        h('th', null, 'Player'),
        withAvg &&
          (gray
            ? h('th', { title: 'Average difference on the 0 to 100 scale (lower is better)' }, 'Avg off')
            : h('th', { title: 'Average color distance (lower is better)' }, 'Avg ΔE')),
        withTime && h('th', { title: 'Average time to lock in, over the rounds locked in. Breaks ties.' }, 'Avg time'),
        h('th', null, 'Points'),
      ),
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
        // `?? null`: a server older than this page sends no time.
        withTime && h('td', null, (s.avgTimeMs ?? null) === null ? '–' : pickTime(s.avgTimeMs as number)),
        h('td', { class: 'num' }, s.total),
      ),
    );
  }
  table.append(body);
  return table;
}

export function revealView(ctx: Ctx): View {
  const rv = ctx.model.reveal!;
  const room = ctx.model.room!;
  const youId = room.youId;
  const mine = rv.results.find((r) => r.id === youId);
  const isLast = rv.index >= rv.total - 1;
  const memory = isMemoryMode(room.settings.mode);
  const rapid = isRapidMode(room.settings.mode);
  const gray = isGrayMode(room.settings.mode);
  const revealMs = Math.max(1, rv.nextAt - rv.serverNow);
  const secs = (ms: number | null) => ((ms ?? 0) / 1000).toFixed(1);

  // Rapid: where the points came from.
  let bonusLine = '';
  if (rapid) {
    if (!mine || mine.deltaE === null) bonusLine = 'Lock in a color to score. The sooner, the bigger the bonus.';
    else if (!mine.lockedIn) bonusLine = `${mine.score} for the color · no speed bonus (time ran out before you locked in)`;
    else bonusLine = `${mine.score - mine.bonus} for the color + ${mine.bonus} speed bonus (locked in at ${secs(mine.timeMs)} s)`;
  }

  const headline =
    mine && mine.deltaE !== null
      ? `${matchLabel(mine.deltaE)}  ·  ${gray ? `off by ${mine.deltaE}` : `ΔE ${mine.deltaE.toFixed(1)}`}  ·  +${mine.score} points`
      : `No ${gray ? 'answer' : 'pick'} this round  ·  +0 points`;

  const countdown = h('p', { class: 'muted center', role: 'status' });
  const timeLabel = h('span', { class: 'time-label', 'aria-hidden': 'true' });
  const bar = h('div', { class: 'timer-fill' });
  const roundList = h('ol', { class: rapid ? 'round-results rapid' : 'round-results' });
  for (const r of rv.results) {
    roundList.append(
      h(
        'li',
        { class: r.id === youId ? 'me' : '' },
        swatch(r.pick, `${r.name}'s pick`, 'mini'),
        h('span', { class: 'name' }, r.name),
        h(
          'span',
          { class: 'muted' },
          r.deltaE === null
            ? 'missed'
            : (gray ? `off by ${r.deltaE}` : `ΔE ${r.deltaE.toFixed(1)}`) +
                (rapid ? ` · ${r.lockedIn ? `${secs(r.timeMs)} s` : 'at the buzzer'}` : ''),
        ),
        rapid && r.deltaE !== null && h('span', { class: 'split', title: 'Points for the color + speed bonus' }, `${r.score - r.bonus} + ${r.bonus}`),
        h('span', { class: 'num' }, `+${r.score}`),
      ),
    );
  }

  // Alone in the room: no need to wait for anyone, so the pause can be skipped.
  const solo = room.players.filter((p) => p.connected).length === 1;
  const skipBtn = h('button', { class: 'btn primary big', type: 'button', hidden: !solo }, isLast ? 'Final results' : 'Next round');
  skipBtn.addEventListener('click', () => {
    skipBtn.disabled = true;
    ctx.actions.next();
  });

  // Same header, timer bar and stage position as the round itself, so the
  // result appears in the same place: the target (hidden in memory mode)
  // simply turns into the real color next to the pick.
  const el = h(
    'section',
    { class: 'card reveal' },
    h('div', { class: 'play-head' }, h('h2', null, `Round ${rv.index + 1} result`), timeLabel),
    h('div', { class: 'timer quiet', 'aria-hidden': 'true' }, bar),
    gray
      ? // Short enough to sit between "0 · black" and "100 · white" on a phone;
        // the numbers are in the sentence under the headline.
        grayStage(grayPair(rv.target, mine?.pick ?? null), mine?.pick ? 'Real · yours' : 'Real gray')
      : h(
          'div',
          { class: 'stage' },
          h('figure', null, swatch(rv.target, 'Target color', memory ? 'target reveal-in' : 'target'), h('figcaption', null, memory ? 'The color' : 'Target')),
          h('figure', null, swatch(mine?.pick ?? null, 'Your pick', 'target'), h('figcaption', null, 'Your pick')),
        ),
    h('p', { class: 'headline', role: 'status' }, headline),
    gray && mine?.pick && h('p', { class: 'muted gray-verdict' }, grayVerdict(mine.pick, rv.target)),
    rapid && h('p', { class: 'muted bonus-line' }, bonusLine),
    skipBtn,
    countdown,
    h('h3', null, 'This round'),
    roundList,
    h('h3', null, 'Standings'),
    standingsTable(rv.standings, youId, true, false, gray),
    quitLink(ctx),
  );

  return {
    el,
    update() {
      const alone = ctx.model.room?.players.filter((p) => p.connected).length === 1;
      skipBtn.hidden = !alone;
    },
    tick() {
      const left = rv.nextAt - ctx.now();
      const s = seconds(left);
      bar.style.transform = `scaleX(${Math.max(0, Math.min(1, left / revealMs)).toFixed(3)})`;
      setText(timeLabel, String(s));
      setText(countdown, `${isLast ? 'Final results' : 'Next round'} in ${s}s`);
    },
  };
}

// ---------------------------------------------------------------------------
// Quit: a quiet link under the countdown, every round and every round result
// (all modes). It asks first, so a stray tap never ends a game.
// ---------------------------------------------------------------------------

function quitLink(ctx: Ctx): HTMLElement {
  const btn = h('button', { class: 'btn link quit-link', type: 'button' }, 'Quit game');
  btn.addEventListener('click', () => {
    const room = ctx.model.room;
    const others = room ? room.players.filter((p) => p.connected && p.id !== room.youId).length : 0;
    const yes = h('button', { class: 'btn primary', type: 'button' }, 'Quit');
    const no = h('button', { class: 'btn', type: 'button' }, 'Keep playing');
    const dialog = h(
      'dialog',
      { class: 'quit-dialog', 'aria-labelledby': 'quit-title' },
      h('h3', { id: 'quit-title' }, 'Quit this game?'),
      h(
        'p',
        { class: 'muted' },
        // A challenge counts from the first color: quitting uses up this week's try.
        room?.challenge && ctx.model.round
          ? 'Your points so far count, and this week’s try is used up. You can’t play this week’s challenge again.'
          : room?.challenge
            ? 'Nothing has counted yet: you can still play this week’s challenge later.'
            : others === 0
              ? 'The game ends here and you go back to the start screen.'
              : 'You’ll leave the room and go back to the start screen. The others keep playing without you.',
      ),
      h('div', { class: 'quit-actions' }, no, yes),
    );
    no.addEventListener('click', () => dialog.close());
    yes.addEventListener('click', () => {
      dialog.close();
      ctx.actions.leave();
    });
    dialog.addEventListener('close', () => dialog.remove());
    // Inside the view, so it disappears with it if the screen changes meanwhile.
    btn.after(dialog);
    dialog.showModal();
    no.focus(); // the safe choice has focus, so Enter does not quit by accident
  });
  return btn;
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

  // The screen's card, built below (the weekly challenge has its own). The
  // review opens inside it, so both kinds of results must set this one.
  let el: HTMLElement;

  // Your own rounds (pick, ΔE, score), for the "Review my rounds" sheet.
  const me = fin.standings.find((s) => s.id === room.youId);
  const rounds = fin.yourRounds ?? []; // missing from a server older than this client
  const review =
    me && rounds.length > 0
      ? (startAt?: number) =>
          openReview(
            {
              player: me.name,
              total: me.total,
              avgDeltaE: me.avgDeltaE,
              date: new Date(),
              rounds,
              settings: room.settings,
              // A weekly challenge says so in its review and saved image.
              title: room.challenge ? `Weekly challenge · Week ${room.challenge.number}` : undefined,
            },
            el,
            startAt,
          )
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

  const statsLink = h('a', { class: 'btn link', href: `${statsPath(room.settings.mode)}${profileQuery()}` }, 'See my stats');

  // Weekly challenge: your points and your place this week, then the leaderboard.
  if (room.challenge) {
    const place = fin.challenge ?? null;
    const home = h('button', { class: 'btn link', type: 'button' }, 'Back to the start');
    home.addEventListener('click', () => ctx.actions.leave());
    const avg = me?.avgDeltaE ?? null;
    el = h(
      'section',
      { class: 'card final challenge-final' },
      h('p', { class: 'muted challenge-kicker' }, `Weekly challenge · Week ${room.challenge.number}`),
      h('h2', null, 'Your result'),
      h('p', { class: 'challenge-score' }, h('span', { class: 'num' }, me?.total ?? 0), ' points'),
      place && h('p', { class: 'challenge-rank' }, `#${place.rank} of ${place.players} this week`),
      h(
        'p',
        { class: 'muted center' },
        [avg === null ? null : `Avg ${isGrayMode(room.settings.mode) ? 'off by' : 'ΔE'} ${avg.toFixed(1)}`, me?.avgTimeMs ? `avg time ${pickTime(me.avgTimeMs)}` : null]
          .filter(Boolean)
          .join(' · '),
      ),
      h('a', { class: 'btn primary big board-link', href: `/challenge${profileQuery()}` }, 'See the leaderboard'),
      h('h3', null, 'The colors'),
      strip,
      reviewBtn,
      statsLink,
      home,
    );
    return { el };
  }

  const againBtn = h('button', { class: 'btn primary big', type: 'button' }, 'Play again');
  againBtn.addEventListener('click', () => ctx.actions.again());
  const leaveBtn = h('button', { class: 'btn link', type: 'button' }, 'Leave room');
  leaveBtn.addEventListener('click', () => ctx.actions.leave());

  el = h(
    'section',
    { class: 'card final' },
    h('h2', null, 'Final results'),
    podium,
    standingsTable(fin.standings, room.youId, true, true, isGrayMode(room.settings.mode)),
    h('h3', null, 'The colors'),
    strip,
    reviewBtn,
    isHost ? againBtn : h('p', { class: 'muted center' }, 'Waiting for the host to start another game…'),
    // Straight to the analysis page of the mode just played.
    statsLink,
    leaveBtn,
  );
  return { el };
}

export function syncView(): View {
  return { el: h('section', { class: 'card center' }, h('p', { class: 'muted', role: 'status' }, 'Syncing with the game…')) };
}
