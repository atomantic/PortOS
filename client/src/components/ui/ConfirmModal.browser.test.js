// @vitest-environment node
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTestChrome } from '../../../../scripts/lib/testChrome.js';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';

const chrome = resolveTestChrome();

describe.skipIf(!chrome)('confirmation layout inside a glass card', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'confirm-modal-layout',
      createServer,
      chromium,
      launchOptions: { executablePath: chrome },
      viteConfig: temp => ({
        configFile: false,
        root: fileURLToPath(new URL('../../..', import.meta.url)),
        cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/ui/ConfirmModal.jsx'], include: ['react', 'react-dom/client'] },
        server: { host: '127.0.0.1', port: 0 },
        plugins: [react(), {
          name: 'confirm-modal-fixture',
          resolveId(id) { if (id === '/confirm-fixture.jsx') return '\0confirm-fixture.jsx'; },
          load(id) {
            if (id !== '\0confirm-fixture.jsx') return;
            return `
              import React, { useState } from 'react';
              import { createRoot } from 'react-dom/client';
              import ConfirmModal from '/src/components/ui/ConfirmModal.jsx';
              import { THEMES } from '/src/themes/portosThemes.js';
              import '/src/index.css';

              const theme = THEMES['lumen-glass'];
              document.documentElement.dataset.portTheme = 'lumen-glass';
              for (const [name, value] of Object.entries({ ...theme.colors, ...theme.tokens })) {
                document.documentElement.style.setProperty(name, value);
              }

              const h = React.createElement;
              function App() {
                const [open, setOpen] = useState(false);
                const [confirmed, setConfirmed] = useState(false);
                return h('main', { style: { minHeight: 1200, padding: 24 } },
                  h('section', { id: 'glass-card', className: 'bg-port-card border rounded-lg', style: { padding: 16 } },
                    h('button', { type: 'button', onClick: () => setOpen(true) }, 'Open confirmation'),
                    h(ConfirmModal, {
                      open, onClose: () => setOpen(false), titleId: 'fixture-title',
                      title: 'Remove draft', confirmLabel: 'Remove',
                      onConfirm: () => { setConfirmed(true); setOpen(false); },
                    }, h('div', { style: { height: 600 } }, 'Removal details'))),
                  confirmed && h('p', null, 'Draft removed'));
              }

              createRoot(document.getElementById('root')).render(h(App));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/confirm-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/confirm-test',
                '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/confirm-fixture.jsx"></script>'));
            });
          },
        }],
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(() => fixture?.close());

  it('keeps the actions above the fold and scrolls only the details', async () => {
    const viewport = { width: 320, height: 300 };
    const page = await fixture.browser.newPage({ viewport });
    try {
      await page.goto(`${fixture.origin}confirm-test`);
      await page.getByRole('button', { name: 'Open confirmation' }).click();
      expect(await page.locator('#glass-card').evaluate(card => getComputedStyle(card).backdropFilter)).toMatch(/blur\(/);

      const dialog = page.getByRole('dialog', { name: 'Remove draft' });
      await dialog.waitFor();
      expect(await dialog.evaluate(panel => panel.parentElement.parentElement === document.body)).toBe(true);
      expect(await page.locator('body').evaluate(body => getComputedStyle(body).overflow)).toBe('hidden');

      const { x, y, width, height } = await dialog.boundingBox();
      expect(x).toBeGreaterThanOrEqual(16);
      expect(x + width).toBeLessThanOrEqual(viewport.width - 16);
      expect(y).toBeGreaterThanOrEqual(16);
      expect(y + height).toBeLessThanOrEqual(viewport.height - 16);

      const confirm = dialog.getByRole('button', { name: 'Remove', exact: true });
      const actionsReachable = await dialog.getByRole('button').evaluateAll(buttons =>
        buttons.every(button => {
          const rect = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }));
      expect(actionsReachable).toBe(true);

      const details = dialog.getByText('Removal details').locator('..');
      await details.hover();
      await page.mouse.wheel(0, 200);
      await expect.poll(() => details.evaluate(body => body.scrollTop)).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      await confirm.click();
      await page.getByText('Draft removed').waitFor();
      expect(await dialog.count()).toBe(0);
      expect(await page.locator('body').evaluate(body => body.style.overflow)).toBe('');
    } finally {
      await page.close();
    }
  }, 30000);
});
