import { defineConfig } from 'vitest/config';

// Without its own config, vitest walks up to the frontend's vite.config.ts,
// which imports `vite` (not installed in server/) and fails to load. The inline
// postcss block also stops vite from loading the frontend's postcss.config.js
// (Tailwind), which isn't installed here either.
export default defineConfig({
  css: { postcss: {} },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
