// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../test/browserFixture.js';

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));
const steps = ['idea', 'universeAesthetic', 'plotArc', 'readerMap', 'characters', 'issues', 'production']
  .map((id, index) => ({ id, label: ['Idea', 'Universe Aesthetic', 'Plot Arc', 'Reader Map', 'Characters', 'Issues', 'Production'][index], description: 'Review the current work.' }));

// Browser geometry uniquely proves that long stage work cannot displace the
// action and that sidebar/zoom/narrow-container widths drive the same navigator.
describe.skipIf(!chrome)('Story Builder persistent stage workspace', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({ name: 'story-workspace', createServer, chromium,
      launchOptions: { executablePath: chrome }, viteConfig: temp => ({
        configFile: false,
        root: fileURLToPath(new URL('../..', import.meta.url)),
        cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/pages/StoryBuilder.jsx'], include: ['react', 'react-dom/client', 'react-router'] },
        plugins: [react(), {
          name: 'story-workspace-fixture',
          resolveId(id) { if (id === '/story-fixture.jsx') return '\0story-fixture.jsx'; },
          load(id) {
            if (id !== '\0story-fixture.jsx') return;
            return `import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter, Routes, Route } from 'react-router';
              import StoryBuilder from '/src/pages/StoryBuilder.jsx';
              import '/src/index.css';
              const h = React.createElement;
              createRoot(document.getElementById('root')).render(
                h(MemoryRouter, { initialEntries: ['/story-builder/example/' + (new URLSearchParams(location.search).get('step') || 'idea')] },
                  h(Routes, null, h(Route, { path: '/story-builder/:storyId/:step', element: h(StoryBuilder) }))));`;
          },
          configureServer(vite) {
            vite.middlewares.use('/story-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/story-test',
                '<style>html,body{height:100%;margin:0}#shell{display:flex;height:100%}#sidebar{flex:0 0 var(--sidebar,0px)}#root{flex:1;min-width:0;height:100%}</style><div id="shell"><aside id="sidebar"></aside><main id="root"></main></div><script type="module" src="/story-fixture.jsx"></script>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }) });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it('keeps work and actions visible across workspace widths, sidebar states and zoom', async () => {
    const page = await fixture.browser.newPage();
    const mutations = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/socket.io/**', route => route.abort());
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') mutations.push(path);
      let data = {};
      if (path === '/api/story-builder/steps') data = { steps };
      else if (path === '/api/story-builder/example') data = {
        id: 'example', title: 'Example story', seedIdea: 'Generated draft paragraph.\n'.repeat(300),
        currentStep: 'idea', universeId: 'example-universe', seriesId: 'example-series',
        steps: Object.fromEntries(steps.map(s => [s.id, { status: s.id === 'idea' ? 'locked' : 'ready', locked: s.id === 'idea' }])),
        staleSteps: [], llm: {},
      };
      else if (path === '/api/universes/example-universe') data = { id: 'example-universe', logline: 'Example', premise: 'Generated premise.\n'.repeat(300), styleNotes: 'Example style', influences: {}, characters: [] };
      else if (path === '/api/pipeline/series/example-series') data = { id: 'example-series', arc: {} };
      else if (path.includes('/issues')) data = [];
      else if (path === '/api/providers') data = { providers: [] };
      else if (path === '/api/catalog/types') data = { types: [] };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    });
    try {
      for (const step of ['idea', 'universeAesthetic', 'production']) {
        await page.goto(`${fixture.origin}story-test?step=${step}`);
        await page.getByRole('heading', { name: steps.find(s => s.id === step).label, exact: true }).waitFor().catch(error => { throw new Error(errors.join('\n') || error.message); });
        for (const width of [320, 375, 390, 768, 1024, 1280, 1440]) {
          for (const expanded of [false, true]) {
            for (const zoom of [1, 2]) {
              await page.setViewportSize({ width, height: width === 1440 ? 900 : 812 });
              await page.evaluate(({ expanded, zoom, width }) => {
                document.body.style.zoom = String(zoom);
                document.documentElement.style.setProperty('--sidebar', expanded && width >= 768 ? '240px' : '0px');
                document.getElementById('root').style.maxWidth = '';
              }, { expanded, zoom, width });
              await assertGeometry(page, { step, width, expanded, zoom });
            }
          }
        }
        for (const width of [240, 320, 480]) {
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.evaluate(width => {
            document.body.style.zoom = '1';
            document.documentElement.style.setProperty('--sidebar', '0px');
            document.getElementById('root').style.maxWidth = `${width}px`;
          }, width);
          await assertGeometry(page);
        }
        const work = page.getByRole('region', { name: 'Stage work' });
        const action = page.getByRole('button', { name: step === 'idea' ? 'Unlock to revise' : 'Lock & continue' });
        const before = await action.boundingBox();
        await work.evaluate(el => { el.scrollTop = el.scrollHeight; });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(await action.boundingBox()).toEqual(before);
      }
      expect(mutations).toEqual([]);
    } finally { await page.close(); }
  }, 120000);
});

async function assertGeometry(page, context) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await page.evaluate(() => {
    const section = document.querySelector('[aria-label="Current story stage"]');
    const bounds = section.getBoundingClientRect();
    const work = section.querySelector('[aria-label="Stage work"]').getBoundingClientRect();
    const actions = [...section.querySelectorAll('header button')].map(button => button.getBoundingClientRect().toJSON());
    return { bounds: bounds.toJSON(), work: work.toJSON(), actions, height: innerHeight,
      labels: [...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent),
      horizontal: document.documentElement.scrollWidth <= innerWidth + 1 };
  });
  expect(geometry.labels).toEqual(steps.map(step => step.label));
  expect(geometry.horizontal).toBe(true);
  expect(geometry.work.height).toBeGreaterThan(30);
  for (const action of geometry.actions) {
    expect(action.x).toBeGreaterThanOrEqual(geometry.bounds.x);
    expect(action.right, JSON.stringify(context)).toBeLessThanOrEqual(geometry.bounds.right + 1);
    expect(action.bottom, JSON.stringify({ context, geometry })).toBeLessThanOrEqual(geometry.height);
    expect(action.bottom).toBeLessThanOrEqual(geometry.work.top + 1);
  }
}
