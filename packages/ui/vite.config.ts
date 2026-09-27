import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@agent-os/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  server: {
    port: 4110,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:4110',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});