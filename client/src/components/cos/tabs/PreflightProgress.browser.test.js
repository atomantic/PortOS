// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../../scripts/lib/testChrome.js';

const chrome = resolveTestChrome();

describe.skipIf(!chrome)('preflight progress animation', () => {
  let fixture;
  let page;
  let icon;

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'preflight-progress-animation', createServer, chromium,
      launchOptions: { executablePath: chrome },
      viteConfig: temp => ({
        configFile: false,
        root: fileURLToPath(new URL('../../../..', import.meta.url)),
        cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/cos/tabs/PreflightProgress.jsx'], include: ['react', 'react-dom/client', 'lucide-react'] },
        plugins: [react(), {
          name: 'preflight-progress-fixture',
          enforce: 'pre',
          resolveId(id) { if (id === '/preflight-fixture.js') return '\0preflight-fixture.js'; },
          load(id) {
            if (id !== '\0preflight-fixture.js') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import PreflightProgress from '/src/components/cos/tabs/PreflightProgress.jsx';
              import '/src/index.css';
              const preflight = { phase: 'preparing', steps: [
                { key: 'queue', label: 'Waiting for a free task slot', status: 'done' },
                { key: 'prepare', label: 'Building the task and its prompt', status: 'active' },
                { key: 'dispatch', label: 'Handing off to the agent', status: 'pending' },
              ] };
              createRoot(document.getElementById('root')).render(React.createElement(PreflightProgress,
                { preflight, active: true, idScope: 'cos', taskId: 'preflight-example' }));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/preflight-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/preflight-test', '<div id="root"></div><script type="module" src="/preflight-fixture.js"></script>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
    page = await fixture.browser.newPage({ reducedMotion: 'no-preference' });
    await page.goto(`${fixture.origin}preflight-test`);
    icon = page.locator('[aria-label="Pre-agent checks"] li').filter({ hasText: 'Building the task and its prompt' }).locator('svg');
    await icon.waitFor();
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(async () => { await fixture?.close(); });

  it('rotates the active step instead of interpolating a full turn to the same position', async () => {
    const transforms = await icon.evaluate(async element => {
      const animation = element.getAnimations()[0];
      if (!animation) return null;
      animation.pause();
      animation.currentTime = 0;
      await new Promise(requestAnimationFrame);
      const start = getComputedStyle(element).transform;
      animation.currentTime = 250;
      await new Promise(requestAnimationFrame);
      return { start, quarterTurn: getComputedStyle(element).transform };
    });
    expect(transforms).not.toBeNull();
    expect(transforms.quarterTurn).not.toBe(transforms.start);
  });

  it('honors the system reduced-motion preference', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const motion = await icon.evaluate(element => ({
      duration: getComputedStyle(element).animationDuration,
      iterations: getComputedStyle(element).animationIterationCount,
    }));
    expect(parseFloat(motion.duration)).toBeLessThanOrEqual(0.00001);
    expect(motion.iterations).toBe('1');
  });
});
