import './styles.css';
import { LEADERBOARD_SIZE, timeLeft, type ChallengeStatus, type ColorStat, type LeaderRow, type LeaderboardResponse } from '../shared/challenge.js';
import { isGrayMode } from '../shared/protocol.js';
import { h } from './dom.js';
import { getClientId, profileQuery } from './identity.js';

// The weekly challenge's leaderboard (/challenge). Only players who have played
// this week's challenge get to see it; everyone else is sent to play first.

const clientId = getClientId();
const app = document.getElementById('app') as HTMLElement;
const home = `/${profileQuery()}`;
const MEDALS = ['🥇', '🥈', '🥉'];

async function post<T>(path: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) });
  return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
}

/** Put these on the page, leaving out the ones that are not there. */
function show(...parts: (Node | null | false | undefined)[]): void {
  app.replaceChildren(...parts.filter((p): p is Node => !!p));
}

/** Total time as "2:00.4" (tenths, because it breaks ties). */
function clock(ms: number): string {
  const tenths = Math.round(ms / 100);
  const s = Math.floor(tenths / 10);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${tenths % 10}`;
}

function header(title: string, sub: string): HTMLElement {
  return h(
    'header',
    { class: 'stats-head' },
    h('a', { class: 'back', href: home }, '← Back to the game'),
    h('h1', null, title),
    h('p', { class: 'lead' }, sub),
  );
}

function table(rows: LeaderRow[], you: LeaderRow | null, total: number, gray: boolean): HTMLElement {
  const row = (r: LeaderRow) =>
    h(
      'tr',
      { class: r.you ? 'me' : '', 'aria-current': r.you ? 'true' : undefined },
      h('td', null, r.rank <= 3 ? h('span', { 'aria-label': `${r.rank}` }, MEDALS[r.rank - 1] as string) : r.rank),
      h('td', { class: 'name', title: r.name }, r.name, r.you ? h('span', { class: 'tag' }, 'you') : null),
      h('td', null, r.avgDeltaE === null ? '–' : r.avgDeltaE.toFixed(1)),
      // Total time breaks ties on points; a try that stopped early says how far it got.
      h('td', { class: 'muted' }, r.rounds < total ? `${r.rounds}/${total}` : clock(r.totalTimeMs)),
      h('td', { class: 'num' }, r.score),
    );
  return h(
    'table',
    { class: 'table leaderboard' },
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', null, '#'),
        h('th', null, 'Player'),
        h('th', { title: gray ? 'Average difference on the 0 to 100 scale (lower is better)' : 'Average color distance (lower is better)' }, gray ? 'Avg off' : 'Avg ΔE'),
        h('th', { title: 'Total time (breaks ties), or rounds played when a try stopped early' }, 'Time'),
        h('th', null, 'Points'),
      ),
    ),
    h(
      'tbody',
      null,
      ...rows.map(row),
      // Your own row is always shown, below a gap when you are further down.
      you && h('tr', { class: 'gap', 'aria-hidden': 'true' }, h('td', { colspan: 5 }, '⋯')),
      you && row(you),
    ),
  );
}

/**
 * The week's colors in round order, each with everyone's average error and the
 * player's own, a bar for how hard it was (longest = hardest), and the hardest
 * and easiest marked. The color swatch shows the target with the player's own
 * pick beside it.
 */
function colorsCard(colors: ColorStat[], gray: boolean): HTMLElement | null {
  if (!colors.length) return null;
  const err = (n: number) => (gray ? `off by ${n.toFixed(1)}` : `ΔE ${n.toFixed(1)}`);
  const known = colors.filter((c) => c.avgError !== null);
  const max = Math.max(...known.map((c) => c.avgError as number), 1);
  // Only worth naming when at least two colors have answers.
  const byError = [...known].sort((a, b) => (b.avgError as number) - (a.avgError as number));
  const hardest = byError.length >= 2 ? byError[0] : undefined;
  const easiest = byError.length >= 2 ? byError.at(-1) : undefined;

  const pair = (c: ColorStat) => {
    const target = h('span');
    target.style.backgroundColor = c.hex;
    const yours = h('span', { class: c.yourPick ? '' : 'swatch-empty' });
    if (c.yourPick) yours.style.backgroundColor = c.yourPick;
    const label = `Round ${c.round + 1} color, ${c.yourPick ? 'with your pick beside it' : 'you did not answer it'}`;
    return h('span', { class: 'color-pair', role: 'img', 'aria-label': label, title: c.yourPick ? `${c.hex} · yours ${c.yourPick}` : c.hex }, target, yours);
  };

  const rows = colors.map((c) => {
    // The bar, the number and the tag each have their own column, so the
    // numbers line up under their heading and the bars stay comparable.
    const bar = h('span', { class: 'color-bar', 'aria-hidden': 'true' }, h('span'));
    (bar.firstChild as HTMLElement).style.width = `${c.avgError === null ? 0 : Math.round(((c.avgError as number) / max) * 100)}%`;
    const tag = c === hardest ? h('span', { class: 'tag hard' }, 'hardest') : c === easiest ? h('span', { class: 'tag' }, 'easiest') : null;
    return h(
      'tr',
      { class: c === hardest ? 'hardest' : '' },
      h('td', null, c.round + 1),
      h('td', null, pair(c)),
      h('td', { class: 'color-bar-cell', title: `${c.answered} answered${c.missed ? `, ${c.missed} missed` : ''}` }, bar),
      h('td', { class: 'num' }, c.avgError === null ? '–' : c.avgError.toFixed(1)),
      h('td', { class: 'tag-cell' }, tag),
      h('td', { class: 'num' }, c.yourError === null ? (c.yourPick === null ? '–' : '') : c.yourError.toFixed(1)),
    );
  });

  return h(
    'section',
    { class: 'card' },
    h('h2', null, 'This week’s colors'),
    h(
      'p',
      { class: 'muted sub' },
      hardest && easiest
        ? `Hardest: round ${hardest.round + 1}, ${err(hardest.avgError as number)} on average. Easiest: round ${easiest.round + 1}, ${err(easiest.avgError as number)}.`
        : 'Everyone’s average error on each color. Lower is better.',
    ),
    h(
      'table',
      { class: 'table color-stats' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, '#'),
          h('th', { title: 'The color, with your pick beside it' }, 'Color · yours'),
          h('th', { title: 'Everyone’s average error (lower is better)' }, 'Everyone'),
          h('th', { class: 'num', title: 'Everyone’s average error (lower is better)' }, gray ? 'Avg off' : 'Avg ΔE'),
          h('th', { class: 'tag-cell' }),
          h('th', { class: 'num' }, 'You'),
        ),
      ),
      h('tbody', null, ...rows),
    ),
  );
}

function winnersCard(st: ChallengeStatus): HTMLElement | null {
  if (!st.lastWeek) return null;
  return h(
    'section',
    { class: 'card' },
    h('h2', null, `Last week’s winners · Week ${st.lastWeek.number}`),
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
        ),
      ),
    ),
  );
}

async function main(): Promise<void> {
  let status: ChallengeStatus | null = null;
  let board: { status: number; body: LeaderboardResponse | null };
  try {
    [status, board] = await Promise.all([post<ChallengeStatus>('/api/challenge').then((r) => r.body), post<LeaderboardResponse>('/api/challenge/leaderboard')]);
  } catch {
    app.replaceChildren(header('Weekly challenge', 'Could not reach the server. Try again in a moment.'));
    return;
  }

  const lb = board.body;
  if (!lb) {
    // Not played yet this week: the board stays hidden until you have.
    const week = status?.week;
    show(
      header('Weekly challenge', week ? `Week ${week.number} · ends in ${timeLeft(week.endsAt - (status as ChallengeStatus).serverNow)} · ${week.players} played so far` : ''),
      h(
        'section',
        { class: 'card center' },
        h('h2', null, board.status === 403 ? 'Play first' : 'Leaderboard unavailable'),
        h(
          'p',
          { class: 'muted' },
          board.status === 403
            ? 'The leaderboard opens once you have played this week’s challenge. You get one try.'
            : 'Could not load the leaderboard. Try again in a moment.',
        ),
        h('a', { class: 'btn primary big', href: home }, 'Play this week’s challenge'),
      ),
      status ? winnersCard(status) : null,
    );
    return;
  }

  const w = lb.week;
  const now = status?.serverNow ?? Date.now();
  const mine = lb.you ?? lb.rows.find((r) => r.you) ?? null;
  document.title = `Week ${w.number} · Weekly challenge · Color Match`;
  show(
    header(`Weekly challenge · Week ${w.number}`, `Ends in ${timeLeft(w.endsAt - now)} · ${w.players} ${w.players === 1 ? 'player' : 'players'} · ${w.rounds} colors, ${w.roundSeconds} s each`),
    mine && h('p', { class: 'challenge-rank' }, `You’re #${mine.rank} of ${w.players} with ${mine.score} points`),
    h(
      'section',
      { class: 'card' },
      h('h2', null, w.players > LEADERBOARD_SIZE ? `Top ${LEADERBOARD_SIZE}` : 'Leaderboard'),
      table(lb.rows, lb.you, w.rounds, isGrayMode(w.mode)),
      h('p', { class: 'muted fine' }, 'Ties on points go to the faster total time. A new challenge starts every Monday at 00:00 Tokyo time.'),
    ),
    // `?? []`: a server older than this page sends no colors.
    colorsCard(lb.colors ?? [], isGrayMode(w.mode)),
    status ? winnersCard(status) : null,
  );
}

void main();
