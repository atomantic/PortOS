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

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [
  fileURLToPath(new URL('../../..', import.meta.url)),
  fileURLToPath(new URL('../../../../server', import.meta.url)),
] }));
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

describe.skipIf(!chrome)('help above glass cards and clipped scrollers', () => {
  let server;
  let browser;
  let browserTemp;
  let origin;
  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL('../../..', import.meta.url)),
      plugins: [react(), {
        name: 'tooltip-browser-fixture',
        resolveId(id) { if (id === '/tooltip-fixture.jsx') return '\0tooltip-fixture.jsx'; },
        load(id) {
          if (id !== '\0tooltip-fixture.jsx') return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import InfoTooltip from '/src/components/ui/InfoTooltip.jsx';
            import { THEMES } from '/src/themes/portosThemes.js';
            import '/src/index.css';
            document.documentElement.dataset.portTheme = 'lumen-glass';
            for (const [name, value] of Object.entries({ ...THEMES['lumen-glass'].colors, ...THEMES['lumen-glass'].tokens })) {
              document.documentElement.style.setProperty(name, value);
            }
            createRoot(document.getElementById('root')).render(
              React.createElement('main', { style: { padding: 24 } },
                React.createElement('div', { id: 'scroller', style: { height: 210, overflow: 'auto' } },
                  React.createElement('section', { id: 'summary', className: 'bg-port-card border rounded-lg', style: { padding: 16 } },
                    'Summary ',
                    React.createElement(InfoTooltip, { label: 'Quality help', placement: 'below', align: 'start', width: 320 },
                      Array.from({ length: 80 }, (_, i) => React.createElement('p', { key: i }, 'Synthetic help line ' + i + ': readable assessment details.'))),
                    React.createElement('button', { id: 'next', type: 'button' }, 'Next control')),
                  React.createElement('section', { id: 'history', className: 'bg-port-card border rounded-lg', style: { height: 400 } }, 'History'),
                  React.createElement('section', { className: 'bg-port-card border rounded-lg', style: { height: 200 } }, 'Categories')),
                React.createElement('button', { id: 'outside', type: 'button' }, 'Outside'))
            );
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/tooltip-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/tooltip-test',
              '<div id="root"></div><script type="module" src="/tooltip-fixture.jsx"></script>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    origin = server.resolvedUrls.local[0];
    browserTemp = await mkdtemp(join(tmpdir(), 'tooltip-chrome-'));
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

  it.each([{ width: 1512, height: 824 }, { width: 756, height: 412 }, { width: 320, height: 568 }])(
    'keeps help readable, inside the viewport, and keyboard scrollable at $width x $height',
    async (viewport) => {
      const page = await browser.newPage({ viewport });
      try {
        await page.goto(`${origin}tooltip-test`);
        const trigger = page.getByRole('button', { name: 'Quality help' });
        await trigger.focus();
        const panel = page.getByRole('tooltip');
        await panel.waitFor();
        expect(await page.locator('#summary').evaluate(el => getComputedStyle(el).backdropFilter)).toMatch(/blur\(/);
        expect(await trigger.getAttribute('aria-describedby')).toBe(await panel.getAttribute('id'));
        const geometry = await panel.evaluate(el => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + 20, r.top + 80);
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
            aboveCards: el.contains(hit), scrollable: el.scrollHeight > el.clientHeight,
            scrollerBottom: document.querySelector('#scroller').getBoundingClientRect().bottom };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(8);
        expect(geometry.right).toBeLessThanOrEqual(viewport.width - 8);
        expect(geometry.top).toBeGreaterThanOrEqual(8);
        expect(geometry.bottom).toBeLessThanOrEqual(viewport.height - 8);
        expect(geometry.bottom).toBeGreaterThan(geometry.scrollerBottom);
        expect(geometry.aboveCards).toBe(true);
        expect(geometry.scrollable).toBe(true);
        expect(await panel.evaluate(el => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba/);
        await page.locator('#scroller').evaluate(el => { el.scrollTop = 10; });
        await page.waitForFunction(() => {
          const trigger = document.querySelector('button[aria-label="Quality help"]').getBoundingClientRect();
          const panel = document.querySelector('[role="tooltip"]').getBoundingClientRect();
          return Math.abs(panel.top - trigger.bottom - 6) < 1;
        });
        await page.keyboard.press('Tab');
        expect(await panel.evaluate(el => el === document.activeElement)).toBe(true);
        await page.keyboard.press('End');
        await page.waitForFunction(() => document.querySelector('[role="tooltip"]').scrollTop > 0);
        await page.keyboard.press('Shift+Tab');
        expect(await trigger.evaluate(el => el === document.activeElement)).toBe(true);
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        expect(await page.locator('#next').evaluate(el => el === document.activeElement)).toBe(true);
        await trigger.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Escape');
        expect(await panel.count()).toBe(0);
        expect(await trigger.evaluate(el => el === document.activeElement)).toBe(true);
        expect(await trigger.getAttribute('aria-describedby')).toBeNull();
      } finally {
        await page.close();
      }
    }, 60000,
  );

  it('preserves pointer crossing, outside dismissal, and click pinning', async () => {
    const page = await browser.newPage({ viewport: { width: 1512, height: 824 } });
    try {
      await page.goto(`${origin}tooltip-test`);
      const trigger = page.getByRole('button', { name: 'Quality help' });
      const panel = page.getByRole('tooltip');
      await trigger.hover();
      await panel.hover();
      expect(await panel.isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Outside', exact: true }).hover();
      await panel.waitFor({ state: 'detached' });
      await trigger.click();
      await page.getByRole('button', { name: 'Outside', exact: true }).hover();
      await page.locator('#next').focus();
      expect(await panel.isVisible()).toBe(true);
      await panel.click();
      expect(await panel.isVisible()).toBe(true);
      await trigger.click();
      expect(await panel.count()).toBe(0);
      await trigger.click();
      await page.getByRole('button', { name: 'Outside', exact: true }).click();
      expect(await panel.count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60000);
});
