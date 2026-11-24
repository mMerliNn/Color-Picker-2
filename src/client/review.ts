// "Review my rounds": a sheet over the final results showing, for every round,
// the target next to the player's pick and three mini sliders (hue, saturation,
// brightness) with a target tick and the pick's dot on top of it, plus a summary tip
// for the whole game. "Save as image" draws the same content on a canvas.
//
// The numbers come from src/shared/review.ts; this file only draws them.

import { matchLabel } from '../shared/labels.js';
import { categoryOf, isMemoryMode, isRapidMode, type GameSettings, type RoundReview } from '../shared/protocol.js';
import { reviewNotes, summaryTip, type ReviewBar, type ReviewNote } from '../shared/review.js';
import { h } from './dom.js';

/**
 * A round as the review shows it. Time, lock-in and bonus may be missing (a
 * server older than this page, mid-deploy); the review then just shows no times.
 */
type TimeFields = 'timeMs' | 'lockedIn' | 'bonus';
export type ReviewRound = Omit<RoundReview, TimeFields> & Partial<Pick<RoundReview, TimeFields>>;

export interface ReviewData {
  player: string;
  total: number;
  avgDeltaE: number | null;
  date: Date;
  rounds: readonly ReviewRound[];
  /** The game's mode and settings: the title ("Classic · Rapid") and the line under it. */
  settings?: GameSettings;
}

