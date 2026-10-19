// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../../scripts/lib/testChrome.js';

const auditCdp = process.env.PORTOS_AUDIT_CDP;
const chrome = resolveTestChrome();

// Happy DOM cannot expose hover-gated opacity or real touch geometry. Exercise
// the actual row actions and stylesheet, without calling the running instance.
describe.skipIf(!chrome && !auditCdp)('run actions without hover', () => {
  let fixture;
  let page;
  let cdp;
  const errors = [];
  const failedRequests = [];
  const pendingRequests = new Map();

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'runs-touch', createServer,
      chromium: auditCdp ? { launch: () => chromium.connectOverCDP(auditCdp) } : chromium,
      launchOptions: { executablePath: chrome },
      viteConfig: temp => ({
        configFile: false,
        root: fileURLToPath(new URL('../../../..', import.meta.url)),
        cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: {
          entries: ['src/components/cos/tabs/RunsTab.jsx'],
          include: ['react', 'react-dom/client', 'react-router', 'lucide-react'],
        },
        plugins: [react(), {
          name: 'runs-touch-fixture',
          enforce: 'pre',
          resolveId(id, importer) {
            if (id === '/runs-fixture.jsx') return '\0runs-fixture.jsx';
            if (importer?.endsWith('/RunsTab.jsx')) {
              if (id === '../../../services/api') return '\0runs-api';
              if (id === '../../ui/ProcessLogModal') return '\0runs-log-modal';
            }
          },
          load(id) {
            if (id === '\0runs-log-modal') return 'export default function ProcessLogModal() { return null; }';
            if (id === '\0runs-api') return `
              const running = { id: 'running-example', source: 'devtools', success: null,
                providerName: 'Example provider', model: 'sample-model', prompt: 'Example running task',
                startTime: '2026-01-01T12:00:00Z' };
              const failed = { ...running, id: 'failed-example', success: false,
                prompt: 'Example failed task', error: 'Example failure', exitCode: 1 };
              let stopped = false;
              window.runsFixture = { loads: 0, stops: [] };
              export async function getRuns() {
                window.runsFixture.loads++;
                return { runs: [stopped ? { ...running, success: false, exitCode: 143 } : running, failed] };
              }
              export function stopRun(id) {
                window.runsFixture.stops.push(id);
                return new Promise(resolve => {
                  window.runsFixture.finishStop = () => { stopped = true; resolve(); };
                });
              }
              export async function getRunPrompt() { return 'Example prompt'; }
              export async function getRunOutput() { return 'Example output'; }
              export async function deleteRun() {}
              export async function deleteFailedRuns() {}
            `;
            if (id !== '\0runs-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter } from 'react-router';
              import RunsTab from '/src/components/cos/tabs/RunsTab.jsx';
              import '/src/index.css';
              createRoot(document.getElementById('root')).render(
                React.createElement(MemoryRouter, null, React.createElement(RunsTab))
              );
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/runs-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/runs-test',
                '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="padding:16px"></div><script type="module" src="/runs-fixture.jsx"></script>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
    if (auditCdp) {
      // Never create, activate, or close a page in the shared audit browser.
      for (const candidate of fixture.browser.contexts().flatMap(context => context.pages())) {
        if (await candidate.evaluate(() => window.name === 'portos-ui-quality-audit')) {
          page = candidate;
          break;
        }
      }
      if (!page) throw new Error('Dedicated PortOS audit target is missing');
    } else {
      page = await fixture.browser.newPage();
    }
    page.setDefaultTimeout(5000);
    const fixturePath = url => {
      const parsed = new URL(url);
      return parsed.origin === new URL(fixture.origin).origin ? parsed.pathname : null;
    };
    page.on('pageerror', error => {
      if (fixturePath(page.url())) errors.push(error.message);
    });
    page.on('request', request => {
      const path = fixturePath(request.url());
      if (path) pendingRequests.set(request, { path, started: Date.now() });
    });
    page.on('requestfinished', request => pendingRequests.delete(request));
    page.on('requestfailed', request => {
      pendingRequests.delete(request);
      const path = fixturePath(request.url());
      if (path) failedRequests.push({ path, failure: request.failure()?.errorText });
    });
    page.on('response', response => {
      const path = fixturePath(response.url());
      if (path && response.status() >= 400) failedRequests.push({ path, status: response.status() });
    });
    cdp = await page.context().newCDPSession(page);
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(async () => {
    await (async () => {
      if (!auditCdp || !page) return;
      await cdp?.send('Emulation.clearDeviceMetricsOverride');
      await cdp?.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await page.evaluate(() => {
        window.name = 'portos-ui-quality-audit';
        document.title = 'PortOS UI Audit';
      });
    })().finally(() => fixture?.close());
  });

  it.each([[360, 800, true], [768, 1024, true], [1440, 900, false]])(
    'keeps row actions visible and reachable at %ix%i (touch=%s)', async (width, height, touch) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch });
      // Direct CDP navigation and input leave the managed target in background.
      const url = `${fixture.origin}runs-test?width=${width}`;
      await cdp.send('Page.navigate', { url });
      await page.waitForURL(url, { timeout: 20000 });
      await page.getByTestId('stop-run-running-example').waitFor({ timeout: 20000 }).catch(async error => {
        // Cold module failures and interference with the shared audit target
        // must be distinguishable from an absent action. No live page content
        // or unrelated request URLs belong in these diagnostics.
        const urlMatches = page.url() === url;
        const state = urlMatches ? await page.evaluate(() => ({
          readyState: document.readyState,
          fixtureLoaded: Boolean(window.runsFixture),
          loads: window.runsFixture?.loads ?? null,
          rootChildren: document.getElementById('root')?.childElementCount ?? null,
          stopCount: document.querySelectorAll('[data-testid="stop-run-running-example"]').length,
        })).catch(() => ({ contextAvailable: false })) : {};
        const pending = [...pendingRequests.values()].map(({ path, started }) => ({ path, elapsedMs: Date.now() - started }));
        throw new Error(`Runs fixture did not render: ${JSON.stringify({ urlMatches, ...state, errors, failedRequests, pending })}`, { cause: error });
      });
      if (auditCdp) await page.evaluate(() => { window.name = 'portos-ui-quality-audit'; });
      expect(page.url(), 'the shared audit target must remain on this fixture').toBe(url);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
      expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(touch);

      for (const [label, count] of [['Stop run', 1], ['Resume run', 1], ['View system logs', 1], ['Delete run', 2]]) {
        const actions = await page.getByRole('button', { name: label, exact: true }).all();
        expect(actions.length, label).toBe(count);
        for (const action of actions) {
          const geometry = await action.evaluate(el => {
            const box = el.getBoundingClientRect();
            return { x: box.x, right: box.right, y: box.y, bottom: box.bottom,
              width: box.width, height: box.height, opacity: getComputedStyle(el).opacity,
              reachable: el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
          });
          expect(geometry.opacity, label).toBe('1');
          expect(geometry.width, label).toBeGreaterThanOrEqual(44);
          expect(geometry.height, label).toBeGreaterThanOrEqual(44);
          expect(geometry.x, label).toBeGreaterThanOrEqual(0);
          expect(geometry.right, label).toBeLessThanOrEqual(width);
          expect(geometry.y, label).toBeGreaterThanOrEqual(0);
          expect(geometry.bottom, label).toBeLessThanOrEqual(height);
          expect(geometry.reachable, label).toBe(true);
        }
      }

      if (width === 360) {
        const stop = page.getByRole('button', { name: 'Stop run', exact: true });
        const box = await stop.boundingBox();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForFunction(() => window.runsFixture.stops.length === 1);
        expect(await page.evaluate(() => window.runsFixture.stops)).toEqual(['running-example']);
        expect(await page.getByRole('button', { name: 'Stopping run', exact: true }).isDisabled()).toBe(true);
        // The pending action must not bubble into the expandable row.
        expect(await page.getByRole('button', { name: 'Collapse run details', exact: true }).count()).toBe(0);
        await page.evaluate(() => window.runsFixture.finishStop());
        await page.getByTestId('resume-run-running-example').waitFor();
        expect(await page.getByTestId('stop-run-running-example').count()).toBe(0);
        expect(await page.evaluate(() => window.runsFixture.loads)).toBe(2);
      }
      expect(page.url(), 'the shared audit target must remain on this fixture').toBe(url);
      expect(errors).toEqual([]);
    }, 30000,
  );
});
