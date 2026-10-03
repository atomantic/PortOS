// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { THEME_IDS } from '../themes/portosThemes.js';

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [
  fileURLToPath(new URL('../..', import.meta.url)),
  fileURLToPath(new URL('../../../server', import.meta.url)),
] }));
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

describe.skipIf(!chrome)('theme chooser in short viewports', () => {
  let server;
  let browser;
  let browserTemp;
  let origin;

  beforeAll(async () => {
    browserTemp = await mkdtemp(join(tmpdir(), 'theme-switcher-chrome-'));
    server = await createServer({
      configFile: false,
      cacheDir: join(browserTemp, 'vite-cache'),
      root: fileURLToPath(new URL('../..', import.meta.url)),
      plugins: [react(), {
        name: 'theme-switcher-browser-fixture',
        resolveId(id) { if (id === '/theme-switcher-fixture.jsx') return '\0theme-switcher-fixture.jsx'; },
        load(id) {
          if (id !== '\0theme-switcher-fixture.jsx') return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { ThemeProvider } from '/src/components/ThemeContext.jsx';
            import ThemeSwitcher from '/src/components/ThemeSwitcher.jsx';
            import '/src/index.css';
            createRoot(document.getElementById('root')).render(
              React.createElement(ThemeProvider, null,
                React.createElement(React.Fragment, null,
                  React.createElement('button', { id: 'before' }, 'Before'),
                  React.createElement('div', { id: 'trigger-row' }, React.createElement(ThemeSwitcher)),
                  React.createElement('button', { id: 'after' }, 'After')))
            );
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/theme-switcher-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/theme-switcher-test',
              '<div id="root"></div><script type="module" src="/theme-switcher-fixture.jsx"></script>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    origin = server.resolvedUrls.local[0];
    browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--mute-audio'],
      env: { ...process.env, TMPDIR: browserTemp, TMP: browserTemp, TEMP: browserTemp },
    });
  }, 60000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await server?.close();
      if (browserTemp) await rm(browserTemp, { recursive: true, force: true });
    }
  });

  it.each([{ width: 640, height: 400 }, { width: 360, height: 400 }, { width: 1280, height: 800 }])(
    'keeps selected and keyboard-focused themes visible at $width×$height', async ({ width, height }) => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.addInitScript(themeId => localStorage.setItem('portos-theme', themeId), THEME_IDS.at(-1));
        await page.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
        await page.goto(`${origin}theme-switcher-test`);
        await page.addStyleTag({ content: '#trigger-row{position:absolute;top:340px;left:16px}' });
        const trigger = page.getByRole('button', { name: /Switch theme/ });
        const menu = page.getByRole('menu', { name: 'Interface theme' });
        await trigger.focus();
        await page.keyboard.press('Enter');
        await menu.waitFor();
        const items = page.getByRole('menuitemradio');
        expect(await items.count()).toBe(THEME_IDS.length);
        expect(await items.last().getAttribute('aria-checked')).toBe('true');

        const expectFocusVisible = async () => {
          const bounds = await page.evaluate(() => {
            const menuElement = document.querySelector('[role="menu"]');
            const item = document.activeElement;
            const menuRect = menuElement.getBoundingClientRect();
            const itemRect = item.getBoundingClientRect();
            return {
              left: menuRect.left, top: menuRect.top, right: menuRect.right, bottom: menuRect.bottom,
              clientTop: menuElement.clientTop, clientHeight: menuElement.clientHeight,
              scrollHeight: menuElement.scrollHeight,
              itemTop: itemRect.top, itemBottom: itemRect.bottom,
              viewportWidth: innerWidth, viewportHeight: innerHeight,
            };
          });
          expect(bounds.left).toBeGreaterThanOrEqual(8);
          expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth - 8);
          expect(bounds.top).toBeGreaterThanOrEqual(8);
          expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight - 8);
          expect(bounds.scrollHeight).toBeGreaterThan(bounds.clientHeight);
          expect(bounds.itemTop).toBeGreaterThanOrEqual(bounds.top + bounds.clientTop);
          expect(bounds.itemBottom).toBeLessThanOrEqual(bounds.top + bounds.clientTop + bounds.clientHeight);
        };

        await expectFocusVisible();
        await page.keyboard.press('ArrowUp');
        await expectFocusVisible();
        await page.keyboard.press('Home');
        await expectFocusVisible();
        await page.keyboard.press('End');
        await expectFocusVisible();
        await page.keyboard.press('Escape');
        expect(await menu.count()).toBe(0);
        expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true);

        await page.keyboard.press('Enter');
        await page.getByRole('menu').waitFor();
        await page.keyboard.press('Tab');
        expect(await page.getByRole('menu').count()).toBe(0);
        expect(await page.locator('#after').evaluate(element => element === document.activeElement)).toBe(true);
      } finally {
        await page.close();
      }
    },
  );
});
