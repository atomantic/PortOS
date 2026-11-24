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

describe.skipIf(!chrome)('Integration Flows accessibility (#18231)', () => {
  let fixture;
  let browser;
  let origin;

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'flows-doc-a11y',
      createServer,
      chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: (temp) => ({
        configFile: false,
        root,
        cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: {
          entries: ['src/pages/FlowsDoc.jsx'],
          include: ['react', 'react-dom/client', 'react-router', 'lucide-react'],
        },
        plugins: [
          react(),
          {
            name: 'flows-doc-fixture',
            enforce: 'pre',
            resolveId(id) {
              if (id === '/flows-host.jsx') return '\0flows-host.jsx';
            },
            load(id) {
              if (id !== '\0flows-host.jsx') return;
              return `
                import React from 'react';
                import { createRoot } from 'react-dom/client';
                import { MemoryRouter } from 'react-router';
                import FlowsDoc from '/src/pages/FlowsDoc.jsx';
                createRoot(document.getElementById('root')).render(
                  React.createElement(MemoryRouter, { initialEntries: ['/devtools/flows'] },
                    React.createElement(FlowsDoc)
                  )
                );
              `;
            },
            transformIndexHtml: {
              order: 'pre',
              handler: (_html, ctx) => {
                if (!ctx.originalUrl?.startsWith('/flows-host')) return;
                return '<!DOCTYPE html><html><head></head><body><div id="root"></div><script type="module" src="/flows-host.jsx"></script></body></html>';
              },
            },
          },
        ],
      }),
    });
    browser = fixture.browser;
    origin = fixture.origin;
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(async () => {
    await fixture?.close();
  });

  it('exposes landmarks, live region, aria-hidden SVGs, focus rings, and keyboard activation', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}flows.html`, { waitUntil: 'domcontentloaded' });
      await page.locator('.flow-btn').first().waitFor();

      const semantics = await page.evaluate(() => ({
        aside: Boolean(document.querySelector('aside#sidebar')),
        nav: Boolean(document.querySelector('nav#flowList')),
        main: Boolean(document.querySelector('main#diagramWrap')),
        live: document.getElementById('detail')?.getAttribute('aria-live'),
        edgesHidden: document.getElementById('edges')?.getAttribute('aria-hidden'),
        legendSvgCount: document.querySelectorAll('#legend svg').length,
        legendHiddenCount: document.querySelectorAll('#legend svg[aria-hidden="true"]').length,
        nodeButtons: document.querySelectorAll('button.node[type="button"]').length,
      }));
      expect(semantics.aside).toBe(true);
      expect(semantics.nav).toBe(true);
      expect(semantics.main).toBe(true);
      expect(semantics.live).toBe('polite');
      expect(semantics.edgesHidden).toBe('true');
      expect(semantics.legendSvgCount).toBeGreaterThan(0);
      expect(semantics.legendHiddenCount).toBe(semantics.legendSvgCount);
      expect(semantics.nodeButtons).toBeGreaterThan(0);

      // Focus a node via keyboard Tab from resetBtn and check focus-visible ring + Enter activation.
      await page.locator('#resetBtn').focus();
      let reachedNode = false;
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Tab');
        const activeInfo = await page.evaluate(() => ({
          isNode: document.activeElement?.classList.contains('node'),
          outlineStyle: document.activeElement ? getComputedStyle(document.activeElement).outlineStyle : '',
        }));
        if (activeInfo.isNode) {
          reachedNode = true;
          expect(activeInfo.outlineStyle).not.toBe('none');
          break;
        }
      }
      expect(reachedNode).toBe(true);

      await page.keyboard.press('Enter');
      await page.locator('.node-flow-link').first().waitFor();
      const selectedPressed = await page.locator('.node.selected').getAttribute('aria-pressed');
      expect(selectedPressed).toBe('true');

      // Tab back to the "Appears in:" flow link inside #detail and activate with Enter.
      await page.locator('#resetBtn').focus();
      await page.keyboard.press('Tab');
      const focusedLink = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        cls: document.activeElement?.className,
        flow: document.activeElement?.getAttribute('data-flow'),
      }));
      expect(focusedLink.tag).toBe('BUTTON');
      expect(focusedLink.cls).toBe('node-flow-link');
      expect(focusedLink.flow).toBeTruthy();

      await page.keyboard.press('Enter');
      await page.locator('button.step[type="button"]').first().waitFor();
      const activeFlowBtn = page.locator(`.flow-btn[data-flow="${focusedLink.flow}"]`);
      expect(await activeFlowBtn.getAttribute('aria-pressed')).toBe('true');

      // Spy on Element.prototype.scrollIntoView and activate a .step card via Enter and Space.
      await page.evaluate(() => {
        window.__scrollIntoViewCalls = [];
        const orig = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (opts) {
          window.__scrollIntoViewCalls.push(opts);
          return orig.call(this, opts);
        };
      });
      await page.locator('button.step[type="button"]').first().focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      const calls = await page.evaluate(() => window.__scrollIntoViewCalls);
      expect(calls).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it('respects prefers-reduced-motion: reduce and marks FlowsDoc ExternalLink aria-hidden', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}flows.html`, { waitUntil: 'domcontentloaded' });
      await page.locator('.flow-btn').first().waitFor();

      const transitionDurations = await page.evaluate(() => ({
        node: getComputedStyle(document.querySelector('.node')).transitionDuration,
        edge: getComputedStyle(document.querySelector('path.edge')).transitionDuration,
      }));
      expect(transitionDurations.node).toBe('0s');
      expect(transitionDurations.edge).toBe('0s');

      await page.evaluate(() => {
        window.__scrollBehaviors = [];
        const origScrollTo = Element.prototype.scrollTo;
        Element.prototype.scrollTo = function (opts) {
          if (opts && typeof opts === 'object') window.__scrollBehaviors.push(opts.behavior);
          return origScrollTo.call(this, opts);
        };
        const origScrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (opts) {
          if (opts && typeof opts === 'object') window.__scrollBehaviors.push(opts.behavior);
          return origScrollIntoView.call(this, opts);
        };
      });
      await page.locator('.flow-btn').first().click();
      await page.locator('button.step[type="button"]').first().click();
      const behaviors = await page.evaluate(() => window.__scrollBehaviors);
      expect(behaviors.length).toBeGreaterThanOrEqual(2);
      expect(behaviors.every((b) => b === 'auto')).toBe(true);

      await page.goto(`${origin}flows-host`, { waitUntil: 'domcontentloaded' });
      await page.locator('a[target="_blank"] svg').waitFor();
      expect(await page.locator('a[target="_blank"] svg').getAttribute('aria-hidden')).toBe('true');
    } finally {
      await context.close();
    }
  });
});
