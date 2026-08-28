import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

import { vitestCiPool } from '../scripts/vitestCiPool.js';

export default defineConfig({
  plugins: [react()],
  test: {
    // Four jsdom workers exhausted Testing Library's existing 3s async budget
    // on the public runner before ChiefOfStaff's config panel settled. Keep the
    // proven two-worker client cap; the Node/server runner uses all four CPUs.
    ...vitestCiPool({ maxWorkers: 2 }),
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
    include: ['src/**/*.{test,spec}.{js,jsx}'],
  },
});
