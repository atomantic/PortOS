// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../../scripts/lib/testChrome.js';

// Browser startup/navigation is bounded separately from 5s interactions.
vi.setConfig({ testTimeout: 30000 });

const require = createRequire(import.meta.url);
// Prefer the client dev dependency; linked worktrees can also use the same
// pinned driver from the server without installing into shared node_modules.
const { chromium } = require(require.resolve('playwright-core', { paths: [
  fileURLToPath(new URL('../../../..', import.meta.url)),
  fileURLToPath(new URL('../../../../../server', import.meta.url)),
] }));
const chrome = resolveTestChrome();

describe.skipIf(!chrome)('Brain inbox capture geometry', () => {
  let fixture;
  let browser;
  let origin;
  beforeAll(async () => {
    // Vite start, Chromium launch and the cold-module warmup are each bounded
    // inside the hook, so a stall names its phase and cleans up (#10543).
    fixture = await startBrowserFixture({
      name: 'inbox-chrome',
      createServer,
      chromium,
      viteConfig: temp => ({
        configFile: false,
        // Concurrent fixtures and linked worktrees must not replace each other's
        // optimized dependencies in the shared node_modules/.vite cache.
        cacheDir: join(temp, 'vite-cache'),
        // Pre-bundle only what this fixture renders, not the whole app's graph.
        optimizeDeps: {
          entries: ['src/components/brain/tabs/InboxTab.jsx'],
          include: ['react-dom/client', 'react-router'],
        },
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
              const entry = id => window.inboxEntries.find(item => item.id === id);
              const record = (action, id, destination) => {
                window.inboxActions = [...(window.inboxActions || []), { action, id, destination }];
                const inboxLog = { ...entry(id), status: action === 'done' ? 'done' : action === 'retry' ? 'classifying' : 'corrected' };
                if (destination) inboxLog.filed = { ...inboxLog.filed, destination, destinationId: 'updated-record' };
                return { inboxLog };
              };
              export async function markBrainInboxDone(id) { return record('done', id); }
              export async function resolveBrainReview(id, destination) { return record('route', id, destination); }
              export async function retryBrainClassification(id) { return record('retry', id); }
              export async function fixBrainClassification(id, destination) { return record('fix', id, destination); }
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
              import { MemoryRouter, useLocation } from 'react-router';
              import InboxTab from '/src/components/brain/tabs/InboxTab.jsx';
              import '/src/index.css';
              window.SpeechRecognition = function () { throw new Error('Recording must not start'); };
              function LocationProbe() { const location = useLocation(); return React.createElement('output', { 'aria-label': 'Current path' }, location.pathname); }
              createRoot(document.getElementById('root')).render(
                React.createElement(MemoryRouter, null, React.createElement(React.Fragment, null, React.createElement(LocationProbe), React.createElement(InboxTab)))
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
      }),
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      // Compile the cold Vite module graph inside fixture startup, before timed
      // interaction cases. This does not resolve history or submit a capture.
      warmup: async (page, url) => {
        await page.goto(`${url}inbox-test`, { timeout: 20000 });
        await page.getByRole('textbox', { name: 'New inbox thought' }).waitFor({ timeout: 5000 });
      },
    });
    ({ browser, origin } = fixture);
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close(), 60000);

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

  it.each([[360, 800], [768, 1024]])(
    'keeps filed and needs-review actions distinct and touch-sized at %ix%i', async (width, height) => {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const entries = [
        { id: 'file-done', status: 'filed', capturedText: 'Filed done row', capturedAt: '2026-10-28T00:00:00Z', filed: { destination: 'people', destinationId: 'people-1' } },
        { id: 'file-view', status: 'filed', capturedText: 'Filed view row', capturedAt: '2026-10-28T00:00:00Z', filed: { destination: 'memories', destinationId: 'memory-1' } },
        { id: 'file-fix', status: 'filed', capturedText: 'Filed fix row', capturedAt: '2026-10-28T00:00:00Z', filed: { destination: 'people', destinationId: 'people-2' } },
        { id: 'review-route', status: 'needs_review', capturedText: 'Review route row', capturedAt: '2026-10-28T00:00:00Z', classification: { destination: 'people', confidence: 0.4 } },
        { id: 'review-retry', status: 'needs_review', capturedText: 'Review retry row', capturedAt: '2026-10-28T00:00:00Z', classification: { destination: 'ideas', confidence: 0.3 } },
      ];
      try {
        await page.goto(`${origin}inbox-test`, { timeout: 15000 });
        await page.evaluate(data => {
          window.inboxEntries = data;
          window.resolveInboxHistory({ entries: data, total: data.length, counts: { filed: 3, needs_review: 2 } });
        }, entries);
        await page.getByText('Filed done row', { exact: true }).waitFor();

        const targets = [
          ...await page.getByRole('button', { name: 'View', exact: true }).all(),
          ...await page.getByRole('button', { name: 'Done', exact: true }).all(),
          ...await page.getByRole('button', { name: 'Fix', exact: true }).all(),
          ...await page.getByRole('button', { name: 'People', exact: true }).all(),
          ...await page.getByRole('button', { name: 'Projects', exact: true }).all(),
          ...await page.getByRole('button', { name: 'Ideas', exact: true }).all(),
          ...await page.getByRole('button', { name: 'Admin', exact: true }).all(),
          ...await page.getByRole('button', { name: 'Memories', exact: true }).all(),
          ...await page.getByRole('button', { name: 'Retry AI' }).all(),
        ];
        for (const target of targets) {
          await target.scrollIntoViewIfNeeded();
          const box = await target.boundingBox();
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.x).toBeGreaterThanOrEqual(16);
          expect(box.x + box.width).toBeLessThanOrEqual(width - 16);
          expect(await target.evaluate(el => {
            const r = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          }), `target ${await target.getAttribute('title')} ${await target.textContent()} at ${JSON.stringify(box)}`).toBe(true);
        }

        const filedDone = page.locator('div.p-3.bg-port-card').filter({ hasText: 'Filed done row' });
        await filedDone.getByRole('button', { name: 'Done', exact: true }).click();
        expect(await page.evaluate(() => window.inboxActions.at(-1))).toEqual({ action: 'done', id: 'file-done', destination: undefined });

        const filedView = page.locator('div.p-3.bg-port-card').filter({ hasText: 'Filed view row' });
        await filedView.getByRole('button', { name: 'View', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('output[aria-label="Current path"]')?.textContent === '/brain/memory');
        expect(await page.evaluate(() => window.inboxActions.length)).toBe(1);

        const filedFix = page.locator('div.p-3.bg-port-card').filter({ hasText: 'Filed fix row' });
        await filedFix.getByRole('button', { name: 'Fix', exact: true }).click();
        const fixSelect = filedFix.getByRole('combobox', { name: 'Fix destination' });
        const move = filedFix.getByRole('button', { name: 'Move' });
        for (const control of [fixSelect, move, filedFix.getByRole('button', { name: 'Cancel', exact: true })]) {
          await control.scrollIntoViewIfNeeded();
          const box = await control.boundingBox();
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.x + box.width).toBeLessThanOrEqual(width - 16);
        }
        await fixSelect.selectOption('projects');
        await move.click();
        expect(await page.evaluate(() => window.inboxActions.at(-1))).toEqual({ action: 'fix', id: 'file-fix', destination: 'projects' });

        expect(await page.getByText('Review route row', { exact: true }).count()).toBe(1);
        await page.getByRole('button', { name: 'Ideas', exact: true }).first().click();
        expect(await page.evaluate(() => window.inboxActions.at(-1))).toEqual({ action: 'route', id: 'review-route', destination: 'ideas' });
        await page.getByRole('button', { name: 'Retry AI' }).last().click();
        expect(await page.evaluate(() => window.inboxActions.at(-1))).toEqual({ action: 'retry', id: 'review-retry', destination: undefined });
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30000,
  );
});
