import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 5_000,
    include: ['tests/unit/**/*.test.ts'],
  },
});
