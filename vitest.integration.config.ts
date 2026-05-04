import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Benchmarks may run for several minutes; pipeline tests need ~3.
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
    include: ['tests/integration/**/*.test.ts'],
  },
});
