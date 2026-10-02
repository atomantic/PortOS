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
// Prefer the client dev dependency; linked worktrees can also use the same
// pinned driver from the server without installing into shared node_modules.
const { chromium } = require(require.resolve('playwright-core', { paths: [
  fileURLToPath(new URL('../..', import.meta.url)),
  fileURLToPath(new URL('../../../server', import.meta.url)),
] }));
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

describe.skipIf(!chrome)('command palette viewport and keyboard layout', () => {
  let server;
  let browser;
  let browserTemp;
  let origin;
  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL('../..', import.meta.url)),
      plugins: [react(), {
        name: 'palette-browser-fixture',
        resolveId(id) { if (id === '/palette-fixture.jsx') return '\0palette-fixture.jsx'; },
        load(id) {
          if (id !== '\0palette-fixture.jsx') return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { MemoryRouter, useLocation } from 'react-router';
            import CmdKSearch from '/src/components/CmdKSearch.jsx';
            import '/src/index.css';
            function Probe() { return React.createElement('output', null, useLocation().pathname); }
            createRoot(document.getElementById('root')).render(
              React.createElement(MemoryRouter, null, React.createElement('button', { id: 'opener' }, 'Open'), React.createElement(CmdKSearch), React.createElement(Probe))
            );
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/palette-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/palette-test',
              '<div id="root"></div><script type="module" src="/palette-fixture.jsx"></script>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    origin = server.resolvedUrls.local[0];
    browserTemp = await mkdtemp(join(tmpdir(), 'palette-chrome-'));
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

  it.each([{ width: 756, height: 412 }, { width: 667, height: 320 }, { width: 1440, height: 1000 }])(
    'keeps active results visible at $width x $height and preserves dispatch and capture',
    async (viewport) => {
      const page = await browser.newPage({ viewport });
      try {
        await page.route('**/api/**', route => {
          const path = new URL(route.request().url()).pathname;
          const body = path === '/api/palette/manifest'
            ? { nav: Array.from({ length: 40 }, (_, i) => ({
              id: `nav.example.${i}`, path: `/example/${i}`, label: `Example ${String(i).padStart(2, '0')}`,
              section: 'Example', aliases: [], keywords: [],
            })), actions: [{ id: 'brain_capture', label: 'Capture to Brain', section: 'Brain' }] }
            : { features: [], layouts: [], sources: [], items: [] };
          return route.fulfill({ json: body });
        });
        await page.goto(`${origin}palette-test`);
        await page.locator('#opener').focus();
        await page.keyboard.press('ControlOrMeta+k');
        const input = page.getByRole('combobox');
        const searchResponse = page.waitForResponse(response => response.url().includes('/api/search'));
        const catalogResponse = page.waitForResponse(response => response.url().includes('/api/catalog/ingredients'));
        await input.fill('Example');
        await Promise.all([searchResponse, catalogResponse]);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.getByRole('option').first().waitFor();
        const count = await page.getByRole('option').count();
        expect(count).toBeGreaterThan(6);
        for (let i = 0; i < count; i += 1) {
          if (i) {
            const previous = await input.getAttribute('aria-activedescendant');
            await page.keyboard.press('ArrowDown');
            await page.waitForFunction(id => document.querySelector('[role="combobox"]').getAttribute('aria-activedescendant') !== id, previous);
          }
          await page.waitForFunction(() => {
            const input = document.querySelector('[role="combobox"]');
            const active = document.getElementById(input.getAttribute('aria-activedescendant')).getBoundingClientRect();
            const list = document.querySelector('[role="listbox"]').parentElement.getBoundingClientRect();
            return active.top >= list.top - 1 && active.bottom <= list.bottom + 1;
          });
          const geometry = await page.getByRole('dialog').evaluate(dialog => {
            const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
            const list = dialog.querySelector('[role="listbox"]').parentElement;
            const active = document.getElementById(dialog.querySelector('[role="combobox"]').getAttribute('aria-activedescendant'));
            return { panel: rect(dialog), header: rect(dialog.firstElementChild), footer: rect(dialog.lastElementChild),
              list: rect(list), active: rect(active), overflow: list.scrollHeight > list.clientHeight };
          });
          for (const rect of [geometry.panel, geometry.header, geometry.footer, geometry.list]) {
            expect(rect.top).toBeGreaterThanOrEqual(0);
            expect(rect.bottom).toBeLessThanOrEqual(viewport.height);
          }
          expect(geometry.active.top).toBeGreaterThanOrEqual(geometry.list.top - 1);
          expect(geometry.active.bottom).toBeLessThanOrEqual(geometry.list.bottom + 1);
          expect(geometry.overflow).toBe(true);
          if (viewport.height === 1000) expect(geometry.list.height).toBe(384);
        }
        const selected = await input.getAttribute('aria-activedescendant');
        const destination = await page.locator('[role="option"]').evaluateAll((options, id) =>
          options.find(option => option.id === id).textContent.match(/\/example\/\d+/)[0], selected);
        await page.keyboard.press('Enter');
        await page.waitForFunction(path => document.querySelector('output').textContent === path, destination);
        await page.locator('#opener').focus();
        await page.keyboard.press('ControlOrMeta+k');
        await input.fill('Capture to Brain');
        await page.getByRole('option').first().click();
        const captureInput = page.getByLabel('Capture to Brain', { exact: true });
        await captureInput.fill('Synthetic thought');
        const capture = await page.getByRole('dialog').boundingBox();
        expect(capture.y + capture.height).toBeLessThanOrEqual(viewport.height);
        await page.waitForFunction(() => !document.querySelector('button[aria-label="Capture thought"]').disabled);
        // Exercise boundary wrapping; forward Tab from the initial input has
        // a separate shared-hook defect tracked in #9537.
        await page.keyboard.press('Shift+Tab');
        expect(await page.getByRole('button', { name: 'Capture thought' }).evaluate(el => el === document.activeElement)).toBe(true);
        await page.keyboard.press('Tab');
        expect(await captureInput.evaluate(el => el === document.activeElement)).toBe(true);
        await page.keyboard.press('Escape');
        await input.waitFor();
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.activeElement.id === 'opener');
      } finally {
        await page.close();
      }
    }, 60000,
  );
});
