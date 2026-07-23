import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Live tests hit tenor.com and are opt-in via `npm run canary`, so that a
    // normal `npm test` never depends on the network or on a third party.
    exclude: ['tests/**/*.live.test.ts', 'node_modules/**', 'dist/**'],
    environment: 'node',
    reporters: 'default',
  },
});
