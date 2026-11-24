import './styles.css';
import { MAX_ROUND_SCORE, RAPID_MAX_BONUS } from '../shared/colors.js';
import { MODE_CATEGORIES } from '../shared/protocol.js';
import {
  DEFAULT_STATS_MODE,
  STATS_PAGES,
  hueBinLabel,
  statsModeFromPath,
  statsPath,
  type BandStat,
  type StatsResponse,
} from '../shared/stats.js';
import {
  barChart,
  divergingChart,
  fmt1,
  niceAxis,
  signed,
  tableView,
  trendChart,
  type BarRow,
} from './charts.js';
import { clear, h } from './dom.js';
import { getClientId, profileQuery } from './identity.js';

const clientId = getClientId();
const app = document.getElementById('app') as HTMLElement;
const home = `/${profileQuery()}`;

// Each game mode has its own page (/stats, /stats/memory, ...), built from that
// mode's games only. An address for a mode that does not exist goes to the default.
const pageMode = statsModeFromPath(location.pathname);
if (!pageMode) location.replace(`${statsPath(DEFAULT_STATS_MODE)}${profileQuery()}`);
const mode = pageMode ?? DEFAULT_STATS_MODE;
const page = STATS_PAGES[mode];
document.title = `Your color eye · ${page.label} · Color Match`;

// Ordinal ramps (one blue hue, validated for both light and dark surfaces).
// Same steps in both modes: the lightest clears 2:1 on light, the darkest on dark.
const RAMP3 = ['#86b6ef', '#3987e5', '#184f95'] as const; // low -> high
const RAMP4 = ['#86b6ef', '#5598e7', '#256abf', '#184f95'] as const;

// ---------------------------------------------------------------------------

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, mode }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Links to every mode's page, the current one marked, grouped like the lobby:
 * "Classic: Standard | Rapid", then "Memory". Built from the mode categories,
 * so new modes appear by themselves.
 */
function modeSwitcher(): HTMLElement {
  return h(
    'nav',
    { class: 'mode-switch', 'aria-label': 'Game mode' },
    ...MODE_CATEGORIES.map((c) => {
      const several = c.variants.length > 1;
      return h(
        'div',
        { class: 'mode-group', role: 'group', 'aria-label': c.label },
        several && h('span', { class: 'mode-group-label', 'aria-hidden': 'true' }, c.label),
        h(
          'div',
          { class: 'mode-tabs' },
          ...c.variants.map((v) =>
            h(
              'a',
              { href: `${statsPath(v.mode)}${profileQuery()}`, 'aria-current': v.mode === mode ? 'page' : undefined },
              several ? v.label : c.label,
            ),
          ),
        ),
      );
    }),
  );
}

function header(subtitle: string): HTMLElement {
  return h(
    'header',
    { class: 'stats-head' },
    h('a', { class: 'back', href: home }, '← Back to the game'),
    h('h1', null, 'Your color eye'),
    modeSwitcher(),
    h('p', { class: 'lead' }, `${page.intro} ${subtitle}`),
  );
}

function card(title: string, subtitle: string | null, ...body: (Node | null)[]): HTMLElement {
  return h(
    'section',
    { class: 'card viz-card' },
    h('h2', null, title),
    subtitle ? h('p', { class: 'muted sub' }, subtitle) : null,
    ...body,
  );
}

function tile(label: string, value: string, sub?: string): HTMLElement {
  return h('div', { class: 'tile' }, h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, value), sub ? h('span', { class: 'tile-sub' }, sub) : null);
}

const dateLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// ---------------------------------------------------------------------------

function render(stats: StatsResponse): void {
  const t = stats.totals;
  clear(app);

  if (t.rounds === 0) {
    app.append(
      header(`Play a few ${page.label} games and this page will show where your color eye is sharp and where it drifts.`),
      card(
        `No ${page.label} games yet`,
        null,
        h(
          'p',
          null,
          `Your picks are saved as you play, under a random id kept in this browser. Choose ${page.label} as the mode in the lobby, finish a game, then come back here.`,
        ),
        h('a', { class: 'btn primary', href: home }, 'Play a game'),
      ),
    );
    return;
  }

  app.append(
    header(`Based on ${t.rounds} round${t.rounds === 1 ? '' : 's'} across ${t.games} game${t.games === 1 ? '' : 's'}.`),
    h(
      'div',
      { class: 'tiles' },
      tile('Average color error', t.avgDeltaE === null ? '–' : fmt1(t.avgDeltaE), t.everyoneAvgDeltaE === null ? 'ΔE, lower is better' : `ΔE · everyone: ${fmt1(t.everyoneAvgDeltaE)}`),
      tile('Rounds answered', String(t.answered), t.misses > 0 ? `${t.misses} missed` : 'none missed'),
      tile('Points per round', t.avgScore === null ? '–' : fmt1(t.avgScore), mode === 'rapid' ? `out of ${MAX_ROUND_SCORE * (1 + RAPID_MAX_BONUS)}, speed bonus included` : `out of ${MAX_ROUND_SCORE}`),
      tile('Best game', t.bestGame ? String(t.bestGame.score) : '–', t.bestGame ? `points in ${t.bestGame.rounds} rounds` : 'needs a 5+ round game'),
    ),
    insightsCard(stats),
    hueCard(stats),
    biasCard(stats),
    bandsCard(stats),
    trendCard(stats),
    dataCard(),
    h(
      'p',
      { class: 'muted fine' },
      'ΔE is the perceptual distance between two colors (CIEDE2000). About 1 is invisible, 2 is the smallest difference most people notice, 10 is clearly different. Lightness and saturation are measured in CIE LCH.',
    ),
  );
}

