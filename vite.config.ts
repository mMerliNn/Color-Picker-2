import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// In dev, serve /stats from stats.html (in production the game server does this).
function statsRoute(): Plugin {
  return {
    name: 'stats-route',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/stats(\/|\?|$)/.test(req.url)) req.url = req.url.replace(/^\/stats\/?/, '/stats.html');
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
