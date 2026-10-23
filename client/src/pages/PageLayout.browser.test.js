// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../test/browserFixture.js';
import { resolveTestChrome } from '../../../scripts/lib/testChrome.js';

const chrome = resolveTestChrome();
const root = fileURLToPath(new URL('../..', import.meta.url));
const usage = {
  totalSessions: 12, totalMessages: 120, totalTokens: { input: 12000, output: 4000 },
  last7Days: [], hourlyActivity: Array(24).fill(0), topProviders: [], topModels: [],
  report: { providers: [{ id: 'example', name: 'Example provider', sessions: 12, tokensIn: 12000, tokensOut: 4000, estimatedCost: 0.12, source: 'measured', models: [{ model: 'example-long-model-name-for-card-layout-verification', sessions: 12, tokensIn: 12000, tokensOut: 4000, estimatedCost: 0.12 }] }], totals: { estimatedCost: 0, source: 'estimate' } },
};
const responses = {
  '/cos': { running: false, config: { avatarStyle: 'svg' }, stats: {} },
  '/cos/tasks': { user: [], cos: [] },
  '/cos/agents': [],
  '/cos/agents/completed': { items: [], total: 0, nextCursor: null },
  '/cos/agents/feedback/pending': { agents: [], count: 0 },
  '/cos/health': { issues: [] },
  '/cos/activity/today': { isRunning: false, stats: { completed: 0 } },
  '/cos/learning': null,
  '/cos/learning/durations': null,
  '/providers/status': { providers: {} },
  '/cos/learning/summary': null,
  '/cos/budget-usage': { usage: {} },
  '/cos/insights': { insights: [] },
  '/avatar/rigged': { records: [] },
  '/providers': { providers: [] },
  '/apps': [],
  '/instances': { peers: [] },
  '/settings/features': { features: [] },
  '/code-animation/jobs': { items: [], total: 0, counts: { running: 0, completed: 0 }, nextCursor: null },
  '/usage': usage,
  '/usage/backfill': { status: 'idle' },
  '/usage/rolling-cost': { windowDays: 30, instanceCount: 1, series: [], points: [] },
  '/usage/claude-code/models': { filesScanned: 0, models: [], totals: {} },
  '/usage/providers': { providers: ['claude', 'agy', 'codex', 'grok'].map(family => ({
    family, label: `Example ${family}`, supported: true,
    limits: [{ key: 'week', label: 'Weekly usage', percentUsed: 40, percentRemaining: 60 }],
  })) },
};

