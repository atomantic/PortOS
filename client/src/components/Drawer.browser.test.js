// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';

const auditCdp = process.env.PORTOS_AUDIT_CDP;
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

// Native :disabled includes inherited fieldset state and the first-legend
// exception. Happy DOM does not model it, so exercise actual browser tab order.
describe.skipIf(!chrome && !auditCdp)('Drawer native disabled-state focus boundaries', () => {
  let server;
  let browser;
  let page;
  let temporary;
  let origin;
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'drawer-focus-'));
    server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL('../..', import.meta.url)),
      cacheDir: join(temporary, 'vite-cache'),
      plugins: [react(), {
        name: 'drawer-focus-fixture',
        resolveId(id) { if (id === '/drawer-fixture.jsx') return '\0drawer-fixture.jsx'; },
        load(id) {
          if (id !== '\0drawer-fixture.jsx') return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import Drawer from '/src/components/Drawer.jsx';
            const h = React.createElement;
            function Editor() {
              const [open, setOpen] = useState(false);
              const [saving, setSaving] = useState(true);
              return h(React.Fragment, null,
                h('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open editor'),
                h('button', { id: 'outside' }, 'Outside'),
                h(Drawer, { open, title: 'Edit draft', onClose: () => setOpen(false) },
                  h('fieldset', { disabled: saving },
                    h('legend', null, 'Draft ', h('button', { id: 'cancel', onClick: () => setSaving(false) }, 'Cancel save')),
                    h('input', { 'aria-label': 'Title' }),
                    h('button', { id: 'save', tabIndex: 0 }, 'Save draft'))));
            }
            createRoot(document.getElementById('root')).render(h(Editor));
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/drawer-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/drawer-test',
              '<div id="root"></div><script type="module" src="/drawer-fixture.jsx"></script>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    origin = server.resolvedUrls.local[0];
    if (auditCdp) {
      // Live audits reuse only the dedicated background target. No new page,
      // context, activation, or browser shutdown is permitted in this mode.
      browser = await chromium.connectOverCDP(auditCdp);
      for (const candidate of browser.contexts().flatMap(context => context.pages())) {
        if (await candidate.evaluate(() => window.name === 'portos-ui-quality-audit')) {
          page = candidate;
          break;
        }
      }
      if (!page) throw new Error('Dedicated PortOS audit target is missing');
    } else {
      browser = await chromium.launch({ executablePath: chrome, headless: true,
        env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
      });
      page = await browser.newPage();
    }
  }, 60000);
  afterAll(async () => {
    if (auditCdp && page) {
      await page.evaluate(() => {
        window.name = 'portos-ui-quality-audit';
        document.title = 'PortOS UI Audit';
      });
    }
    // close() disconnects an attached CDP client; only a launched browser is
    // owned by this suite and terminated by Playwright.
    await browser?.close();
    await server?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  it('wraps around a saving form, preserves its legend control, and restores enabled tab stops', async () => {
    await page.goto(`${origin}drawer-test`);
    const opener = page.getByRole('button', { name: 'Open editor' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const close = page.getByRole('button', { name: 'Close settings' });
    const cancel = page.getByRole('button', { name: 'Cancel save' });
    const save = page.getByRole('button', { name: 'Save draft' });
    await close.waitFor();
    expect(await save.isDisabled()).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await cancel.evaluate(el => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await close.evaluate(el => el === document.activeElement)).toBe(true);

    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    expect(await save.isDisabled()).toBe(false);
    await page.keyboard.press('Tab');
    expect(await page.getByRole('textbox', { name: 'Title' }).evaluate(el => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await save.evaluate(el => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await close.evaluate(el => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await opener.evaluate(el => el === document.activeElement)).toBe(true);
  }, 30000);
});
