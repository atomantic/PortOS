import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 10000,
    // The client owns its own test runner (`client/vitest.config.js`, jsdom,
    // `cd client && npm test`) which already covers every `client/src/**` test
    // — including the pure helper tests (e.g. normalize.js sidecar resolution).
    // So this server runner covers only server, scripts/migrations, and lib
    // tests; it intentionally does NOT glob the client tree (its default node
    // environment has no DOM, so DOM-dependent client tests would fail here).
    // The scripts/migrations glob lets each one-shot migration be verified
    // against synthetic fixtures.
    include: [
      '**/*.test.js',
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
