import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

export type Status = 'connecting' | 'open' | 'closed';

interface Handlers {
  onMessage(msg: ServerMessage): void;
  onStatus(status: Status): void;
  /** Another tab/device took over this player's seat. We stop reconnecting. */
  onReplaced(): void;
}

/** WebSocket with automatic reconnect (backoff) and mobile-resume handling. */
export class Connection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private replaced = false;

  constructor(private readonly handlers: Handlers) {}

  start(): void {
    const wake = () => {
      if (!this.replaced && !this.isOpen()) this.open();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake();
    });
    window.addEventListener('online', wake);
    this.open();
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): boolean {
    if (!this.isOpen()) return false;
    this.ws?.send(JSON.stringify(msg));
    return true;
  }

  private open(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return; // connecting or open

    this.handlers.onStatus('connecting');
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatus('open');
    };
    ws.onmessage = (event) => {
      try {
        this.handlers.onMessage(JSON.parse(String(event.data)) as ServerMessage);
      } catch (e) {
        console.error('bad server message', e);
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (event.code === 4000) {
        this.replaced = true;
        this.handlers.onReplaced();
        return;
      }
      this.handlers.onStatus('closed');
      const delay = Math.min(5000, 400 * 2 ** this.attempt++);
      this.retry = setTimeout(() => this.open(), delay);
    };
  }
}
