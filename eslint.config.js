import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022 },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Non-negotiable 3: estimation cannot see the data.
    files: ['src/planner/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['**/storage/**', '**/executor/**'],
      }],
    },
  },
  {
    // Non-negotiable 4: the engine is pure and headless.
    files: ['src/parser/**', 'src/storage/**', 'src/stats/**', 'src/planner/**', 'src/executor/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: ['react', 'react-dom', '**/views/**', '**/ui/**', '**/state/**'],
      }],
      'no-restricted-globals': ['error', 'window', 'document'],
      'no-restricted-properties': ['error',
        { object: 'Math', property: 'random', message: 'Use the seeded PRNG in src/engine/rng.ts.' },
      ],
    },
  },
);
