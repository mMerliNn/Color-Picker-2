import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { isClientId, type ServerMessage } from '../shared/protocol.js';
import { GameStore } from './db.js';
import { GameServer, type GameServerOptions } from './game-server.js';
import type { Conn } from './room.js';
import { StatsService } from './stats.js';

export interface AppOptions {
  port: number;
  host: string;
  dbFile: string;
  staticDir: string;
  /** Allowed WebSocket Origin values. Empty = accept any origin. */
  allowedOrigins: string[];
  game?: GameServerOptions;
  /** How long the "everyone" comparison numbers are cached (default 60 s). */
  statsCacheMs?: number;
}

export interface App {
  server: Server;
  game: GameServer;
  store: GameStore;
  stats: StatsService;
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
};

// ---- JSON API for the personal stats page ----------------------------------
// The player's private client id travels in a POST body (never in a URL, which
// ends up in logs). There are no CORS headers and the body is JSON, so other
// websites cannot call these endpoints from a visitor's browser.

const API_MAX_BODY = 512;
let apiTokens = 20;
let apiLast = Date.now();

function apiAllowed(): boolean {
  const now = Date.now();
  apiTokens = Math.min(20, apiTokens + ((now - apiLast) / 1000) * 10); // burst 20, 10 per second
  apiLast = now;
  if (apiTokens < 1) return false;
  apiTokens -= 1;
  return true;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    let tooBig = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return; // keep draining, but stop buffering
      size += chunk.length;
      if (size > API_MAX_BODY) {
        tooBig = true;
        chunks.length = 0;
        resolve(null); // the 413 is sent now; the connection is closed after it
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

async function handleApi(
  stats: StatsService,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(JSON.stringify(body));
  };

  if (pathname !== '/api/stats' && pathname !== '/api/delete') {
    json(404, { error: 'not_found' });
    return;
  }
  if (req.method !== 'POST') {
    json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    return;
  }
  if (!apiAllowed()) {
    json(429, { error: 'rate_limited' }, { 'Retry-After': '1' });
    return;
  }
  const raw = await readBody(req);
  if (raw === null) {
    json(413, { error: 'too_large' }, { Connection: 'close' });
    return;
  }
  let clientId: unknown;
  try {
    clientId = (JSON.parse(raw) as { clientId?: unknown }).clientId;
  } catch {
    json(400, { error: 'bad_request' });
    return;
  }
  if (!isClientId(clientId)) {
    json(400, { error: 'bad_request' });
    return;
  }
  // Unknown ids simply get empty statistics, so the endpoint cannot be used to
  // find out which ids exist.
  if (pathname === '/api/stats') json(200, stats.forClient(clientId));
  else json(200, { deleted: stats.deleteClient(clientId) });
}

async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, body: string | Buffer, headers: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    send(400, 'Bad request');
    return;
  }
  if (pathname.includes('\0')) {
    send(400, 'Bad request');
    return;
  }
  if (pathname === '/healthz') {
    send(200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return;
  }

  // The stats page is its own entry point (stats.html), not part of the game SPA.
  if (pathname === '/stats' || pathname === '/stats/') pathname = '/stats.html';

  // Resolve inside the static root only (blocks ../ traversal).
  let file = resolve(join(root, normalize(pathname)));
  if (file !== root && !file.startsWith(root + sep)) {
    send(403, 'Forbidden');
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
    await stat(file);
  } catch {
    // Unknown path without an extension -> single-page app entry point.
    if (extname(pathname)) {
      send(404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    file = join(root, 'index.html');
  }

  try {
    const body = await readFile(file);
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const cache = pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    send(200, body, { 'Content-Type': type, 'Cache-Control': cache });
  } catch {
    send(404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

export async function startApp(options: AppOptions): Promise<App> {
  const staticRoot = resolve(options.staticDir);
  const store = new GameStore(options.dbFile);
  const game = new GameServer(store, options.game);
  const stats = new StatsService(store, options.statsCacheMs);

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const handler = pathname.startsWith('/api/')
      ? handleApi(stats, pathname, req, res)
      : serveStatic(staticRoot, req, res);
    handler.catch((e) => {
      console.error('request error', e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const origin = req.headers.origin;
    const originOk =
      options.allowedOrigins.length === 0 || (origin !== undefined && options.allowedOrigins.includes(origin));
    if (path !== '/ws' || !originOk) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const conn: Conn = {
      send(msg: ServerMessage) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close() {
        ws.close(4000, 'replaced');
      },
    };
    const session = game.connect(conn);

    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30_000);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        game.handle(session, data.toString());
      } catch (e) {
        console.error('message handler error', e);
      }
    });
    ws.on('close', () => {
      clearInterval(heartbeat);
      game.disconnect(session);
    });
    ws.on('error', () => ws.terminate());
  });

  const sweeper = setInterval(() => game.sweep(), 60_000);
  sweeper.unref();

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(options.port, options.host, () => ok());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    server,
    game,
    store,
    stats,
    port,
    async close() {
      clearInterval(sweeper);
      game.close();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((ok) => server.close(() => ok()));
      store.close();
    },
  };
}
