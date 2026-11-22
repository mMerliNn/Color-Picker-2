import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// In dev, serve /stats and /stats/<mode> from stats.html (in production the game
// server does this). The page itself sends an unknown mode back to /stats.
function statsRoute(): Plugin {
  return {
    name: 'stats-route',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const m = req.url ? /^\/stats(?:\/[a-z0-9-]+)?\/?(\?.*)?$/.exec(req.url) : null;
        if (m) req.url = `/stats.html${m[1] ?? ''}`;
        next();
      });
    },
  };
}

// Client lives in src/client (two pages: the game and /stats); the game server
// (src/server) serves the built files from dist/client in production. In dev,
// Vite proxies /ws and /api to the server.
export default defineConfig({
  root: 'src/client',
  plugins: [statsRoute()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./src/client/index.html', import.meta.url)),
        stats: fileURLToPath(new URL('./src/client/stats.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/api': { target: 'http://localhost:3000' },
    },
  },
});
