import { startApp } from './app.js';

// Configuration comes from the environment (see README / deploy/colormatch.service).
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1'; // set HOST=0.0.0.0 to play from other devices on your LAN
const dbFile = process.env.DB_FILE ?? 'data/colormatch.db';
const staticDir = process.env.STATIC_DIR ?? 'dist/client';
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = await startApp({ port, host, dbFile, staticDir, allowedOrigins });
console.log(`colormatch listening on http://${host}:${app.port} (db: ${dbFile}, static: ${staticDir})`);
if (allowedOrigins.length === 0) {
  console.log('ALLOWED_ORIGINS is empty: websocket connections are accepted from any origin.');
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
