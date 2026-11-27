// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../test/browserFixture.js';
import { resolveTestChrome } from '../../../scripts/lib/testChrome.js';

const chrome = resolveTestChrome();
// Optional developer smoke against a running runtime on a separate loopback test server.
const avatarTarget = /^\d{1,5}$/.test(process.env.PORTOS_TEST_AVATAR_PORT ?? '')
  ? 'http://127.0.0.1:' + process.env.PORTOS_TEST_AVATAR_PORT : null;
const avatarWav = avatarTarget && process.env.PORTOS_TEST_AVATAR_WAV ? readFileSync(process.env.PORTOS_TEST_AVATAR_WAV) : null;
const root = fileURLToPath(new URL('../..', import.meta.url));
const config = {
  enabled: true, stt: { engine: 'whisper' }, llm: { provider: 'fixture', model: 'fixture-model' },
  tts: { engine: 'piper', piper: { voice: 'fixture-voice' } },
};
function sampleWave() {
  const rate = 16_000;
  const count = 2 * rate;
  const wave = Buffer.alloc(44 + count * 2);
  wave.write('RIFF');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(rate, 24);
  wave.writeUInt32LE(rate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) wave.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 8192), 44 + i * 2);
  return wave;
}

function stubApi(page, enabled = true, avatar = {}) {
  return page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/voice/public/synthesize') return route.fulfill({ body: avatarWav || sampleWave(), contentType: 'audio/wav' });
    if (path.startsWith('/api/voice/avatar/') && avatarTarget) return route.continue();
    if (path === '/api/voice/avatar/runtime') {
      const { action, acceptTerms } = route.request().postDataJSON();
      if (action === 'install' && !acceptTerms) return route.fulfill({ status: 400 });
      if (action === 'install') avatar.status = { supported: true, installed: true, phase: 'stopped' };
      else if (action === 'start') avatar.status = { ...avatar.status, phase: 'running' };
      else return route.fulfill({ status: 400 });
      return route.fulfill({ json: avatar.status });
    }
    if (path === '/api/voice/avatar/frames') {
      if (!avatar.jpeg) return route.fulfill({ status: 503, json: { error: 'Renderer unavailable' } });
      const body = Array.from({ length: 50 }, (_, index) => JSON.stringify({ index, timeMs: index * 40, jpeg: avatar.jpeg })).join('\n');
      return route.fulfill({ body: body + '\n', contentType: 'application/x-ndjson' });
    }
    if (path === '/api/voice/config' && route.request().method() === 'PUT') {
      return route.fulfill({ json: { config: route.request().postDataJSON(), reconciliation: {} } });
    }
    const responses = {
      '/api/voice/config': { ...config, enabled },
      '/api/voice/avatar/status': avatar.status ?? { supported: true, installed: true, phase: 'running' },
      '/api/voice/status': { services: {} },
      '/api/providers': { providers: [{ id: 'fixture', name: 'Test provider', type: 'api', models: ['fixture-model', 'fixture-alternate'] }] },
      '/api/settings/features': { features: [] },
    };
    return route.fulfill({ json: responses[path] || {} });
  });
}

