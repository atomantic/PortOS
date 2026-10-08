// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';
import { ASYNC_UTIL_TIMEOUT_MS } from '../../test/timeouts.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

describe.skipIf(!chrome)('Goals organization responsive controls (#9712)', () => {
  let browser;
  let fixture;
  let origin;
  beforeAll(async () => {
    // Each startup phase is bounded and cleaned up inside the hook (#10543).
    fixture = await startBrowserFixture({ name: 'goals-chrome', createServer, chromium,
      launchOptions: { executablePath: chrome }, viteConfig: temp => ({
      configFile: false,
      cacheDir: join(temp, 'vite-cache'),
      // Pre-bundle only what this fixture renders, not the whole app's graph.
      optimizeDeps: { entries: ['src/components/goals/GoalsListView.jsx', 'src/components/goals/GoalsTreeView.jsx'], include: ['react', 'react-dom/client', 'react-router'] },
      root: fileURLToPath(new URL('../../..', import.meta.url)),
      plugins: [react(), {
        name: 'goals-browser-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id === '/goals-fixture.jsx') return '\0goals-fixture.jsx';
          // The regression concerns the toolbar, not WebGL scene rendering.
          if (id === '@react-three/fiber') return '\0goals-fiber.jsx';
          if (id === '@react-three/drei') return '\0goals-drei.js';
        },
        load(id) {
          if (id === '\0goals-fiber.jsx') return `import React from 'react';
            export const Canvas = () => React.createElement('div');
            export const useFrame = () => {};
            export const useThree = () => null;`;
          if (id === '\0goals-drei.js') return `export const OrbitControls = () => null;
            export const Billboard = () => null; export const Text = () => null;`;
          if (id !== '\0goals-fixture.jsx') return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { MemoryRouter } from 'react-router';
            import GoalsListView from '/src/components/goals/GoalsListView.jsx';
            import GoalsTreeView from '/src/components/goals/GoalsTreeView.jsx';
            import '/src/index.css';
            const goals = [
              { id: 'g1', title: 'Example apex', goalType: 'apex', category: 'mastery', children: [] },
              { id: 'g2', title: 'Example project', category: 'creative', children: [] },
            ];
            const View = location.search.includes('tree') ? GoalsTreeView : GoalsListView;
            createRoot(document.getElementById('root')).render(
              React.createElement(MemoryRouter, null,
                React.createElement('div', { className: 'h-screen p-4 md:p-6' },
                  React.createElement(View, { data: { roots: goals, flat: goals }, onRefresh: () => {} })))
            );
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/goals-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/goals-test',
              '<div id="root"></div><script type="module" src="/goals-fixture.jsx"></script>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    }) });
    ({ browser, origin } = fixture);
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each(['list', 'tree'])('keeps %s controls usable at phone, tablet and desktop widths', async view => {
    const page = await browser.newPage();
    try {
      await page.route('**/api/**', route => route.fulfill({ json: {
        activeProvider: 'provider-1',
        providers: [
          { id: 'provider-1', name: 'Example Provider', enabled: true, type: 'api',
            models: ['example-default', 'example-alternate'], defaultModel: 'example-default' },
          { id: 'provider-2', name: 'Other Provider', enabled: true, type: 'api',
            models: ['other-default', 'other-alternate'], defaultModel: 'other-default' },
        ],
      } }));
      await page.goto(`${origin}goals-test?${view}`);
      const provider = page.getByRole('combobox', { name: 'AI Provider' });
      const model = page.getByRole('combobox', { name: 'Model', exact: true });
      await model.waitFor({ timeout: ASYNC_UTIL_TIMEOUT_MS });
      for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1440, 900]]) {
        await page.setViewportSize({ width, height });
        for (const control of [provider, model, page.getByRole('button', { name: 'Organize', exact: true })]) {
          expect(await control.isVisible()).toBe(true);
          expect(await control.isEnabled()).toBe(true);
          const box = await control.boundingBox();
          expect(box.width).toBeGreaterThan(80);
          expect(box.height).toBeGreaterThanOrEqual(36);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          expect(box.y + box.height).toBeLessThanOrEqual(height);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await provider.selectOption('provider-2');
        await model.selectOption('other-alternate');
        expect(await model.inputValue()).toBe('other-alternate');
      }
    } finally { await page.close(); }
  }, 60000);
});
