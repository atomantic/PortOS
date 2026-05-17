import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 10000,
    // Pick up tests from the client tree too — a handful of client-side pure
    // helpers (normalize.js sidecar field resolution) have unit tests that
    // belong alongside the source, but the client itself has no test runner.
    // The server's vitest is the project's single test entrypoint, so we
    // include the client *.test.js files here. Also pick up migration tests
    // from scripts/migrations/ so each one-shot migration can be verified
    // against synthetic fixtures.
    include: [
      '**/*.test.js',
      '../client/src/**/*.test.js',
      '../scripts/**/*.test.js',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['lib/**/*.js', 'routes/**/*.js', 'services/**/*.js'],
      exclude: [
        '**/*.test.js',
        '**/index.js',
        '**/cos-runner/**'
      ],
      thresholds: {
        lines: 30,
        functions: 30,
        branches: 30,
        statements: 30
      }
    },
    globals: true
  }
});
