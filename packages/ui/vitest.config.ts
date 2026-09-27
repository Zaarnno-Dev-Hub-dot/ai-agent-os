import { defineConfig } from 'vitest/config';
import path from 'path';

// Separate from vite.config.ts on purpose: that file drives the real dev
// server/build (server.port 4110 etc.) and this task must not touch it —
// zero risk of a test-config change disturbing the live UI dev/build path.
// Store/lib logic here has no DOM dependency (speech APIs are mocked as
// plain globals in the test files), so the default 'node' test environment
// is enough — no jsdom/happy-dom dependency needed.
export default defineConfig({
  resolve: {
    alias: {
      '@agent-os/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
