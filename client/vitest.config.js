import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

import { vitestCiPool } from '../scripts/vitestCiPool.js';
import { TEST_TIMEOUT_MS } from './src/test/timeouts.js';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Share Three.js without bypassing its package exports with a directory alias.
    dedupe: ['three'],
  },
  test: {
    // Four DOM workers exhausted Testing Library's async budget on the public
    // runner before ChiefOfStaff's config panel settled. Keep the proven
    // two-worker client cap; the Node/server runner uses all four CPUs.
    ...vitestCiPool({ maxWorkers: 2 }),
    // Derived from the Testing Library async budget, never written as a literal:
    // an inner `waitFor` bound that reaches the per-test budget can never report
    // its own failure. See src/test/timeouts.js for the full reasoning.
    testTimeout: TEST_TIMEOUT_MS,
    // happy-dom, not jsdom (#6144): building the DOM was the client suite's
    // largest CI phase, and happy-dom cuts it by roughly two thirds for the same
    // 10k assertions. Files that need no DOM at all still opt out entirely with a
    // `// @vitest-environment node` pragma — see docs/GITHUB_ACTIONS.md.
    environment: 'happy-dom',
    // Vitest 5 clears mock call history before every test by default
    // (`clearMocks`); see the longer note in server/vitest.config.js. Accepted
    // rather than pinned back to the vitest 4 default — implementations set by
    // a `vi.mock` factory survive, only `mock.calls` resets, and the suite is
    // green under it.
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
    include: ['src/**/*.{test,spec}.{js,jsx}'],
  },
});
