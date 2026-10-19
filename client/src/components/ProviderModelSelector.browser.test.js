// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../test/browserFixture.js';
import { resolveTestChrome } from '../../../scripts/lib/testChrome.js';

const chrome = resolveTestChrome();

const isFixtureRequest = (origin, route) => {
  const url = new URL(route.request().url());
  return url.origin === new URL(origin).origin && !/^\/(api|socket\.io)(\/|$)/.test(url.pathname);
};

// Real layout is the only way to prove the compact row reflows to its own
// container: a desktop viewport (where `sm:` is always on) hosting a ~265px
// schedule card is exactly the case jsdom cannot see (#11894).
describe.skipIf(!chrome)('ProviderModelSelector compact row reflows to its container (#11894)', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'provider-model-selector-compact', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: temp => ({
        configFile: false,
        cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/ProviderModelSelector.jsx'], include: ['react', 'react-dom/client'] },
        root: fileURLToPath(new URL('../..', import.meta.url)),
        plugins: [react(), {
          name: 'provider-model-selector-fixture',
          resolveId(id) { if (id === '/pms-fixture.jsx') return '\0pms-fixture.jsx'; },
          load(id) {
            if (id !== '\0pms-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import ProviderModelSelector from '/src/components/ProviderModelSelector.jsx';
              import '/src/index.css';
              const h = React.createElement;
              const providers = [{
                id: 'claude-code', name: 'Claude Code (CLI)', type: 'cli', command: 'claude',
                defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
                effortLevels: ['low', 'medium', 'high'],
              }];
              function Picker({ effort }) {
                const [model, setModel] = React.useState('claude-sonnet-4-6');
                const [level, setLevel] = React.useState('');
                return h(ProviderModelSelector, {
                  providers, selectedProviderId: 'claude-code', selectedModel: model,
                  availableModels: ['claude-sonnet-4-6', 'claude-opus-4-6'],
                  onProviderChange: () => {}, onModelChange: setModel,
                  emptyModelOption: 'Default model', alwaysShowModel: true, compose: false, compact: true,
                  ...(effort ? { effort: level, onEffortChange: setLevel } : {}),
                });
              }
              const host = (id, width, effort) => h('div', { id, style: { width, border: '1px solid #888', padding: 8, boxSizing: 'border-box', marginBottom: 12 } }, h(Picker, { effort }));
              createRoot(document.getElementById('root')).render(h('main', { style: { padding: 16 } },
                host('card-effort', 265, true), host('card-pair', 265, false),
                host('mid-effort', 420, true), host('wide-effort', 900, true), host('wide-pair', 520, false),
                host('tiny-effort', 110, true)));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/pms-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/pms-test',
                '<div id="root"></div><script type="module" src="/pms-fixture.jsx"></script>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(() => fixture?.close());

  // The viewport only has to be wide enough to hold the widest fixture host;
  // the narrow phone case is the 265px card, which wraps identically.
  it.each([
    { width: 1440, height: 900 }, { width: 1024, height: 768 },
  ])('wraps selects inside narrow hosts and keeps one row in wide hosts at $width x $height', async viewport => {
    const page = await fixture.browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => (isFixtureRequest(fixture.origin, route) ? route.continue() : route.abort()));
    try {
      await page.goto(`${fixture.origin}pms-test`);
      await page.locator('#card-effort select').first().waitFor();
      const hosts = await page.evaluate(() => {
        const ctx = document.createElement('canvas').getContext('2d');
        return Object.fromEntries([...document.querySelectorAll('main > div')].map(host => {
          const hostRect = host.getBoundingClientRect();
          const selects = [...host.querySelectorAll('select')].map(select => {
            const rect = select.getBoundingClientRect();
            const style = getComputedStyle(select);
            ctx.font = style.font;
            const text = select.selectedOptions[0].textContent;
            // 24px covers the native dropdown arrow Chrome reserves inside the control.
            const needed = ctx.measureText(text).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 24;
            return { top: Math.round(rect.top), left: rect.left, right: rect.right, width: rect.width, needed, text };
          });
          return [host.id, { left: hostRect.left, right: hostRect.right, selects }];
        }));
      });
      expect(errors).toEqual([]);

      // No host's selects escape it, whatever the width.
      for (const [id, host] of Object.entries(hosts)) {
        for (const select of host.selects) {
          expect(select.left, id).toBeGreaterThanOrEqual(host.left - 1);
          expect(select.right, id).toBeLessThanOrEqual(host.right + 1);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

      const tops = id => new Set(hosts[id].selects.map(select => select.top)).size;
      expect(hosts['card-effort'].selects).toHaveLength(3);
      expect(hosts['card-pair'].selects).toHaveLength(2);
      // The schedule-card case: full selected labels, one select per line.
      for (const id of ['card-effort', 'card-pair']) {
        for (const select of hosts[id].selects) expect(select.width, `${id}: ${select.text}`).toBeGreaterThanOrEqual(select.needed);
      }
      expect(tops('card-effort')).toBe(3);
      expect(tops('card-pair')).toBe(2);
      // Wide hosts keep the single-row toolbar layout, wherever the viewport sits.
      expect(tops('wide-effort')).toBe(1);
      expect(tops('wide-pair')).toBe(1);
      for (const select of hosts['wide-effort'].selects) expect(select.width).toBeGreaterThanOrEqual(select.needed);
      // A host between the two wraps only as far as it must.
      expect(tops('mid-effort')).toBeLessThan(3);
    } finally {
      await page.close();
    }
  }, 60000);
});
