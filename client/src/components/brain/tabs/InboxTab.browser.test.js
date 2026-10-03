// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// Browser startup/navigation is bounded separately from 5s interactions.
vi.setConfig({ testTimeout: 30000 });

const require = createRequire(import.meta.url);
// Prefer the client dev dependency; linked worktrees can also use the same
// pinned driver from the server without installing into shared node_modules.
const { chromium } = require(require.resolve('playwright-core', { paths: [
  fileURLToPath(new URL('../../../..', import.meta.url)),
  fileURLToPath(new URL('../../../../../server', import.meta.url)),
] }));
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

describe.skipIf(!chrome)('Brain inbox capture geometry', () => {
  let server;
  let browser;
  let browserTemp;
  let origin;
  beforeAll(async () => {
    browserTemp = await mkdtemp(join(tmpdir(), 'inbox-chrome-'));
    server = await createServer({
      configFile: false,
      // Concurrent fixtures and linked worktrees must not replace each other's
      // optimized dependencies in the shared node_modules/.vite cache.
      cacheDir: join(browserTemp, 'vite-cache'),
      root: fileURLToPath(new URL('../../../..', import.meta.url)),
      plugins: [react(), {
        name: 'inbox-browser-fixture',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '/inbox-fixture.jsx') return '\0inbox-fixture.jsx';
          if (importer?.endsWith('/InboxTab.jsx')) {
            if (id === '../../../services/api') return '\0inbox-api';
            if (id === '../../../services/socket') return '\0inbox-socket';
            if (id === '../../../hooks') return '\0inbox-hooks';
          }
        },
        load(id) {
          if (id === '\0inbox-api') return `
            let history;
            export function getBrainInbox() {
              if (!history) history = new Promise(resolve => { window.resolveInboxHistory = resolve; });
              return history;
            }
            export async function captureBrainThought(...args) {
              window.captures = [...(window.captures || []), args];
              return { inboxLog: { id: 'example-thought', status: 'filed', capturedText: args[0] } };
            }
          `;
          if (id === '\0inbox-socket') return 'export default { on() {}, off() {} };';
          if (id === '\0inbox-hooks') return `
            import { useState } from 'react';
            export const useLocalStorageBool = () => useState(false);
            export const useRepoIntake = () => ({ repo: null, options: {}, managedApps: [], providers: [],
              providerOverride: {}, intakeFor() {}, setStudyContext() {}, targetAppId: 'example-app' });
          `;
          if (id !== '\0inbox-fixture.jsx') return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { MemoryRouter } from 'react-router';
            import InboxTab from '/src/components/brain/tabs/InboxTab.jsx';
            import '/src/index.css';
            window.SpeechRecognition = function () { throw new Error('Recording must not start'); };
            createRoot(document.getElementById('root')).render(
              React.createElement(MemoryRouter, null, React.createElement(InboxTab))
            );
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/inbox-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/inbox-test',
              '<div id="root" style="padding:16px"></div><script type="module" src="/inbox-fixture.jsx"></script>'));
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
    // Compile the cold Vite module graph inside fixture startup, before timed
    // interaction cases. This does not resolve history or submit a capture.
    const warmup = await browser.newPage();
    try {
      await warmup.goto(`${origin}inbox-test`, { timeout: 25000 });
      await warmup.getByRole('textbox', { name: 'New inbox thought' }).waitFor({ timeout: 5000 });
    } finally {
      await warmup.close();
    }
  }, 60000);
  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await server?.close();
      if (browserTemp) await rm(browserTemp, { recursive: true, force: true });
    }
  }, 60000);

  it.each([[360, 800], [390, 844], [768, 1024], [1440, 900]])(
    'keeps the complete capture form usable at %ix%i', async (width, height) => {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        // Cold Vite module transformation competes with other related suites.
        // Give navigation its own bounded startup budget; interactions stay at 5s.
        await page.goto(`${origin}inbox-test`, { timeout: 15000 });
        const input = page.getByRole('textbox', { name: 'New inbox thought' });
        await input.fill('An example thought');
        await page.getByText('Loading inbox history').waitFor();
        const capture = page.getByRole('button', { name: 'Capture thought' });
        const creative = page.getByRole('button', { name: 'Toggle creative capture mode' });
        const mic = page.getByRole('button', { name: 'Voice capture' });
        for (const control of [input, mic, creative, capture]) {
          const box = await control.boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(16);
          expect(box.x + box.width).toBeLessThanOrEqual(width - 16);
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.width).toBeGreaterThanOrEqual(control === input ? 120 : 44);
          expect(await control.evaluate(el => {
            const r = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          })).toBe(true);
        }
        expect(await input.evaluate(el => el.parentElement.scrollWidth <= el.parentElement.clientWidth)).toBe(true);
        const inputBox = await input.boundingBox();
        const captureBox = await capture.boundingBox();
        expect(width < 512 ? captureBox.y >= inputBox.y + inputBox.height : Math.abs((captureBox.y + captureBox.height / 2) - (inputBox.y + inputBox.height / 2)) < 1).toBe(true);
        await creative.click();
        await capture.click();
        await page.waitForFunction(() => window.captures?.length === 1);
        expect(await page.evaluate(() => window.captures[0][0])).toBe('An example thought');
        expect(await page.evaluate(() => window.captures[0][3].creative)).toBe(true);
        await page.evaluate(() => window.resolveInboxHistory({
          entries: [{ id: 'example-thought', status: 'filed', capturedText: 'An example thought', creative: true }],
          counts: { filed: 1 },
        }));
        await page.getByText('Loading inbox history').waitFor({ state: 'hidden' });
        expect(await page.getByText('An example thought', { exact: true }).count()).toBe(1);
        await input.fill('https://example.com');
        await page.getByRole('textbox', { name: /Why are you saving this link/ }).fill('Example note');
        expect(await creative.isDisabled()).toBe(true);
        await capture.click();
        await page.waitForFunction(() => window.captures?.length === 2);
        expect(await page.evaluate(() => window.captures[1][3].note)).toBe('Example note');
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30000,
  );
});
