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

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

// Render the actual page, toolbars and Tailwind stylesheet inside Layout's
// clipped full-width main. Only transport/session hooks and APIs are replaced:
// this fixture cannot connect to a real shell or invoke a host-control action.
describe.skipIf(!chrome)('Shell header reachability (#9710)', () => {
  let server;
  let browser;
  let browserTemp;
  let origin;
  beforeAll(async () => {
    browserTemp = await mkdtemp(join(tmpdir(), 'shell-header-chrome-'));
    server = await createServer({
      configFile: false,
      cacheDir: join(browserTemp, 'vite-cache'),
      root: fileURLToPath(new URL('../..', import.meta.url)),
      plugins: [react(), {
        name: 'shell-browser-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id === '/shell-fixture.jsx') return '\0shell-fixture.jsx';
          if (/\/hooks\/useShellSession(?:\.js)?$/.test(id)) return '\0shell-session';
          if (/\/hooks\/useItermSession(?:\.js)?$/.test(id)) return '\0iterm-session';
          if (/\/hooks\/useInstanceFeatures(?:\.js)?$/.test(id)) return '\0shell-features';
          if (/\/services\/api(?:\.js)?$/.test(id)) return '\0shell-api';
        },
        load(id) {
          if (id === '\0shell-api') return 'export const getApps = async () => [];';
          if (id === '\0iterm-session') return 'export const useItermSession = () => { throw new Error("Unexpected iTerm connection"); };';
          if (id === '\0shell-features') return `
            export const useInstanceFeatures = () => ({
              isFeatureEnabled: id => id === 'iterm' && new URLSearchParams(location.search).get('iterm') === 'true'
            });
          `;
          if (id === '\0shell-session') return `
            const params = new URLSearchParams(location.search);
            const live = params.get('live') === 'true';
            const badge = params.get('badge') === 'true';
            const forbidden = () => { throw new Error('Host controls must not be invoked by geometry validation'); };
            export const MAX_SESSIONS = 20;
            export const useShellSession = () => ({
              terminalRef: { current: null }, connected: true, isLiveRun: live,
              interactiveCount: live ? 0 : 1, liveRunCount: badge ? 1 : 0,
              activeSessionId: 'example-session',
              sessions: [{ sessionId: 'example-session', label: 'Example session', external: live, createdAt: 0 }],
              restartSession: forbidden, stopSession: forbidden, startNewSession: forbidden,
              switchToSession: forbidden, killOtherSession: forbidden,
            });
          `;
          if (id !== '\0shell-fixture.jsx') return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { MemoryRouter } from 'react-router';
            import Shell from '/src/pages/Shell.jsx';
            import '/src/index.css';
            createRoot(document.getElementById('root')).render(
              React.createElement(MemoryRouter, { initialEntries: ['/shell/example-session'] },
                React.createElement('div', { className: 'h-dvh flex flex-col overflow-x-hidden' },
                  React.createElement('div', { className: 'h-14 shrink-0' }, 'Example app header'),
                  React.createElement('main', { id: 'main-content', className: 'relative overflow-hidden flex-1 min-h-0' },
                    React.createElement(Shell))))
            );
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/shell-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/shell-test',
              '<div id="root"></div><script type="module" src="/shell-fixture.jsx"></script>'));
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

  // The selected ordinary shell and the presence of OTHER live runs are
  // independent. A selected live run necessarily contributes its own badge.
  const states = [true, false].flatMap(iterm => [
    { iterm, live: false, badge: true },
    { iterm, live: false, badge: false },
    { iterm, live: true, badge: true },
  ]);
  it.each([
    { width: 360, height: 800 }, { width: 390, height: 844 },
    { width: 768, height: 1024 }, { width: 1440, height: 900 },
  ])('keeps applicable controls hit-testable at $width x $height', async viewport => {
    const page = await browser.newPage({ viewport, hasTouch: viewport.width < 640 });
    try {
      const errors = [];
      const unexpectedRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(origin).origin || /^\/(api|socket\.io)(\/|$)/.test(url.pathname)) {
          unexpectedRequests.push(url.pathname);
          return route.abort();
        }
        return route.continue();
      });
      for (const state of states) {
        await page.goto(`${origin}shell-test?${new URLSearchParams(state)}`);
        const controls = page.getByRole('group', { name: 'Session controls' });
        try {
          await controls.waitFor({ timeout: 10000 });
        } catch (error) {
          throw new Error(`Fixture did not render: ${errors.join('; ') || error.message}`, { cause: error });
        }
        expect(await controls.getByRole('button').allTextContents()).toEqual(
          state.live ? ['Fullscreen', 'Stop', 'New'] : ['Fullscreen', 'Restart', 'Stop', 'New']);
        const geometry = await controls.getByRole('button').evaluateAll(buttons => buttons.map(button => {
          const r = button.getBoundingClientRect();
          return { name: button.getAttribute('title'), left: r.left, right: r.right,
            top: r.top, bottom: r.bottom, width: r.width, height: r.height,
            hit: button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
        }));
        for (const rect of geometry) {
          expect(rect, JSON.stringify(state)).toMatchObject({ hit: true });
          expect(rect.left).toBeGreaterThanOrEqual(0);
          expect(rect.right).toBeLessThanOrEqual(viewport.width);
          expect(rect.top).toBeGreaterThanOrEqual(0);
          expect(rect.bottom).toBeLessThanOrEqual(viewport.height);
          expect(rect.width).toBeGreaterThanOrEqual(44);
          expect(rect.height).toBeGreaterThanOrEqual(44);
        }
        expect(await page.getByRole('tablist', { name: 'Terminal source' }).count()).toBe(state.iterm ? 1 : 0);
        expect(await page.getByRole('button', { name: 'About live TUI runs' }).count()).toBe(state.badge ? 1 : 0);
        if (state.badge) {
          const help = page.getByRole('button', { name: 'About live TUI runs' });
          const helpGeometry = await help.evaluate(el => {
            const r = el.getBoundingClientRect();
            return { width: r.width, height: r.height,
              hit: el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
          });
          expect(helpGeometry).toMatchObject({ hit: true, width: 44, height: 44 });
        }
        const layout = await page.locator('#main-content').evaluate(main => {
          const shell = main.firstElementChild;
          const header = shell.firstElementChild;
          const terminal = shell.querySelector('.flex-1.bg-port-bg');
          return { mainOverflow: main.scrollWidth - main.clientWidth,
            pageOverflow: document.documentElement.scrollWidth - innerWidth,
            headerOverflow: header.scrollWidth - header.clientWidth,
            terminalHeight: terminal.getBoundingClientRect().height,
            headerHeight: header.getBoundingClientRect().height };
        });
        expect(layout.mainOverflow).toBeLessThanOrEqual(0);
        expect(layout.pageOverflow).toBeLessThanOrEqual(0);
        expect(layout.headerOverflow).toBeLessThanOrEqual(0);
        expect(layout.terminalHeight).toBeGreaterThan(300);
        // Tablet metadata can wrap when the complete conditional header is wider
        // than its container. Desktop keeps one row, allowing font rounding.
        if (viewport.width >= 1440) expect(layout.headerHeight).toBeLessThanOrEqual(48);
      }
      expect(errors).toEqual([]);
      expect(unexpectedRequests).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60000);
});