// ---- insights ---------------------------------------------------------------

function insightsCard(stats: StatsResponse): HTMLElement {
  const list = h('ul', { class: 'insights' });
  for (const line of stats.insights) list.append(h('li', null, line));
  return card('What stands out', null, list);
}

// ---- error by hue -----------------------------------------------------------

function hueCard(stats: StatsResponse): HTMLElement {
  const values = stats.hue.flatMap((b) => [b.avgDeltaE ?? 0, b.everyoneAvgDeltaE ?? 0]);
  const { max, step } = niceAxis(Math.max(...values));
  const rows: BarRow[] = stats.hue.map((b) => {
    const low = b.n > 0 && b.n < stats.minBinPicks;
    const tip: string[] = [];
    if (b.n === 0) tip.push('No picks yet');
    else {
      tip.push(`${b.n} pick${b.n === 1 ? '' : 's'}${low ? ' (low data)' : ''}, average error ΔE ${fmt1(b.avgDeltaE as number)}`);
      if (b.everyoneAvgDeltaE !== null) tip.push(`Everyone: ΔE ${fmt1(b.everyoneAvgDeltaE)}`);
      if (b.lightnessBias !== null) tip.push(`Lightness ${signed(b.lightnessBias)}, saturation ${signed(b.chromaBias ?? 0)}`);
      if (b.hueDrift !== null) tip.push(`Hue drift ${signed(b.hueDrift)}° toward ${hueBinLabel(b.bin + (b.hueDrift >= 0 ? 1 : -1)).toLowerCase()}`);
    }
    return {
      label: b.label,
      swatch: `background:lch(64 55 ${b.start + 15})`,
      value: b.avgDeltaE,
      ref: b.everyoneAvgDeltaE,
      low,
      tip,
    };
  });
  const chart = barChart({ rows, max, step, ariaLabel: 'Average color error by hue, in ΔE' });
  const table = tableView(
    'Show as table',
    ['Hue', 'Picks', 'Avg ΔE', 'Everyone', 'Lightness', 'Saturation', 'Hue drift'],
    stats.hue.map((b) => [
      b.label,
      b.n,
      b.avgDeltaE === null ? '–' : fmt1(b.avgDeltaE),
      b.everyoneAvgDeltaE === null ? '–' : fmt1(b.everyoneAvgDeltaE),
      b.lightnessBias === null ? '–' : signed(b.lightnessBias),
      b.chromaBias === null ? '–' : signed(b.chromaBias),
      b.hueDrift === null ? '–' : `${signed(b.hueDrift)}°`,
    ]),
  );
  return card(
    'Error by hue',
    `Average color error (ΔE) for each part of the color wheel. Shorter is better. Faded bars have fewer than ${stats.minBinPicks} picks.`,
    chart,
    table,
  );
}

// ---- systematic bias --------------------------------------------------------

function biasCard(stats: StatsResponse): HTMLElement {
  const b = stats.bias;
  const rows = [
    {
      label: 'Lightness',
      value: b.lightness,
      range: 10,
      negWord: 'darker',
      posWord: 'lighter',
      tip: [b.lightness === null ? 'Not enough data' : `Your picks are on average ${fmt1(Math.abs(b.lightness))} points ${b.lightness >= 0 ? 'lighter' : 'darker'} than the target`],
    },
    {
      label: 'Saturation',
      value: b.chroma,
      range: 10,
      negWord: 'duller',
      posWord: 'more vivid',
      tip: [b.chroma === null ? 'Not enough data' : `Your picks are on average ${fmt1(Math.abs(b.chroma))} points ${b.chroma >= 0 ? 'more vivid' : 'duller'} than the target`],
    },
  ];
  return card(
    'Do you miss in one direction?',
    'The average signed difference between your pick and the target. A bar near the middle means no systematic lean; a long bar means you could correct it on purpose.',
    divergingChart(rows, 'Average lightness and saturation bias'),
  );
}

// ---- where it gets harder ------------------------------------------------------

