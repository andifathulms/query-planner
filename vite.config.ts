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
  },
});
