import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/lib/pyodide.integration.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage-integration',
      // only pyodide.ts's own lines — this run also executes the pyodide
      // npm package and Node internals, which aren't ours to cover
      include: ['src/lib/pyodide.ts'],
    },
  },
});
