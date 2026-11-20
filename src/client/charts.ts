// Small dependency-free chart builders for the stats page (plain HTML/SVG).
// Conventions: thin marks, one series colour, hairline recessive grid, a 4px
// rounded data end on bars, a surface ring on dots, values read as text too
// (aria-labels, tooltips, and a table view next to every chart).

import { clear, h, s } from './dom.js';

// ---- tooltip --------------------------------------------------------------

let tip: HTMLDivElement | null = null;

function tipEl(): HTMLDivElement {
  if (!tip) {
    tip = h('div', { class: 'viz-tip', role: 'tooltip', hidden: true });
    document.body.append(tip);
  }
  return tip;
}

function showTip(lines: string[], x: number, y: number): void {
  const t = tipEl();
  clear(t);
  lines.forEach((line, i) => t.append(h(i === 0 ? 'strong' : 'span', null, line)));
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const left = Math.max(8, Math.min(x - r.width / 2, window.innerWidth - r.width - 8));
  const top = y - r.height - 12 < 8 ? y + 18 : y - r.height - 12;
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
}

function hideTip(): void {
  if (tip) tip.hidden = true;
}

/** Tooltip on hover and keyboard focus; never the only way to read a value. */
export function attachTip(el: Element, lines: () => string[]): void {
  el.addEventListener('pointerenter', (e) => showTip(lines(), (e as PointerEvent).clientX, (e as PointerEvent).clientY));
  el.addEventListener('pointermove', (e) => showTip(lines(), (e as PointerEvent).clientX, (e as PointerEvent).clientY));
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect();
    showTip(lines(), r.left + r.width / 2, r.top);
  });
  el.addEventListener('blur', hideTip);
}

// ---- axes -----------------------------------------------------------------

/** A clean axis maximum and tick step for values from 0 to `maxValue`. */
export function niceAxis(maxValue: number, minMax = 10): { max: number; step: number } {
  const m = Math.max(minMax, maxValue);
  const step = m <= 12 ? 2 : m <= 30 ? 5 : m <= 60 ? 10 : 20;
  return { max: Math.ceil(m / step) * step, step };
}

