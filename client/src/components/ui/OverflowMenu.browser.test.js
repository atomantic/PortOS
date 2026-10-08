// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';

const require = createRequire(import.meta.url);
// Prefer the client dev dependency; linked worktrees can also use the same
// pinned driver from the server without installing into shared node_modules.
const { chromium } = require(require.resolve('playwright-core', { paths: [
  fileURLToPath(new URL('../../..', import.meta.url)),
  fileURLToPath(new URL('../../../../server', import.meta.url)),
] }));
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

describe.skipIf(!chrome)('overflow menu keyboard focus', () => {
  let browser;
  let fixture;
  let origin;
  beforeAll(async () => {
    // Each startup phase is bounded and cleaned up inside the hook (#10543).
    fixture = await startBrowserFixture({ name: 'overflow-chrome', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] }, viteConfig: temp => ({
      configFile: false,
      // Concurrent fixtures and linked worktrees must not replace each other's
      // optimized dependencies in the shared node_modules/.vite cache.
      cacheDir: join(temp, 'vite-cache'),
      // Pre-bundle only what this fixture renders, not the whole app's graph.
      optimizeDeps: { entries: ['src/components/ui/OverflowMenu.jsx'], include: ['react', 'react-dom/client'] },
      root: fileURLToPath(new URL('../../..', import.meta.url)),
      plugins: [react(), {
        name: 'overflow-browser-fixture',
        resolveId(id) { if (id === '/overflow-fixture.jsx') return '\0overflow-fixture.jsx'; },
        load(id) {
          if (id !== '\0overflow-fixture.jsx') return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import OverflowMenu from '/src/components/ui/OverflowMenu.jsx';
            import '/src/index.css';
            createRoot(document.getElementById('root')).render(
              React.createElement(React.Fragment, null,
                React.createElement('button', { id: 'before' }, 'Before'),
                React.createElement(OverflowMenu, {
                  label: 'More actions',
                  items: [
                    { id: 'disabled', label: 'Disabled', disabled: true },
                    { id: 'archive', label: 'Archive' },
                    { id: 'delete', label: 'Delete' },
                  ],
                }),
                React.createElement('button', { id: 'after' }, 'After'))
            );
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/overflow-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/overflow-test',
              '<div id="root"></div><script type="module" src="/overflow-fixture.jsx"></script>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    }) });
    ({ browser, origin } = fixture);
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each(['ArrowDown', 'Enter'])('enters after %s, keeps focus on reflow, and exits relative to the trigger', async (key) => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}overflow-test`);
      const trigger = page.getByRole('button', { name: 'More actions' });
      const focused = async (locator) => expect(await locator.evaluate(el => el === document.activeElement)).toBe(true);
      await trigger.focus();
      await page.keyboard.press(key);
      await page.getByRole('menu').waitFor();
      await focused(page.getByRole('menuitem', { name: 'Archive' }));
      await page.keyboard.press('ArrowDown');
      await focused(page.getByRole('menuitem', { name: 'Delete' }));

      const previousTop = await page.getByRole('menu').evaluate(el => el.style.top);
      await page.evaluate(() => {
        document.getElementById('root').style.paddingTop = '80px';
        window.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(top => document.querySelector('[role="menu"]').style.top !== top, previousTop);
      await focused(page.getByRole('menuitem', { name: 'Delete' }));
      await page.keyboard.press('ArrowDown');
      await focused(page.getByRole('menuitem', { name: 'Archive' }));
      await page.keyboard.press('ArrowUp');
      await focused(page.getByRole('menuitem', { name: 'Delete' }));
      await page.keyboard.press('Escape');
      expect(await page.getByRole('menu').count()).toBe(0);
      await focused(trigger);

      await page.keyboard.press(key);
      await page.getByRole('menu').waitFor();
      await page.keyboard.press('Tab');
      expect(await page.getByRole('menu').count()).toBe(0);
      await focused(page.locator('#after'));
      await trigger.focus();
      await page.keyboard.press(key);
      await page.getByRole('menu').waitFor();
      await page.keyboard.press('Shift+Tab');
      expect(await page.getByRole('menu').count()).toBe(0);
      await focused(page.locator('#before'));
    } finally {
      await page.close();
    }
  }, 60000);
});
