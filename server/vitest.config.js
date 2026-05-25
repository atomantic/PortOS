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
      '../lib/**/*.test.js',
    ],
    // The slashdo submodule ships its own node:test suites; vitest can't
    // parse them and the broad `../lib/**` glob would otherwise pick them up
    // as "no test suite found" failures that break --bail=1 CI runs.
    exclude: [
      '**/node_modules/**',
      '../lib/slashdo/**',
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
    globals: true,
    // Global setup: mocks getPeers → [] so test-created records never fan out
    // to live sync peers.  Per-suite vi.mock('./instances.js', …) overrides win.
    setupFiles: ['./vitest.setup.js'],
  }
});
