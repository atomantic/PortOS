// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { resolveTestChrome } from '../../scripts/lib/testChrome.js';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from './test/browserFixture.js';

const chrome = resolveTestChrome();
const message = 'Fixture render crash';
const fixtureModules = {
  './App': `
    import { createElement as h, Fragment } from 'react';
    import PageErrorBoundary from '/src/components/PageErrorBoundary.jsx';
    import ErrorBoundary from '/src/components/ErrorBoundary.jsx';
    const scenario = new URLSearchParams(location.search).get('scenario');
    function Crash() {
      throw new Error(scenario === 'stale' ? 'Failed to fetch dynamically imported module' : '${message}');
    }
    export default function App() {
      if (scenario === 'route') return h(Crash);
      if (scenario === 'null-fallback') return h(Fragment, null,
        h(ErrorBoundary, { fallback: null }, h(Crash)), h('h1', null, 'Canvas omitted'));
      if (scenario === 'on-error') return h(ErrorBoundary,
        { fallback: h('h1', null, 'Canvas unavailable'), onError() {} }, h(Crash));
      return h(PageErrorBoundary, null, h(Crash));
    }
  `,
  './components/ThemeContext': `
    export function ThemeProvider({ children }) {
      if (new URLSearchParams(location.search).get('scenario') === 'app') throw new Error('${message}');
      return children;
    }
  `,
  './components/DownloadManager': 'export default () => null;',
  './services/shellBootstrap.js': 'export const startShellBootstrap = () => {};',
  './services/apiSystem.js': 'export const getShellBootstrap = () => {};',
  './index.css': '',
};
const fixtureModulePrefix = '\0client-crash-fixture:';

describe.skipIf(!chrome)('React root crash reporting', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'client-crash-reporting', createServer, chromium,
      launchOptions: { executablePath: chrome },
      viteConfig: temp => ({
        configFile: false,
        cacheDir: join(temp, 'vite-cache'),
        root: fileURLToPath(new URL('..', import.meta.url)),
        optimizeDeps: { entries: ['src/main.jsx'] },
        server: { host: '127.0.0.1', port: 0 },
        plugins: [react(), {
          name: 'client-crash-fixture',
          enforce: 'pre',
          resolveId(id, importer) {
            if (importer?.endsWith('/src/main.jsx') && Object.hasOwn(fixtureModules, id)) return fixtureModulePrefix + id;
          },
          load(id) {
            if (id.startsWith(fixtureModulePrefix)) return fixtureModules[id.slice(fixtureModulePrefix.length)];
          },
          configureServer(vite) {
            vite.middlewares.use('/crash-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/crash-test',
                '<div id="root"></div><script type="module" src="/src/main.jsx"></script>'));
            });
          },
        }],
      }),
      warmup: async (page, url) => {
        await page.goto(`${url}crash-test?scenario=stale`);
        await page.getByRole('heading', { name: 'This page hit an error' }).waitFor();
      },
    });
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(() => fixture?.close());

  it.each([
    ['page', 'This page hit an error', true],
    ['route', 'PortOS could not load this page', true],
    ['app', 'Something went wrong', true],
    ['stale', 'This page hit an error', false],
    ['null-fallback', 'Canvas omitted', false],
    ['on-error', 'Canvas unavailable', false],
  ])('handles a %s crash', async (scenario, heading, reportsCrash) => {
    const { browser, origin } = fixture;
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        const originalFetch = window.fetch;
        window.errorReports = [];
        window.fetch = (url, options) => {
          if (url !== '/api/client-errors') return originalFetch(url, options);
          window.errorReports.push({ method: options.method, ...JSON.parse(options.body) });
          return Promise.resolve(new Response(null, { status: 204 }));
        };
      });
      await page.goto(`${origin}crash-test?scenario=${scenario}`);
      await page.getByRole('heading', { name: heading }).waitFor();
      const reports = await page.evaluate(() => window.errorReports);
      expect(reports).toEqual(reportsCrash ? [expect.objectContaining({
        method: 'POST', type: 'error', message, stack: expect.stringContaining(message),
      })] : []);
    } finally {
      await page.close();
    }
  });
});
