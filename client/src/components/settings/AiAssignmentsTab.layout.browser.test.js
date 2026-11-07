// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../scripts/lib/testChrome.js';

const chrome = resolveTestChrome();
const root = fileURLToPath(new URL('../../../', import.meta.url));
const PATH = 'ai-assignments-layout-test';

const API = `
  const providers = [{ id: 'example', name: 'Example provider', type: 'api', enabled: true, defaultModel: 'example-model', models: ['example-model', 'example-model-with-a-rather-long-name-for-a-phone-width-select'] }];
  const entry = (id) => ({ id, area: 'Creative Director', label: 'Production planning model ' + id, source: 'settings.creativeDirector.plan.with.a.long.path.' + id, link: '/settings/example',
    scope: 'global', assignmentType: 'Creative workflows', editable: true, providerEditable: true, modelEditable: true, effortEditable: true, providerTypes: ['api'], providerOptions: null, modelOptions: null,
    modelFilter: null, needsTools: false, providerId: 'example', model: 'example-model', effort: '' });
  export const getAiAssignments = async () => ({ activeProvider: 'example', providers, assignments: ['a', 'b', 'c'].map(entry) });
  export const updateAiAssignment = async () => ({});
`;

// Uniquely catches what happy-dom cannot measure: the real Tailwind layout of the phone and tablet cards.
describe.skipIf(!chrome)('AI assignments layout in Chromium', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'ai-assignments-layout-15179', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: (temp) => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/settings/AiAssignmentsTab.jsx'], include: ['react', 'react-dom/client', 'react-router', 'lucide-react'] },
        plugins: [react(), {
          name: 'ai-assignments-layout-fixture', enforce: 'pre',
          resolveId(id) {
            if (id === '/ai-assignments-layout-fixture.jsx') return '\0ai-assignments-layout-fixture.jsx';
            if (id === '../../services/api') return '\0ai-assignments-api';
            if (id === '../services/apiLocalLlm') return '\0ai-assignments-llm';
            if (id === '../ui/Toast') return '\0ai-assignments-toast';
          },
          load(id) {
            if (id === '\0ai-assignments-api') return API;
            if (id === '\0ai-assignments-llm') return 'export const getVisionModels = async () => ({ models: [] }); export const getToolUseModels = async () => ({ models: [] });';
            if (id === '\0ai-assignments-toast') return 'export default { success() {}, error() {}, info() {} };';
            if (id !== '\0ai-assignments-layout-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter } from 'react-router';
              import AiAssignmentsTab from '/src/components/settings/AiAssignmentsTab.jsx';
              import '/src/index.css';
              createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter, null,
                React.createElement('main', { className: 'w-full max-w-full p-2' }, React.createElement(AiAssignmentsTab))));`;
          },
          configureServer(vite) {
            vite.middlewares.use(`/${PATH}`, async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml(`/${PATH}`, '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/ai-assignments-layout-fixture.jsx"></script></body></html>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);

  afterAll(() => fixture?.close());

  const open = async (width) => {
    const context = await fixture.browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${fixture.origin}${PATH}`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Model for Production planning model a').waitFor({ state: 'visible' });
    return { context, page };
  };

  it.each([390, 768])('stacks each assignment as a card with nothing wider than the page at %i px', async (width) => {
    const { context, page } = await open(width);
    try {
      expect(await page.locator('table').count()).toBe(0);
      const overflowing = await page.evaluate((limit) => [...document.querySelectorAll('main *')]
        .filter((element) => element.getBoundingClientRect().right > limit + 0.5)
        .map((element) => element.tagName), width);
      expect(overflowing).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const name = await page.getByText('Production planning model a', { exact: true }).boundingBox();
      const model = await page.getByLabel('Model for Production planning model a').boundingBox();
      expect(model.y).toBeGreaterThan(name.y);
      expect(model.y - name.y).toBeLessThan(260);
      const link = await page.getByRole('link', { name: 'Open' }).first().boundingBox();
      expect(link.height).toBeGreaterThanOrEqual(44);
    } finally {
      await context.close();
    }
  });

  it('keeps the table at desktop width', async () => {
    const { context, page } = await open(1100);
    try {
      expect(await page.locator('table').count()).toBe(1);
    } finally {
      await context.close();
    }
  });
});