function bandsCard(stats: StatsResponse): HTMLElement {
  const all = [...stats.lightness, ...stats.chroma, ...stats.time].map((b) => b.avgDeltaE ?? 0);
  const { max, step } = niceAxis(Math.max(...all));
  const group = (title: string, bands: BandStat[], ramp: readonly string[], noun: string): HTMLElement => {
    const rows: BarRow[] = bands.map((b, i) => ({
      label: b.label,
      value: b.avgDeltaE,
      low: b.n > 0 && b.n < stats.minBinPicks,
      color: ramp[i],
      tip: [b.n === 0 ? 'No picks yet' : `${b.n} pick${b.n === 1 ? '' : 's'}, average error ΔE ${fmt1(b.avgDeltaE as number)}`],
    }));
    return h('div', { class: 'band' }, h('h3', null, title), barChart({ rows, max, step, ariaLabel: `Average color error by ${noun}, in ΔE` }));
  };
  const tableRows = [
    ...stats.lightness.map((b) => ['Target lightness', b]),
    ...stats.chroma.map((b) => ['Target saturation', b]),
    ...stats.time.map((b) => ['Time taken', b]),
  ] as [string, BandStat][];
  return card(
    'Where it gets harder',
    'Same axis in all three charts, so the bars compare directly.',
    h(
      'div',
      { class: 'bands' },
      group('Target lightness', stats.lightness, [RAMP3[2], RAMP3[1], RAMP3[0]], 'target lightness'),
      group('Target saturation', stats.chroma, RAMP3, 'target saturation'),
      group('Time taken', stats.time, RAMP4, 'time taken'),
    ),
    tableView('Show as table', ['Group', 'Band', 'Picks', 'Avg ΔE'], tableRows.map(([g, b]) => [g, b.label, b.n, b.avgDeltaE === null ? '–' : fmt1(b.avgDeltaE)])),
  );
}

// ---- trend ------------------------------------------------------------------

function trendCard(stats: StatsResponse): HTMLElement {
  const sub = 'Average color error (ΔE) per game, oldest to newest. Lower is better.';
  if (stats.trend.length < 2) {
    return card('Progress over time', sub, h('p', { class: 'muted' }, 'Play at least two games to see a trend.'));
  }
  const points = stats.trend.map((g, i) => ({
    label: `Game ${i + 1} · ${dateLabel(g.at)}`,
    value: g.avgDeltaE,
    detail: `Average error ΔE ${fmt1(g.avgDeltaE)}, ${g.score} points over ${g.rounds} rounds`,
  }));
  const holder = h('div', { class: 'trend-holder' });
  const draw = () => {
    clear(holder);
    holder.append(trendChart(points, holder.clientWidth || 600, 'Line chart of average color error per game'));
  };
  const table = tableView(
    'Show as table',
    ['Game', 'Date', 'Avg ΔE', 'Points', 'Rounds'],
    stats.trend.map((g, i) => [String(i + 1), dateLabel(g.at), fmt1(g.avgDeltaE), g.score, g.rounds]),
  );
  const el = card('Progress over time', sub, holder, table);
  // Draw once attached (we need the real width), and again when it changes.
  requestAnimationFrame(draw);
  let width = 0;
  new ResizeObserver(() => {
    if (Math.abs(holder.clientWidth - width) > 4) {
      width = holder.clientWidth;
      draw();
    }
  }).observe(holder);
  return el;
}

// ---- your data --------------------------------------------------------------

function dataCard(): HTMLElement {
  const box = h('div', { class: 'delete-box' });
  const ask = h('button', { class: 'btn', type: 'button' }, 'Delete my history');
  const status = h('p', { class: 'muted', role: 'status' });
  const show = (...nodes: Node[]) => {
    clear(box);
    box.append(...nodes);
  };
  const confirm = () => {
    const yes = h('button', { class: 'btn danger', type: 'button' }, 'Yes, delete everything');
    const no = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    no.addEventListener('click', () => show(ask));
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      try {
        await api<{ deleted: number }>('/api/delete');
        await load();
      } catch {
        status.textContent = 'Could not delete right now. Try again in a moment.';
        show(ask);
      }
    });
    show(h('p', null, 'This permanently removes every pick stored for you, in every game mode. It cannot be undone.'), h('div', { class: 'row' }, yes, no));
  };
  ask.addEventListener('click', confirm);
  show(ask);
  return card(
    'Your data',
    'Picks are stored under a random id kept in this browser (no account, no email). Clearing your browser data starts a fresh history. Deleting removes your history in every game mode.',
    box,
    status,
  );
}

// ---------------------------------------------------------------------------

async function load(): Promise<void> {
  try {
    render(await api<StatsResponse>('/api/stats'));
  } catch {
    clear(app);
    const retry = h('button', { class: 'btn primary', type: 'button' }, 'Try again');
    retry.addEventListener('click', () => void load());
    app.append(header('Something went wrong while loading your history.'), card('Could not load', null, retry));
  }
}

app.append(header('Loading your history…'));
void load();
