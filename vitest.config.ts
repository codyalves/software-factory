import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    // Each Postgres integration test creates its own database, so files can run in parallel.
    testTimeout: 20_000,
  },
});