// Real route components and Tailwind, synthetic API only. Layout's classification
// test covers its main; this models the available space beside the global rail.
describe.skipIf(!chrome)('routed page chrome and content geometry', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({ name: 'page-layout', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio', '--no-sandbox'] },
      // Cold compilation belongs to the fixture's bounded warmup phase, not
      // a geometry assertion's interaction timeout.
      warmup: async (page, origin) => {
        await page.route('**/api/**', route => {
          const key = new URL(route.request().url()).pathname.slice(4);
          return route.fulfill({ json: Object.hasOwn(responses, key) ? responses[key] : {} });
        });
        await page.goto(`${origin}layout-test?route=/code-animation/gallery`, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').waitFor();
      },
      viteConfig: temp => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: {
          entries: ['src/pages/ChiefOfStaff.jsx', 'src/pages/CodeAnimation.jsx', 'src/pages/UsagePage.jsx', 'src/pages/SystemHealthPage.jsx'],
          include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react-router', 'lucide-react'],
        },
        plugins: [react(), {
          name: 'page-layout-fixture', enforce: 'pre',
          resolveId(id) {
            if (id === '/layout-fixture.jsx') return '\0layout-fixture.jsx';
            if (/\/services\/socket(?:\.js)?$/.test(id)) return '\0layout-socket';
          },
          load(id) {
            if (id === '\0layout-socket') return 'export default { connected: false, on() {}, off() {}, emit() {} };';
            if (id !== '\0layout-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter, Routes, Route } from 'react-router';
              import ChiefOfStaff from '/src/pages/ChiefOfStaff.jsx';
              import CodeAnimation from '/src/pages/CodeAnimation.jsx';
              import UsagePage from '/src/pages/UsagePage.jsx';
              import SystemHealthPage from '/src/pages/SystemHealthPage.jsx';
              import { isFullWidthRoute } from '/src/lib/layoutRoutes.js';
              import '/src/index.css';
              const path = new URLSearchParams(location.search).get('route') || '/cos/agents';
              const rail = innerWidth >= 768 ? 256 : 0;
              const h = React.createElement;
              createRoot(document.getElementById('root')).render(
                h(MemoryRouter, { initialEntries: [path] },
                  h('main', { id: 'fixture-main', style: {height: '100dvh', marginLeft: rail, width: 'calc(100% - ' + rail + 'px)'},
                    className: isFullWidthRoute(path) ? 'relative overflow-hidden' : 'overflow-auto p-4 md:p-6' },
                    h(Routes, null,
                      h(Route, { path: '/cos/:tab', element: h(ChiefOfStaff) }),
                      h(Route, { path: '/code-animation/gallery', element: h(CodeAnimation) }),
                      h(Route, { path: '/devtools/usage', element: h(UsagePage) }),
                      h(Route, { path: '/system-resources/:tab', element: h(SystemHealthPage) })))));

            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/layout-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/layout-test', '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/layout-fixture.jsx"></script>'));
            });
          },
        }], server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each([1440, 1024, 390, 320])('keeps chrome flush and card edges inside the scroll body at %i px', async width => {
    const page = await fixture.browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(fixture.origin).origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const key = url.pathname.slice(4);
      return route.fulfill({ json: Object.hasOwn(responses, key) ? responses[key] : {} });
    });
    try {
      for (const path of ['/code-animation/gallery', '/cos/agents', '/cos/health', '/system-resources/storage', '/devtools/usage']) {
        await page.goto(`${fixture.origin}layout-test?route=${encodeURIComponent(path)}`, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').waitFor();
        if (path.startsWith('/cos/')) await page.getByRole('tabpanel').waitFor();
        if (path === '/code-animation/gallery') await page.getByText('Animations you generate in Fast HTML appear here.').waitFor();
        if (path === '/cos/health') await page.getByText('No issues detected', { exact: true }).waitFor();
        if (path === '/cos/agents') await page.getByRole('heading', { name: 'Active Agents', exact: true }).waitFor();
        if (path === '/devtools/usage') await page.getByText('Example claude', { exact: true }).first().waitFor();
        expect(await page.getByRole('alert').count(), path).toBe(0);
        const geometry = await page.locator('main').evaluate(main => {
          const shell = main.firstElementChild;
          const [header, nav, body] = shell.children;
          const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
          return {
            main: rect(main), header: rect(header), nav: rect(nav), body: rect(body),
            mainWidth: main.clientWidth, mainScrollWidth: main.scrollWidth,
            bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth,
            h1s: main.querySelectorAll('h1').length,
          };
        });
        expect(geometry.h1s, path).toBe(1);
        expect(geometry.header.x, path).toBe(geometry.main.x);
        expect(geometry.header.y, path).toBe(geometry.main.y);
        expect(geometry.header.right, path).toBe(geometry.main.right);
        expect(geometry.nav.x, path).toBe(geometry.main.x);
        expect(geometry.nav.y, path).toBe(geometry.header.bottom);
        expect(geometry.nav.right, path).toBe(geometry.main.right);
        expect(geometry.body.bottom, path).toBeLessThanOrEqual(geometry.main.bottom + 1);
        expect(geometry.mainScrollWidth, path).toBeLessThanOrEqual(geometry.mainWidth + 1);
        expect(geometry.bodyScrollWidth, path).toBeLessThanOrEqual(geometry.bodyWidth + 1);
        if (path === '/devtools/usage') {
          const edges = await page.evaluate(() => {
            const body = document.querySelector('main').firstElementChild.lastElementChild;
            const style = getComputedStyle(body);
            const r = body.getBoundingClientRect();
            const cards = [...body.querySelectorAll('.bg-port-card')].filter(el => el.getBoundingClientRect().width > 0);
            return { padding: [style.paddingLeft, style.paddingRight], count: cards.length,
              outside: cards.filter(el => { const c = el.getBoundingClientRect(); return c.x < r.x + parseFloat(style.paddingLeft) - 1 || c.right > r.x + body.clientWidth - parseFloat(style.paddingRight) + 1; }).map(el => el.textContent.slice(0, 80)),
              unbalanced: cards.filter(el => { const s = getComputedStyle(el); return s.paddingLeft !== s.paddingRight; }).length,
              overflowing: cards.filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent.slice(0, 80)),
            };
          });
          expect(edges.padding).toEqual(width < 768 ? ['16px', '16px'] : ['24px', '24px']);
          expect(edges.count).toBeGreaterThan(5);
          expect(edges.outside).toEqual([]);
          expect(edges.unbalanced).toBe(0);
          expect(edges.overflowing).toEqual([]);
          const body = page.locator('main > div > div').last();
          const before = await page.locator('h1').boundingBox();
          await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
          expect((await page.locator('h1').boundingBox()).y).toBe(before.y);
          expect(await body.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
          await body.evaluate(el => { el.scrollTop = 0; });
        }
        if (process.env.PORTOS_LAYOUT_SCREENSHOTS) {
          await mkdir(process.env.PORTOS_LAYOUT_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: join(process.env.PORTOS_LAYOUT_SCREENSHOTS, `${path.replaceAll('/', '_')}-${width}.png`) });
        }
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60000);
});
