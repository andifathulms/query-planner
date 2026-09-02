import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts: vitest bundles its own copy of vite, and the two
// plugin types do not unify. JSX is handled by esbuild rather than the React
// plugin, which the interface tests do not need.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    // Engine tests run in node; the interface tests declare jsdom per file.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // enumeration.test.ts asserts the 200 ms planning budget in wall-clock time
    // (PRD §8.3). Files running in parallel compete for the same core and make
    // that measurement meaningless, so the suite runs one file at a time.
    fileParallelism: false,
  },
});
