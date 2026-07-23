import { defineConfig } from 'vitest/config';

/**
 * The live canary runs against tenor.com over the network, so it lives behind
 * its own config and its own script (`npm run canary`) rather than being part
 * of `npm test`. A normal test run must never depend on a third party.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.live.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: 'default',
  },
});