describe.skipIf(!chrome)('Voice Call console in Chrome', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'voice-console', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      warmup: async (page, origin) => {
        await stubApi(page);
        await page.goto(`${origin}voice-console-test`);
        await page.getByRole('region', { name: 'PortOS call console' }).waitFor();
      },
      viteConfig: temp => ({
        configFile: false, root, define: { __APP_VERSION__: JSON.stringify("0.0.0-test") }, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: {
          entries: ['src/pages/VoiceCall.jsx', 'src/components/voice/VoiceWidget.jsx'],
          include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react-router', 'lucide-react'],
        },
        plugins: [react(), {
          name: 'voice-console-fixture', enforce: 'pre',
          resolveId(id) {
            if (id === '/voice-console-fixture.jsx') return '\0voice-console-fixture';
            if (/\/services\/socket(?:\.js)?$/.test(id) || id === './socket') return '\0voice-console-socket';
          },
          load(id) {
            if (id === '\0voice-console-socket') return 'export default { connected: false, on() {}, off() {}, emit() {} };';
            if (id !== '\0voice-console-fixture') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter, Route, Routes } from 'react-router';
              import VoiceCall from '/src/pages/VoiceCall.jsx';
              import Layout from '/src/components/Layout.jsx';
              import { ThemeProvider } from '/src/components/ThemeContext.jsx';
              import '/src/index.css';
              const h = React.createElement;
              const start = new URLSearchParams(location.search).has('home') ? '/' : '/voice/call';
              createRoot(document.getElementById('root')).render(
                h(MemoryRouter, { initialEntries: [start] },
                  h(ThemeProvider, null,
                    h(Routes, null, h(Route, { path: '/', element: h(Layout) },
                      h(Route, { index: true, element: h('main', null, 'Home') }),
                      h(Route, { path: 'voice/call', element: h(VoiceCall) }))))));

            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/voice-console-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/voice-console-test', '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root" style="height:100dvh"></div><script type="module" src="/voice-console-fixture.jsx"></script>'));
            });
          },
        }], server: { host: '127.0.0.1', port: 0, ...(avatarTarget && { proxy: { '/api/voice/avatar': avatarTarget } }) },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it('keeps the mobile Voice Call link reachable with voice disabled and does not request the mic', async () => {
    const page = await fixture.browser.newPage({ viewport: { width: 320, height: 800 }, hasTouch: true });
    try {
      await page.addInitScript(() => {
        window.testMicRequests = 0;
        navigator.mediaDevices.getUserMedia = () => {
          window.testMicRequests += 1;
          return Promise.reject(new Error('Unexpected microphone request'));
        };
      });
      await stubApi(page, false);
      await page.goto(`${fixture.origin}voice-console-test?home`);
      const link = page.getByRole('banner').getByRole('link', { name: 'Open Voice Call' });
      await link.waitFor();
      expect(await link.evaluate(element => {
        const { left, right, width, height } = element.getBoundingClientRect();
        const bar = element.closest('header');
        return left >= 0 && right <= innerWidth && width >= 44 && height >= 44 && bar.scrollWidth <= bar.clientWidth;
      })).toBe(true);
      await link.tap();
      await page.getByText('Enable Voice in', { exact: false }).waitFor();
      expect(await page.evaluate(() => window.testMicRequests)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it.skipIf(avatarTarget)('shows install and start at the call, with a still portrait before setup', async () => {
    const page = await fixture.browser.newPage({ viewport: { width: 390, height: 800 }, reducedMotion: 'no-preference' });
    try {
      await stubApi(page, true, { status: { supported: true, installed: false, phase: 'stopped' } });
      await page.goto(`${fixture.origin}voice-console-test`);
      const setup = page.getByRole('region', { name: 'Voice avatar model' });
      await setup.getByRole('heading', { name: /Avatar setup/ }).waitFor();
      await setup.getByRole('link', { name: 'checkpoint terms' }).waitFor();
      const installButton = setup.getByRole('button', { name: 'Install AvatarForcing' });
      expect(await installButton.isEnabled()).toBe(false);

      const face = page.getByRole('img', { name: 'Radio operator portrait' });
      await face.waitFor();
      const faceBounds = await face.boundingBox();
      expect(faceBounds.width).toBeGreaterThan(180);
      expect(faceBounds.width).toBeCloseTo(faceBounds.height);
      expect(await face.evaluate(async element => {
        await element.decode();
        return [element.naturalWidth, element.naturalHeight];
      })).toEqual([640, 640]);
      const requests = [];
      page.on('request', req => { if (req.url().endsWith('/api/voice/avatar/frames')) requests.push(req.url()); });
      const speech = page.waitForRequest(req => req.url().endsWith('/api/voice/public/synthesize'));
      await page.getByRole('button', { name: 'Play sample' }).click();
      expect((await speech).postDataJSON().text).toContain('PortOS radio check');
      await page.getByText('Speaking', { exact: true }).waitFor();
      expect(requests).toEqual([]);
      expect(await page.locator('canvas[width="512"]').isVisible()).toBe(false);
      await page.getByRole('button', { name: 'Interrupt' }).click();

      await setup.getByLabel(/I accept the checkpoint terms/).check();
      const install = page.waitForRequest(req => req.url().endsWith('/api/voice/avatar/runtime'));
      await installButton.click();
      expect((await install).postDataJSON()).toEqual({ action: 'install', acceptTerms: true });
      await setup.getByRole('button', { name: 'Start AvatarForcing' }).click();
      await setup.getByText('Running', { exact: true }).waitFor();
      expect(await setup.getByLabel('Use generated avatar in this browser').isChecked()).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('uses generated frames after opt-in and stops showing frames on interrupt', async () => {
    const page = await fixture.browser.newPage({ viewport: { width: 390, height: 800 }, reducedMotion: 'no-preference' });
    try {
      const avatar = {};
      await stubApi(page, true, avatar);
      await page.goto(`${fixture.origin}voice-console-test`);
      await page.getByLabel('Use generated avatar in this browser').check();
      await page.getByRole('heading', { name: /AvatarForcing ready/ }).waitFor();
      await page.getByRole('button', { name: 'Hide avatar settings' }).click();
      const canvas = page.locator('canvas[width="512"]');
      await expect(canvas.count()).resolves.toBe(1);
      expect(await canvas.isVisible()).toBe(false);
      if (!avatarTarget) {
        await page.getByRole('button', { name: 'Play sample' }).click();
        await page.getByText('No avatar frames arrived.', { exact: false }).waitFor();
        await page.getByRole('button', { name: 'Interrupt' }).click();
        expect(await canvas.isVisible()).toBe(false);
      }
      avatar.jpeg = await page.evaluate(() => {
        const tile = document.createElement('canvas');
        tile.width = tile.height = 2;
        const ctx = tile.getContext('2d');
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, 2, 2);
        return tile.toDataURL('image/jpeg').split(',')[1];
      });
      const request = page.waitForRequest(req => req.url().endsWith('/api/voice/avatar/frames'));
      await page.getByRole('button', { name: 'Play sample' }).click();
      expect((await request).postDataBuffer().subarray(0, 4).toString()).toBe('RIFF');
      await canvas.waitFor({ state: 'visible' });
      expect(await page.getByText('No avatar frames arrived.', { exact: false }).count()).toBe(0);
      expect(await canvas.evaluate(el => el.getContext('2d').getImageData(256, 256, 1, 1).data[3])).toBe(255);
      await page.getByRole('button', { name: 'Interrupt' }).click();
      await canvas.waitFor({ state: 'hidden' });
      await page.getByText('Standby', { exact: true }).waitFor();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const seen = [];
      page.on('request', req => { if (req.url().endsWith('/api/voice/avatar/frames')) seen.push(req.url()); });
      await page.getByRole('button', { name: 'Play sample' }).click();
      await page.getByText('Speaking', { exact: true }).waitFor();
      expect(seen).toEqual([]);
      expect(await canvas.isVisible()).toBe(false);
      await page.getByRole('button', { name: 'Interrupt' }).click();
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.getByRole('button', { name: 'Avatar settings', exact: true }).click();
      await page.getByLabel('Use generated avatar in this browser').uncheck();
      await page.getByRole('button', { name: 'Play sample' }).click();
      await page.getByText('Speaking', { exact: true }).waitFor();
      expect(seen).toEqual([]);
      expect(await canvas.isVisible()).toBe(false);
      await page.getByRole('button', { name: 'Interrupt' }).click();
    } finally {
      await page.close();
    }
  });

  it.each([[320, 'kestrel-dawn'], [390, 'kestrel-neon'], [1100, 'kestrel-neon']])('fits at %i px in %s and opens model settings', async (width, theme) => {
    const page = await fixture.browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
    try {
      await stubApi(page);
      await page.goto(`${fixture.origin}voice-console-test`);
      await page.evaluate(themeId => { document.documentElement.dataset.portTheme = themeId; }, theme);
      const consoleView = page.getByRole('region', { name: 'PortOS call console' });
      await consoleView.waitFor();
      expect(await consoleView.evaluate(element => {
        const frame = element.getBoundingClientRect();
        return frame.right <= window.innerWidth && [...element.querySelectorAll('button,input')].every(control => {
          const box = control.getBoundingClientRect();
          return box.left >= frame.left && box.right <= frame.right;
        });
      })).toBe(true);
      await consoleView.getByRole('button', { name: 'Avatar', exact: true }).click();
      expect(await consoleView.getByRole('img', { name: 'Radio operator portrait' }).count()).toBe(0);
      expect(await consoleView.getByRole('button', { name: 'Avatar', exact: true }).getAttribute('aria-pressed')).toBe('false');
      await page.getByRole('button', { name: 'Model & voice settings' }).click();
      await page.getByLabel('LLM model', { exact: true }).waitFor();
      const model = page.getByLabel('LLM model', { exact: true });
      expect(await model.inputValue()).toBe('fixture-model');
      await model.selectOption('fixture-alternate');
      const save = page.waitForRequest(request => request.url().endsWith('/api/voice/config') && request.method() === 'PUT');
      await page.getByRole('button', { name: 'Save & Reconcile' }).click();
      expect((await save).postDataJSON().llm.model).toBe('fixture-alternate');
      await page.getByRole('button', { name: 'Close settings' }).click();
    } finally {
      await page.close();
    }
  });
});
