// The player's anonymous identity and small bits of browser storage, shared by
// the game page and the stats page.
//
// `?profile=2` namespaces storage so several tabs of ONE browser can act as
// different players (handy for testing). Normal players never need it.

const params = new URLSearchParams(location.search);
export const profile = (params.get('profile') ?? '').replace(/[^\w-]/g, '').slice(0, 16);
const storageKey = (k: string) => (profile ? `cm.${profile}.${k}` : `cm.${k}`);

function area(kind: 'local' | 'session'): Storage | undefined {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined; // storage blocked (private mode, strict settings)
  }
}

export function readStore(kind: 'local' | 'session', key: string): string | null {
  try {
    return area(kind)?.getItem(storageKey(key)) ?? null;
  } catch {
    return null;
  }
}

export function writeStore(kind: 'local' | 'session', key: string, value: string | null): void {
  try {
    if (value === null) area(kind)?.removeItem(storageKey(key));
    else area(kind)?.setItem(storageKey(key), value);
  } catch {
    /* the game still works without storage */
  }
}

/** Anonymous, private player identity. Needs no secure context (unlike randomUUID). */
export function getClientId(): string {
  const saved = readStore('local', 'clientId');
  if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  writeStore('local', 'clientId', id);
  return id;
}

/** Query string that keeps the test profile when linking between pages. */
export function profileQuery(): string {
  return profile ? `?profile=${profile}` : '';
}
