import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

import { vitestCiPool } from '../scripts/vitestCiPool.js';

export default defineConfig({
  plugins: [react()],
  test: {
    // Four DOM workers exhausted Testing Library's existing 3s async budget
    // on the public runner before ChiefOfStaff's config panel settled. Keep the
    // proven two-worker client cap; the Node/server runner uses all four CPUs.
    ...vitestCiPool({ maxWorkers: 2 }),
    // happy-dom, not jsdom (#6144): building the DOM was the client suite's
    // largest CI phase, and happy-dom cuts it by roughly two thirds for the same
    // 10k assertions. Files that need no DOM at all still opt out entirely with a
    // `// @vitest-environment node` pragma — see docs/GITHUB_ACTIONS.md.
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
    include: ['src/**/*.{test,spec}.{js,jsx}'],
  },
});
