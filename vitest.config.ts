import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Separate from vite.config.ts: vitest bundles its own copy of vite, and the two
// plugin types do not unify. The app build needs no test settings and the test
// run needs no production base path.
export default defineConfig({
  plugins: [react()],
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
