import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose `root` points at the client folder.
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
