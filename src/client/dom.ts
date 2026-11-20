// Tiny DOM helper. Strings are always added as text nodes (never as HTML),
// so player names and other server data cannot inject markup.

export type Child = Node | string | number | null | undefined | false;
export type Props = Record<string, unknown>;

export function append(el: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') {
        el.className = String(value);
      } else if (key === 'style' && typeof value === 'object') {
        for (const [prop, v] of Object.entries(value as Record<string, string>)) {
          el.style.setProperty(prop, v);
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        (el as HTMLElement).addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (value === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG counterpart of `h`: attributes only, children are elements or text. */
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function swatch(color: string | null, label: string, extraClass = ''): HTMLDivElement {
  const el = h('div', {
    class: `swatch ${extraClass}`.trim(),
    role: 'img',
    'aria-label': color ? `${label}: ${color}` : `${label}: none`,
  });
  if (color) el.style.backgroundColor = color;
  else el.classList.add('swatch-empty');
  return el;
}
