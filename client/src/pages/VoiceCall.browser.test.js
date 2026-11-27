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
const root = fileURLToPath(new URL('../..', import.meta.url));
const config = {
  enabled: true, stt: { engine: 'whisper' }, llm: { provider: 'fixture', model: 'fixture-model' },
  tts: { engine: 'piper', piper: { voice: 'fixture-voice' } },
};
function stubApi(page) {
  return page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/voice/config' && route.request().method() === 'PUT') {
      return route.fulfill({ json: { config: route.request().postDataJSON(), reconciliation: {} } });
    }
    const responses = {
      '/api/voice/config': config,
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
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
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
              import { MemoryRouter } from 'react-router';
              import VoiceCall from '/src/pages/VoiceCall.jsx';
              import VoiceWidgetGate from '/src/components/voice/VoiceWidgetGate.jsx';
              import '/src/index.css';
              createRoot(document.getElementById('root')).render(
                React.createElement(MemoryRouter, null,
                  React.createElement(VoiceWidgetGate, null, React.createElement(VoiceCall))));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/voice-console-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/voice-console-test', '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root" style="height:100dvh"></div><script type="module" src="/voice-console-fixture.jsx"></script>'));
            });
          },
        }], server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

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
      await consoleView.getByRole('button', { name: 'Avatar' }).click();
      expect(await consoleView.getByRole('button', { name: 'Avatar' }).getAttribute('aria-pressed')).toBe('false');
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