export const fmt1 = (n: number): string => n.toFixed(1);
export const signed = (n: number, digits = 1): string =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}`;

// ---- horizontal bars --------------------------------------------------------

export interface BarRow {
  label: string;
  /** Decorative identity swatch (e.g. the hue being measured). Never encodes the value. */
  swatch?: string;
  value: number | null;
  /** Reference value drawn as a tick (e.g. everyone's average). */
  ref?: number | null;
  /** Too few samples: drawn faded and labelled as such. */
  low?: boolean;
  /** Optional fill override (used for ordinal ramps). */
  color?: string;
  tip: string[];
}

export function barChart(opts: { rows: BarRow[]; max: number; step: number; ariaLabel: string; refLabel?: string }): HTMLElement {
  const { rows, max, step } = opts;
  const root = h('div', { class: 'bars' });
  root.style.setProperty('--max', String(max));
  root.style.setProperty('--step', String(step));

  const hasRef = rows.some((r) => r.ref !== null && r.ref !== undefined);
  if (hasRef) {
    root.append(
      h(
        'div',
        { class: 'viz-legend' },
        h('span', null, h('i', { class: 'key key-bar' }), 'You'),
        h('span', null, h('i', { class: 'key key-ref' }), opts.refLabel ?? 'Everyone'),
      ),
    );
  }

  const axis = h('div', { class: 'bars-axis', 'aria-hidden': 'true' });
  const ticks = h('span', { class: 'bars-ticks' });
  for (let v = 0; v <= max; v += step) {
    const t = h('span', { class: 'tick' }, v);
    t.style.left = `${(v / max) * 100}%`;
    ticks.append(t);
  }
  axis.append(h('span'), ticks, h('span'));
  root.append(axis);

  const list = h('div', { class: 'bar-list', role: 'list', 'aria-label': opts.ariaLabel });
  for (const row of rows) {
    const fill = h('span', { class: `bar-fill${row.low ? ' low' : ''}` });
    if (row.value !== null) fill.style.width = `${Math.max(0, Math.min(100, (row.value / max) * 100))}%`;
    if (row.color) fill.style.setProperty('--bar', row.color);

    const track = h('span', { class: 'bar-track' }, row.value === null ? null : fill);
    if (row.ref !== null && row.ref !== undefined) {
      const refTick = h('span', { class: 'bar-ref' });
      refTick.style.left = `${Math.max(0, Math.min(100, (row.ref / max) * 100))}%`;
      track.append(refTick);
    }

    const label = h('span', { class: 'bar-label' });
    if (row.swatch) {
      const dot = h('i', { class: 'swatch-dot', 'aria-hidden': 'true' });
      dot.style.cssText = row.swatch;
      label.append(dot);
    }
    label.append(row.label);

    const item = h(
      'div',
      { class: 'bar-row', role: 'listitem', tabindex: '0', 'aria-label': `${row.label}. ${row.tip.join('. ')}` },
      label,
      track,
      h('span', { class: `bar-value${row.low ? ' low' : ''}` }, row.value === null ? '–' : fmt1(row.value)),
    );
    attachTip(item, () => [row.label, ...row.tip]);
    list.append(item);
  }
  root.append(list);
  return root;
}

// ---- diverging bars (polarity: below / above zero) -----------------------------

export interface DivergingRow {
  label: string;
  value: number | null;
  /** Bars span -range .. +range. */
  range: number;
  negWord: string;
  posWord: string;
  tip: string[];
}

export function divergingChart(rows: DivergingRow[], ariaLabel: string): HTMLElement {
  const root = h('div', { class: 'diverging', role: 'list', 'aria-label': ariaLabel });
  for (const row of rows) {
    const v = row.value;
    const track = h('span', { class: 'div-track' });
    track.append(h('span', { class: 'div-axis' }));
    if (v !== null) {
      const half = Math.min(1, Math.abs(v) / row.range) * 50;
      const fill = h('span', { class: `div-fill ${v < 0 ? 'neg' : 'pos'}` });
      fill.style.width = `${half}%`;
      track.append(fill);
    }
    const item = h(
      'div',
      { class: 'div-row', role: 'listitem', tabindex: '0', 'aria-label': `${row.label}. ${row.tip.join('. ')}` },
      h('span', { class: 'div-label' }, row.label),
      h(
        'span',
        { class: 'div-body' },
        track,
        h('span', { class: 'div-words', 'aria-hidden': 'true' }, h('span', null, `← ${row.negWord}`), h('span', null, `${row.posWord} →`)),
      ),
      h('span', { class: 'bar-value' }, v === null ? '–' : signed(v)),
    );
    attachTip(item, () => [row.label, ...row.tip]);
    root.append(item);
  }
  return root;
}

// ---- line chart (progress over time) ----------------------------------------------

export interface TrendPoint {
  label: string; // tooltip title
  value: number;
  detail: string;
}

export function trendChart(points: TrendPoint[], width: number, ariaLabel: string): SVGSVGElement {
  const W = Math.max(280, Math.round(width));
  const H = 230;
  const m = { l: 34, r: 44, t: 14, b: 30 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const { max, step } = niceAxis(Math.max(...points.map((p) => p.value)));
  const x = (i: number) => m.l + (points.length === 1 ? pw / 2 : (i / (points.length - 1)) * pw);
  const y = (v: number) => m.t + ph - (v / max) * ph;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'trend', role: 'img', 'aria-label': ariaLabel });

  // hairline grid + y labels
  for (let v = 0; v <= max; v += step) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'axis-line' : 'grid-line' }));
    svg.append(s('text', { x: m.l - 8, y: y(v) + 4, class: 'axis-text', 'text-anchor': 'end' }, String(v)));
  }
  // x labels: first, last and a few between
  const every = Math.max(1, Math.ceil(points.length / 6));
  points.forEach((_, i) => {
    if (i % every === 0 || i === points.length - 1) {
      svg.append(s('text', { x: x(i), y: H - 8, class: 'axis-text', 'text-anchor': 'middle' }, String(i + 1)));
    }
  });

  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  svg.append(s('path', { d, class: 'trend-line' }));

  const cross = s('line', { y1: m.t, y2: m.t + ph, class: 'crosshair', visibility: 'hidden' });
  svg.append(cross);

  points.forEach((p, i) => {
    svg.append(s('circle', { cx: x(i), cy: y(p.value), r: 4, class: 'trend-dot' }));
  });

  // Direct labels: only the latest value and the best (lowest) game.
  const last = points.length - 1;
  svg.append(s('text', { x: x(last) + 10, y: y((points[last] as TrendPoint).value) + 4, class: 'end-label' }, fmt1((points[last] as TrendPoint).value)));
  let best = 0;
  points.forEach((p, i) => {
    if (p.value < (points[best] as TrendPoint).value) best = i;
  });
  if (best !== last) {
    // The best game is the lowest point, so the space below it is clear of the line.
    svg.append(s('text', { x: x(best), y: y((points[best] as TrendPoint).value) + 20, class: 'end-label', 'text-anchor': 'middle' }, `best ${fmt1((points[best] as TrendPoint).value)}`));
  }

  // Generous hit targets (also keyboard-focusable) with the shared tooltip.
  points.forEach((p, i) => {
    const hit = s('circle', { cx: x(i), cy: y(p.value), r: 14, class: 'trend-hit', tabindex: 0, role: 'img', 'aria-label': `${p.label}. ${p.detail}` });
    const showCross = () => {
      cross.setAttribute('x1', String(x(i)));
      cross.setAttribute('x2', String(x(i)));
      cross.setAttribute('visibility', 'visible');
    };
    const hideCross = () => cross.setAttribute('visibility', 'hidden');
    hit.addEventListener('pointerenter', showCross);
    hit.addEventListener('focus', showCross);
    hit.addEventListener('pointerleave', hideCross);
    hit.addEventListener('blur', hideCross);
    attachTip(hit, () => [p.label, p.detail]);
    svg.append(hit);
  });

  return svg;
}

// ---- table twin ------------------------------------------------------------------

/** The accessible equivalent of a chart: every value, as a table. */
export function tableView(summary: string, headers: string[], rows: (string | number)[][]): HTMLElement {
  const table = h('table', { class: 'table compact' }, h('thead', null, h('tr', null, ...headers.map((t) => h('th', null, t)))));
  const body = h('tbody');
  for (const r of rows) body.append(h('tr', null, ...r.map((c, i) => h(i === 0 ? 'th' : 'td', i === 0 ? { scope: 'row' } : null, c))));
  table.append(body);
  return h('details', { class: 'table-view' }, h('summary', null, summary), h('div', { class: 'table-scroll' }, table));
}
