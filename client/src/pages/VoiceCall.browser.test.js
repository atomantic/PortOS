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
  // 4s keeps playback active long enough for slower CI runners to assert
  // speaking state and click Interrupt before natural audio drain.
  const count = 4 * rate;
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
      else if (action === 'start') avatar.status = { ...(avatar.status ?? { supported: true, installed: true }), phase: 'running' };
      else if (action === 'stop') avatar.status = { ...(avatar.status ?? { supported: true, installed: true }), phase: 'stopped' };
      else return route.fulfill({ status: 400 });
      return route.fulfill({ json: avatar.status });
    }
    if (path === '/api/voice/avatar/frames' || path === '/api/voice/avatar/idle') {
      const frame = path === '/api/voice/avatar/idle' ? (avatar.idleJpeg ?? avatar.jpeg) : avatar.jpeg;
      if (!frame) return route.fulfill({ status: 503, json: { error: 'Renderer unavailable' } });
      const count = path === '/api/voice/avatar/idle' ? 10 : 50;
      const body = Array.from({ length: count }, (_, index) => JSON.stringify({ index, timeMs: index * 40, jpeg: frame })).join('\n');
      return route.fulfill({ body: body + '\n', contentType: 'application/x-ndjson' });
    }
    if (path === '/api/voice/config' && route.request().method() === 'PUT') {
      return route.fulfill({ json: { config: route.request().postDataJSON(), reconciliation: {} } });
    }
    const responses = {
      '/api/notifications': { notifications: [], count: 0 },
      '/api/voice/config': { ...config, enabled },
      '/api/voice/avatar/status': avatar.status ?? { supported: true, installed: true, phase: 'running' },
      '/api/voice/status': { services: {} },
      '/api/local-llm/conversational-gemma/status': { supported: true, llamaInstalled: false, ggufExists: false, running: false, phase: 'idle' },
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
      page.on('request', req => {
        if (req.url().endsWith('/api/voice/avatar/frames') || req.url().endsWith('/api/voice/avatar/idle')) requests.push(req.url());
      });
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
      await page.getByText('AvatarForcing live', { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });

  it('streams continuous idle and speech frames when running, and stops on reduced motion or runtime stop', async () => {
    const page = await fixture.browser.newPage({ viewport: { width: 390, height: 800 }, reducedMotion: 'no-preference' });
    try {
      const avatar = {};
      await stubApi(page, true, avatar);
      await page.goto(`${fixture.origin}voice-console-test`);
      await page.getByText('AvatarForcing live', { exact: true }).waitFor();
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
      // Interrupt stops speech playback and seamlessly keeps continuous AvatarForcing alive.
      const idleResumed = page.waitForRequest(req => req.url().endsWith('/api/voice/avatar/idle'));
      await page.getByRole('button', { name: 'Interrupt' }).click();
      await page.getByText('Standby', { exact: true }).waitFor();
      await idleResumed;
      expect(await canvas.isVisible()).toBe(true);

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await canvas.waitFor({ state: 'hidden' });
      const seen = [];
      page.on('request', req => {
        if (req.url().endsWith('/api/voice/avatar/frames') || req.url().endsWith('/api/voice/avatar/idle')) seen.push(req.url());
      });
      await page.getByRole('button', { name: 'Play sample' }).click();
      await page.getByText('Speaking', { exact: true }).waitFor();
      expect(seen).toEqual([]);
      expect(await canvas.isVisible()).toBe(false);
      await page.getByRole('button', { name: 'Interrupt' }).click();
      await page.emulateMedia({ reducedMotion: 'no-preference' });

      if (!avatarTarget) {
        await page.getByRole('button', { name: 'Avatar settings', exact: true }).click();
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await page.getByText('Still portrait', { exact: true }).waitFor();
        await canvas.waitFor({ state: 'hidden' });
        const afterStop = [];
        page.on('request', req => {
          if (req.url().endsWith('/api/voice/avatar/frames') || req.url().endsWith('/api/voice/avatar/idle')) afterStop.push(req.url());
        });
        await page.getByRole('button', { name: 'Play sample' }).click();
        await page.getByText('Speaking', { exact: true }).waitFor();
        expect(afterStop).toEqual([]);
        expect(await canvas.isVisible()).toBe(false);
        await page.getByRole('button', { name: 'Interrupt' }).click();
      }
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

  it('launches floating sat-phone handset in bottom-left, persists compact toggle across reload, and navigates to /voice/call', async () => {
    const page = await fixture.browser.newPage({ viewport: { width: 1200, height: 820 }, reducedMotion: 'reduce' });
    try {
      await stubApi(page, true);
      await page.addInitScript(() => {
        localStorage.setItem('portos.voice.hidden', '0');
      });
      await page.goto(`${fixture.origin}voice-console-test?home`);
      const widget = page.getByRole('complementary', { name: 'Voice assistant' });
      await widget.waitFor();
      await widget.getByRole('img', { name: 'Radio operator portrait' }).waitFor();

      // Verify bottom-left placement on the left half of the viewport
      const box = await widget.boundingBox();
      expect(box.x).toBeLessThan(350);
      expect(box.x + box.width).toBeLessThan(700);
      expect(box.y + box.height).toBeLessThanOrEqual(820);

      // Toggle to compact bar and confirm persistence across reload
      await widget.getByRole('button', { name: 'Switch to compact voice bar' }).click();
      expect(await widget.getByRole('img', { name: 'Radio operator portrait' }).count()).toBe(0);
      await widget.getByRole('button', { name: 'Show transceiver handset' }).waitFor();

      await page.reload();
      await widget.waitFor();
      expect(await widget.getByRole('img', { name: 'Radio operator portrait' }).count()).toBe(0);
      await widget.getByRole('button', { name: 'Show transceiver handset' }).click();
      await widget.getByRole('img', { name: 'Radio operator portrait' }).waitFor();

      // Navigate to the full-page Voice Call station directly from the handset
      await widget.getByRole('link', { name: 'Open full-page Voice Call' }).click();
      await page.getByRole('region', { name: 'PortOS call console' }).waitFor();
    } finally {
      await page.close();
    }
  });

  it('lets the user switch the voice LLM inline and streams continuous AvatarForcing idle frames', async () => {
    const page = await fixture.browser.newPage({ viewport: { width: 1100, height: 820 }, reducedMotion: 'no-preference' });
    try {
      const idleJpeg = await page.evaluate(() => {
        const tile = document.createElement('canvas');
        tile.width = tile.height = 2;
        const ctx = tile.getContext('2d');
        ctx.fillStyle = 'green';
        ctx.fillRect(0, 0, 2, 2);
        return tile.toDataURL('image/jpeg').split(',')[1];
      });
      await stubApi(page, true, { status: { supported: true, installed: true, phase: 'running' }, idleJpeg });
      await page.goto(`${fixture.origin}voice-console-test`);
      const consoleView = page.getByRole('region', { name: 'PortOS call console' });
      await consoleView.waitFor();

      // No 2D cutout overlay canvas exists; only the real 512x512 AvatarForcing canvas.
      expect(await consoleView.locator('canvas[data-idle-portrait]').count()).toBe(0);
      await consoleView.locator('canvas[width="512"]').waitFor({ state: 'visible' });

      // Inline Voice LLM picker lets the user select a model directly and offers one-click llama.cpp + Conversational Gemma setup.
      const quickModel = consoleView.getByLabel('Voice LLM model', { exact: true });
      await quickModel.waitFor();
      expect(await quickModel.inputValue()).toBe('fixture-model');
      const save = page.waitForRequest(req => req.url().endsWith('/api/voice/config') && req.method() === 'PUT');
      await quickModel.selectOption('fixture-alternate');
      expect((await save).postDataJSON().llm.model).toBe('fixture-alternate');
      await consoleView.getByRole('button', { name: /Use llama\.cpp \+ Conversational Gemma/ }).waitFor();
    } finally {
      await page.close();
    }
  });
});
