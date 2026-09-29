import { configDefaults, defineConfig } from 'vitest/config';

// Run from the repo root (npm test). Skip compiled output: the adapters keep their
// *.test.js build products in dist/, and running them again would just double-count.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});