const LEGEND = 'Swatch: left = target, right = your pick';
const dateText = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** "6.3 s", or "2:14" once a pick took a minute or more (unlimited games). */
export function pickTime(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Average time of the rounds with a locked-in pick, or null when there were none (or no times). */
function avgTimeMs(rounds: readonly ReviewRound[]): number | null {
  const times = rounds.filter((r) => r.pick !== null && r.lockedIn !== false && typeof r.timeMs === 'number');
  return times.length ? times.reduce((sum, r) => sum + (r.timeMs as number), 0) / times.length : null;
}

const statsText = (d: ReviewData) => {
  const avg = avgTimeMs(d.rounds);
  return `${d.player} · ${d.total} pts · avg ΔE ${d.avgDeltaE === null ? '–' : d.avgDeltaE.toFixed(1)}${avg === null ? '' : ` · avg ${pickTime(avg)}`}`;
};

/** "Classic · Rapid": named as in the lobby (category, then variant). */
export function modeTitle(s: GameSettings): string {
  const cat = categoryOf(s.mode);
  const variant = cat.variants.find((v) => v.mode === s.mode);
  return `${cat.label} · ${variant?.label ?? ''}`;
}

/** "5 rounds · 20 s per round · color shown 3 s" */
export function setupText(s: GameSettings): string {
  const time =
    s.roundSeconds === 0 ? 'no time limit' : s.roundSeconds >= 60 ? `${s.roundSeconds / 60} min per round` : `${s.roundSeconds} s per round`;
  return [`${s.rounds} rounds`, time, isMemoryMode(s.mode) ? `color shown ${s.memorizeSeconds} s` : null].filter(Boolean).join(' · ');
}

/** "ΔE 4.2 · 6.3 s", "ΔE 4.2 · time ran out", or just "ΔE 4.2" without a time. */
function detailText(r: ReviewRound): string {
  if (r.pick === null) return '—';
  const dE = `ΔE ${(r.deltaE as number).toFixed(1)}`;
  if (r.lockedIn === false) return `${dE} · time ran out`;
  return typeof r.timeMs === 'number' ? `${dE} · ${pickTime(r.timeMs)}` : dE;
}

/** Rapid modes: "+31 bonus" (already in the points), or "no bonus" when time ran out. Null elsewhere, and for a miss. */
function bonusText(r: ReviewRound, rapid: boolean): string | null {
  if (!rapid || r.pick === null) return null;
  if (r.lockedIn === false) return 'no bonus';
  return `+${r.bonus ?? 0} bonus`;
}

// ---------------------------------------------------------------------------
// The sheet (HTML)
// ---------------------------------------------------------------------------

/**
 * "Name · pts · avg ΔE · date". The date never breaks in the middle: if it
 * does not fit, the whole date moves to its own line and its "·" is hidden.
 */
function metaEl(d: ReviewData): HTMLElement {
  const stats = h('span', null, statsText(d));
  // The breakable space sits outside the date, so the line can wrap there.
  const date = h('span', { class: 'rv-date' }, h('span', { class: 'rv-sep' }, '· '), dateText(d.date));
  const el = h('p', { class: 'muted rv-meta' }, stats, ' ', date);
  const check = () => {
    const lines = stats.getClientRects();
    const last = lines[lines.length - 1];
    // Measure with the separator shown, as it would be if everything fits on one line.
    el.classList.remove('wrapped');
    const onNewLine = !!last && date.getBoundingClientRect().top > last.top + 1;
    el.classList.toggle('wrapped', onNewLine);
  };
  new ResizeObserver(check).observe(el);
  return el;
}

function tipEl(d: ReviewData): HTMLElement | null {
  const tip = summaryTip(d.rounds);
  if (!tip) return null;
  return h('p', { class: 'rv-tip' }, h('strong', { class: 'rv-tip-label' }, 'Tip'), h('span', null, tip));
}

function legendEl(): HTMLElement {
  return h(
    'div',
    { class: 'rv-legend muted' },
    h('span', null, LEGEND),
    h('span', { class: 'rv-key' }, 'Bars:', h('i', { class: 'k-tick' }), 'target', h('i', { class: 'k-dot' }), 'your pick'),
  );
}

function pairEl(r: ReviewRound): HTMLElement {
  const label = r.pick ? `Target ${r.target}, your pick ${r.pick}` : `Target ${r.target}, no pick`;
  const left = h('span');
  left.style.backgroundColor = r.target;
  const right = h('span', { class: r.pick ? '' : 'swatch-empty' });
  if (r.pick) right.style.backgroundColor = r.pick;
  return h('div', { class: 'rv-pair', role: 'img', 'aria-label': label }, left, right);
}

function barEl(n: ReviewNote, pick: string): HTMLElement {
  const b = n.bar;
  const el = h('div', {
    class: `rv-bar${b.faded ? ' faded' : ''}`,
    role: 'img',
    'aria-label': b.faded ? `${n.label}: not relevant (near gray)` : `${n.label}: ${n.good ? 'good' : `your pick ${n.text}`}`,
  });
  el.style.background = `linear-gradient(to right, ${b.stops.join(', ')})`;
  if (!b.faded) {
    // The target tick first, so the pick dot sits on top of it.
    const tick = h('span', { class: 'rv-tick' });
    tick.style.left = pct(b.target);
    const dot = h('span', { class: 'rv-dot' });
    dot.style.left = pct(b.pick);
    dot.style.backgroundColor = pick;
    el.append(tick, dot);
  }
  return el;
}

function rowEl(r: ReviewRound, index: number, rapid: boolean): HTMLElement {
  const missed = r.pick === null;
  const verdict = missed ? 'No pick' : matchLabel(r.deltaE as number);
  const bonus = bonusText(r, rapid);
  return h(
    'li',
    { class: `rv-row${missed ? ' missed' : ''}` },
    pairEl(r),
    h(
      'div',
      { class: 'rv-main' },
      h('div', { class: 'rv-title' }, h('strong', null, `Round ${index + 1}`), h('span', { class: 'muted rv-verdict' }, ` · ${verdict}`)),
      h('div', { class: 'rv-hex' }, missed ? `Target ${r.target}` : `${r.target} → ${r.pick}`),
      // ΔE and time under the name, where there is room; the points column stays narrow.
      !missed && h('div', { class: 'muted rv-detail' }, detailText(r)),
    ),
    h(
      'div',
      { class: 'rv-score' },
      h('div', null, h('span', { class: 'num' }, r.score), ' pts'),
      bonus && h('div', { class: 'muted' }, bonus),
    ),
    !missed &&
      h(
        'div',
        { class: 'rv-notes' },
        ...reviewNotes(r.target, r.pick as string).map((n) =>
          h('div', { class: 'rv-note' }, h('span', { class: 'rv-label' }, n.label), barEl(n, r.pick as string)),
        ),
      ),
  );
}

/** The review card. `onClose` runs for the × button and "Back to results". */
export function reviewSheet(d: ReviewData, onClose: () => void): HTMLElement {
  const saveBtn = h('button', { class: 'btn primary big', type: 'button' }, 'Save as image');
  saveBtn.addEventListener('click', () => void saveReviewImage(d, saveBtn));
  const closeBtn = h('button', { class: 'rv-close', type: 'button', 'aria-label': 'Close' }, '×');
  closeBtn.addEventListener('click', onClose);
  const backBtn = h('button', { class: 'btn link', type: 'button' }, 'Back to results');
  backBtn.addEventListener('click', onClose);
  const rapid = d.settings ? isRapidMode(d.settings.mode) : false;
  // With the mode known: "Your rounds" becomes a small heading over the mode's
  // name, with the game's setup under it.
  const title = d.settings
    ? h('div', { class: 'rv-heading' }, h('span', { class: 'rv-kicker' }, 'Your rounds'), h('h2', { id: 'rv-title' }, modeTitle(d.settings)))
    : h('h2', { id: 'rv-title' }, 'Your rounds');
  const list = h('ol', { class: 'rv-list' }, ...d.rounds.map((r, i) => rowEl(r, i, rapid)));
  // On a very narrow phone the verdicts ("· Good") are dropped rather than cut
  // to "· Go…": all of them, as soon as one does not fit, so the rows stay
  // alike. ΔE right under it says the same thing more precisely.
  const fitVerdicts = () => {
    list.classList.remove('no-verdict');
    const tooLong = [...list.querySelectorAll<HTMLElement>('.rv-title')].some((t) => t.scrollWidth > t.clientWidth);
    list.classList.toggle('no-verdict', tooLong);
  };
  new ResizeObserver(fitVerdicts).observe(list);
  return h(
    'section',
    { class: 'card review' },
    h('div', { class: 'rv-head' }, title, closeBtn),
    d.settings && h('p', { class: 'muted rv-setup' }, setupText(d.settings)),
    metaEl(d),
    tipEl(d),
    legendEl(),
    list,
    saveBtn,
    backBtn,
  );
}

/**
 * Open the review over the page as a modal dialog, scrolled to round `startAt`.
 * It lives inside `host` (the final results view), so when that view is replaced
 * (the host starts another game) the dialog goes with it.
 */
export function openReview(d: ReviewData, host: HTMLElement, startAt?: number): void {
  const dialog = h('dialog', { class: 'review-dialog', 'aria-labelledby': 'rv-title' });
  const close = () => dialog.close();
  dialog.append(reviewSheet(d, close));
  dialog.addEventListener('close', () => dialog.remove());
  // A tap on the dimmed backdrop (outside the card) closes it, like Esc does.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  host.append(dialog);
  dialog.showModal();
  if (startAt !== undefined && startAt > 0) {
    dialog.querySelectorAll('.rv-row')[startAt]?.scrollIntoView({ block: 'start' });
  }
}

// ---------------------------------------------------------------------------
// Save as image: the same content drawn on a canvas. Always the light theme,
// since the image is shared and viewed outside the app.
// ---------------------------------------------------------------------------

const W = 420;
const PAD = 20;
const SCALE = 3;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Consolas, Menlo, monospace';
const C = { bg: '#ffffff', text: '#17171c', muted: '#6b6b76', border: '#dcdce2', accent: '#4338ca', tipBg: '#e8e7fb' };

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function drawSwatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hgt: number, color: string | null): void {
  if (color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, hgt);
    return;
  }
  // Striped "no pick" fill, like .swatch-empty in the app.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, hgt);
  ctx.clip();
  ctx.fillStyle = '#6e6e6e';
  ctx.fillRect(x, y, w, hgt);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 5;
  for (let i = -hgt; i < w + hgt; i += 11) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + hgt);
    ctx.lineTo(x + i + hgt, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Pick mark: a dot filled with the picked color, white ring, dark outline. */
function drawDot(ctx: CanvasRenderingContext2D, x: number, cy: number, color: string): void {
  ctx.beginPath();
  ctx.arc(x, cy, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, cy, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, cy, 3.8, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * Target tick: a white bar at x with a solid dark outline, from `top` to
 * `bottom`, matching .rv-tick in the sheet. Drawn before the pick dot, so the
 * dot sits on top of it.
 */
function drawTick(ctx: CanvasRenderingContext2D, x: number, top: number, bottom: number): void {
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(x - 2, top - 1, 4, bottom - top + 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x - 1, top, 2, bottom - top);
}

function drawBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hgt: number, b: ReviewBar, pick: string): void {
  const grad = ctx.createLinearGradient(x, 0, x + w, 0);
  b.stops.forEach((c, i) => grad.addColorStop(i / (b.stops.length - 1), c));
  ctx.save();
  if (b.faded) ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.roundRect(x, y, w, hgt, 3);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
  if (b.faded) return;
  drawTick(ctx, x + w * b.target, y - 4, y + hgt + 4);
  drawDot(ctx, x + w * b.pick, y + hgt / 2, pick);
}

/** Lays out (and, when `draw` is true, paints) the image. Returns its height. */
function paint(ctx: CanvasRenderingContext2D, d: ReviewData, draw: boolean): number {
  const contentW = W - PAD * 2;
  let y = PAD;
  const text = (s: string, x: number, yy: number, font: string, color: string, align: CanvasTextAlign = 'left') => {
    ctx.font = font;
    if (!draw) return;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(s, x, yy);
  };

  if (draw) {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, 99999);
  }
  ctx.textBaseline = 'alphabetic';

  // Header: the mode's name, then the game's setup (the image is shared outside
  // the game, where nobody knows which mode was played).
  text('COLOR MATCH', PAD, y + 11, `700 10.5px ${FONT}`, C.accent);
  y += 14;
  text(d.settings ? modeTitle(d.settings) : `Round review · ${d.rounds.length} rounds`, PAD, y + 22, `700 21px ${FONT}`, C.text);
  y += 30;
  if (d.settings) {
    text(setupText(d.settings), PAD, y + 14, `400 12.5px ${FONT}`, C.muted);
    y += 19;
  }
  // Same rule as the sheet: if it does not fit, the whole date goes on its own line.
  ctx.font = `400 12.5px ${FONT}`;
  const oneLine = `${statsText(d)} · ${dateText(d.date)}`;
  if (ctx.measureText(oneLine).width <= contentW) {
    text(oneLine, PAD, y + 14, `400 12.5px ${FONT}`, C.muted);
    y += 22;
  } else {
    text(statsText(d), PAD, y + 14, `400 12.5px ${FONT}`, C.muted);
    text(dateText(d.date), PAD, y + 31, `400 12.5px ${FONT}`, C.muted);
    y += 39;
  }

  // Tip box
  const tip = summaryTip(d.rounds);
  if (tip) {
    y += 4;
    const tipFont = `500 12.5px ${FONT}`;
    ctx.font = tipFont;
    const lines = wrap(ctx, tip, contentW - 24);
    const boxH = 12 + 13 + lines.length * 17 + 6;
    if (draw) {
      ctx.beginPath();
      ctx.roundRect(PAD, y, contentW, boxH, 9);
      ctx.fillStyle = C.tipBg;
      ctx.fill();
    }
    text('TIP', PAD + 12, y + 21, `700 9.5px ${FONT}`, C.accent);
    lines.forEach((ln, i) => text(ln, PAD + 12, y + 39 + i * 17, tipFont, C.text));
    y += boxH + 10;
  }

  // Legend
  text(LEGEND, PAD, y + 12.5, `400 11.5px ${FONT}`, C.muted);
  y += 18;
  ctx.font = `400 11.5px ${FONT}`;
  let lx = PAD;
  text('Bars:', lx, y + 12.5, `400 11.5px ${FONT}`, C.muted);
  lx += ctx.measureText('Bars:').width + 7;
  if (draw) drawTick(ctx, lx + 3, y + 1, y + 16);
  lx += 10;
  text('target', lx, y + 12.5, `400 11.5px ${FONT}`, C.muted);
  lx += ctx.measureText('target').width + 14;
  if (draw) drawDot(ctx, lx, y + 8.5, '#9a9aa3');
  lx += 10;
  text('your pick', lx, y + 12.5, `400 11.5px ${FONT}`, C.muted);
  y += 24;

  // Rounds
  const colW = contentW / 3;
  const rapid = d.settings ? isRapidMode(d.settings.mode) : false;
  d.rounds.forEach((r, index) => {
    if (draw) {
      ctx.fillStyle = C.border;
      ctx.fillRect(PAD, y, contentW, 1);
    }
    y += 12;
    const top = y;
    // Swatch pair: target left, pick right, sharing an edge (best for comparing).
    if (draw) {
      drawSwatch(ctx, PAD, top, 32, 44, r.target);
      drawSwatch(ctx, PAD + 32, top, 32, 44, r.pick);
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(PAD + 0.5, top + 0.5, 63, 43);
    }
    const tx = PAD + 76;
    const missed = r.pick === null;
    ctx.font = `700 15px ${FONT}`;
    const roundLabel = `Round ${index + 1}`;
    const rw = ctx.measureText(roundLabel).width;
    // Laid out like the sheet. Left: name and verdict, hex codes, then
    // "ΔE · time" (three lines beside the 44 px swatches; a miss has two).
    const [titleY, hexY] = missed ? [17, 37] : [13, 29];
    text(roundLabel, tx, top + titleY, `700 15px ${FONT}`, C.text);
    text(` · ${missed ? 'No pick' : matchLabel(r.deltaE as number)}`, tx + rw, top + titleY, `400 14px ${FONT}`, C.muted);
    text(missed ? `Target ${r.target}` : `${r.target} → ${r.pick}`, tx, top + hexY, `400 12px ${MONO}`, C.text);
    if (!missed) text(detailText(r), tx, top + 44, `400 11.5px ${FONT}`, C.muted);
    // Right, centred on the row: the points, and in the rapid modes the bonus under them.
    const bonus = bonusText(r, rapid);
    if (bonus) {
      text(`${r.score} pts`, W - PAD, top + 19, `700 15px ${FONT}`, C.text, 'right');
      text(bonus, W - PAD, top + 36, `400 12px ${FONT}`, C.muted, 'right');
    } else {
      text(`${r.score} pts`, W - PAD, top + 27, `700 15px ${FONT}`, C.text, 'right');
    }
    y = top + 44;

    if (!missed) {
      y += 14;
      reviewNotes(r.target, r.pick as string).forEach((n, i) => {
        const x = PAD + i * colW;
        text(n.label.toUpperCase(), x, y + 9, `700 9.5px ${FONT}`, C.muted);
        if (draw) drawBar(ctx, x, y + 16, colW - 14, 9, n.bar, r.pick as string);
      });
      y += 30;
    }
    y += 12;
  });

  if (draw) {
    ctx.fillStyle = C.border;
    ctx.fillRect(PAD, y, contentW, 1);
  }
  y += 10;
  text('Hue = slider · Saturation = left/right · Brightness = up/down', PAD, y + 12, `400 11px ${FONT}`, C.muted);
  y += 18 + PAD;
  return Math.ceil(y);
}

export function renderReviewCanvas(d: ReviewData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d') as CanvasRenderingContext2D;
  const height = paint(measure, d, false);
  canvas.width = W * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.scale(SCALE, SCALE);
  paint(ctx, d, true);
  return canvas;
}

async function saveReviewImage(d: ReviewData, btn: HTMLButtonElement): Promise<void> {
  const canvas = renderReviewCanvas(d);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) return;
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${d.date.getFullYear()}-${pad(d.date.getMonth() + 1)}-${pad(d.date.getDate())}`;
  const name = `color-match-${day}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  // Phones: the share sheet offers "Save image" straight to the photo library.
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Color Match round review' });
      return;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return; // the player closed the share sheet
      // Sharing failed for another reason: fall back to a download.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  const old = btn.textContent;
  btn.textContent = 'Saved ✓';
  setTimeout(() => (btn.textContent = old), 1500);
}
