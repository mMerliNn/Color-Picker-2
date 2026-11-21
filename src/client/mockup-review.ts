// Design preview for the round review (dev only, not part of the build): the
// real review sheet and its saved image, fed with two made-up games so they can
// be checked without playing. Open /mockup-review.html with `npm run dev:client`.
import './styles.css';
import './mockup-review.css';
import { deltaE, generateColors, round2, scoreFromDeltaE } from '../shared/colors.js';
import type { RoundReview } from '../shared/protocol.js';
import { clamp01, hexToHsv, hsvToHex } from '../shared/review.js';
import { h } from './dom.js';
import { renderReviewCanvas, reviewSheet, type ReviewData } from './review.js';

// Scripted misses [hue°, saturation, brightness] so the samples show every kind
// of result; null = the player never chose a color that round.
type Miss = [number, number, number] | null;
const MISSES_5: Miss[] = [
  [8, -0.04, -0.1],
  [-3, 0.02, 0.01],
  [20, -0.15, 0.05],
  [-12, 0.1, -0.03],
  [2, -0.3, 0.18],
];
const MISSES_10: Miss[] = [...MISSES_5, [0, 0, 0.06], null, [-30, 0.05, -0.2], [5, 0.12, 0], [-1, -0.02, -0.02]];

function sampleGame(seed: number, misses: Miss[]): ReviewData {
  const rounds = generateColors(seed, misses.length).map((target, i): RoundReview => {
    const m = misses[i];
    if (!m) return { target, pick: null, deltaE: null, score: 0 };
    const t = hexToHsv(target);
    const pick = hsvToHex({ h: (t.h + m[0] + 360) % 360, s: clamp01(t.s + m[1]), v: clamp01(t.v + m[2]) });
    const dE = round2(deltaE(target, pick));
    return { target, pick, deltaE: dE, score: scoreFromDeltaE(dE) };
  });
  const picked = rounds.filter((r) => r.deltaE !== null);
  return {
    player: 'Player1',
    rounds,
    total: rounds.reduce((sum, r) => sum + r.score, 0),
    avgDeltaE: picked.length ? round2(picked.reduce((sum, r) => sum + (r.deltaE as number), 0) / picked.length) : null,
    date: new Date(),
  };
}

const GAMES = { '5': sampleGame(20261121, MISSES_5), '10': sampleGame(424242, MISSES_10) } as const;

const app = document.getElementById('app') as HTMLElement;
let which: keyof typeof GAMES = new URLSearchParams(location.search).get('rounds') === '10' ? '10' : '5';

function render(): void {
  const game = GAMES[which];
  const toggle = h(
    'div',
    { class: 'mk-toggle', role: 'group', 'aria-label': 'Sample game' },
    ...(['5', '10'] as const).map((k) => {
      const b = h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(k === which) }, `${k} rounds`);
      b.addEventListener('click', () => {
        which = k;
        history.replaceState(null, '', `?rounds=${k}`);
        render();
      });
      return b;
    }),
  );
  const img = h('img', { class: 'mk-preview', alt: `Saved image for the ${which}-round sample game` });
  img.src = renderReviewCanvas(game).toDataURL('image/png');

  app.replaceChildren(
    h(
      'header',
      { class: 'mk-bar' },
      h('div', null, h('strong', null, 'Preview: round review'), h('div', { class: 'muted mk-sub' }, 'Sample data · in the game it opens from Final results')),
      toggle,
    ),
    reviewSheet(game, () => {}),
    h(
      'section',
      { class: 'mk-image' },
      h('h3', null, 'What “Save as image” produces'),
      h('p', { class: 'muted mk-sub' }, 'PNG, 1260 px wide, always light so it reads the same wherever it is shared.'),
      img,
    ),
  );
}

render();
