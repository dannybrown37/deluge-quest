import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    // real-Pyodide integration test: separate config (vitest.integration.config.ts),
    // run only via `npm run test:integration` / `just web-test-pyodide`
    exclude: [...configDefaults.exclude, 'src/lib/pyodide.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
