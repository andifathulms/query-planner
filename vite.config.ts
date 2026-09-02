import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base is the repo path so GitHub Pages serves assets correctly.
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_ACTIONS ? '/query-planner/' : '/',
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The oracle loads a schema into PGlite; leaving it in the default pool
    // alongside the equivalence suite makes both compete for the same core, and
    // the 200 ms planning budget in enumeration.test.ts is a wall-clock
    // assertion. `npm run oracle` runs it, and CI runs both.
    exclude: ['node_modules/**'],
  },
});
