// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';
import { ASYNC_UTIL_TIMEOUT_MS } from '../../test/timeouts.js';
import { resolveTestChrome } from '../../../../scripts/lib/testChrome.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = resolveTestChrome();

describe.skipIf(!chrome)('Goals responsive controls', () => {
  let browser;
  let fixture;
  let origin;
  beforeAll(async () => {
    // Each startup phase is bounded and cleaned up inside the hook (#10543).
    fixture = await startBrowserFixture({ name: 'goals-chrome', createServer, chromium,
      launchOptions: { executablePath: chrome }, viteConfig: temp => ({
      configFile: false,
      cacheDir: join(temp, 'vite-cache'),
      // Pre-bundle only what this fixture renders, not the whole app's graph.
      optimizeDeps: { entries: ['src/components/goals/GoalsListView.jsx', 'src/components/goals/GoalsTreeView.jsx'], include: ['react', 'react-dom/client', 'react-router'] },
      root: fileURLToPath(new URL('../../..', import.meta.url)),
      plugins: [react(), {
        name: 'goals-browser-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id === '/goals-fixture.jsx') return '\0goals-fixture.jsx';
          // The regression concerns the toolbar, not WebGL scene rendering.
          if (id === '@react-three/fiber') return '\0goals-fiber.jsx';
        },
        load(id) {
          if (id === '\0goals-fiber.jsx') return `import React from 'react';
            export const Canvas = () => React.createElement('div');
            export const useFrame = () => {};
            export const useThree = () => null;`;
          if (id !== '\0goals-fixture.jsx') return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { MemoryRouter, Routes, Route, useParams } from 'react-router';
            import GoalsListView from '/src/components/goals/GoalsListView.jsx';
            import GoalsTreeView from '/src/components/goals/GoalsTreeView.jsx';
            import '/src/index.css';
            const params = new URLSearchParams(location.search);
            const view = params.has('tree') ? 'tree' : 'list';
            const layout = params.has('layout');
            const View = view === 'tree' ? GoalsTreeView : GoalsListView;
            const goals = [
              { id: 'g1', title: 'Example apex', goalType: 'apex', category: 'mastery', children: [] },
              { id: 'g2', title: 'Example project', category: 'creative', children: [] },
            ];
            const flat = [...goals];
            if (layout) {
              let parent = goals[0];
              for (let depth = 1; depth <= 9; depth++) {
                const child = {
                  id: 'child-' + depth, parentId: parent.id, title: 'Nested example ' + depth,
                  category: 'mastery', goalType: 'sub-apex', horizon: 'lifetime', progress: 75,
                  targetDate: '2030-01-01', urgency: 0.8, linkedActivities: [{ activityName: 'Practice' }],
                  tags: ['W'.repeat(50), 'M'.repeat(50), 'N'.repeat(50)], children: [],
                };
                parent.children.push(child);
                flat.push(child);
                if (depth === 1) {
                  const leaf = { ...child, id: 'leaf', title: 'Sibling leaf', children: [] };
                  parent.children.push(leaf);
                  flat.push(leaf);
                }
                parent = child;
              }
            }
            const h = React.createElement;
            function Fixture() {
              const { goalId } = useParams();
              return h(View, { data: { roots: goals, flat }, selectedGoalId: goalId, onRefresh: () => {} });
            }
            // Pin the bundled Inter webfont (#10628): the default --port-font-ui is the
            // host's system stack, so content-sized widths otherwise vary by machine.
            document.documentElement.style.setProperty('--port-font-ui', "'Inter', sans-serif");
            createRoot(document.getElementById('root')).render(
              h(MemoryRouter, { initialEntries: ['/goals/' + view + (params.has('detail') ? '/child-9' : '')] },
                h('div', { className: layout ? 'h-screen flex' : 'h-screen p-4 md:p-6' },
                  layout && h('div', { className: 'hidden lg:block w-64 shrink-0' }),
                  h('main', { className: 'min-w-0 flex-1 h-full', 'aria-label': 'Goals workspace' },
                    h(Routes, null, h(Route, { path: '/goals/:tab/:goalId?', element: h(Fixture) }))
                  )
                )
              )
            );
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/goals-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/goals-test',
              '<div id="root"></div><script type="module" src="/goals-fixture.jsx"></script>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    }) });
    ({ browser, origin } = fixture);
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each(['list', 'tree'])('keeps %s controls usable at phone, tablet and desktop widths', async view => {
    const page = await browser.newPage();
    try {
      await page.route('**/api/**', route => route.fulfill({ json: {
        activeProvider: 'provider-1',
        providers: [
          { id: 'provider-1', name: 'Example Provider', enabled: true, type: 'api',
            models: ['example-default', 'example-alternate'], defaultModel: 'example-default' },
          { id: 'provider-2', name: 'Other Provider', enabled: true, type: 'api',
            models: ['other-default', 'other-alternate'], defaultModel: 'other-default' },
        ],
      } }));
      await page.goto(`${origin}goals-test?${view}`);
      const provider = page.getByRole('combobox', { name: 'AI Provider' });
      const model = page.getByRole('combobox', { name: 'Model', exact: true });
      await model.waitFor({ timeout: ASYNC_UTIL_TIMEOUT_MS });
      // Measure only once the pinned face has loaded (the Organize label is 500 12px),
      // so a missing or late webfont fails here rather than skewing widths.
      expect(await page.evaluate(async () => {
        const faces = await document.fonts.load('500 12px Inter');
        await document.fonts.ready;
        return faces.length > 0 && getComputedStyle(document.querySelector('button')).fontFamily.startsWith('Inter');
      })).toBe(true);
      for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1440, 900]]) {
        await page.setViewportSize({ width, height });
        for (const control of [provider, model, page.getByRole('button', { name: 'Organize', exact: true })]) {
          expect(await control.isVisible()).toBe(true);
          expect(await control.isEnabled()).toBe(true);
          const box = await control.boundingBox();
          expect(box.width).toBeGreaterThan(80);
          expect(box.height).toBeGreaterThanOrEqual(36);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          expect(box.y + box.height).toBeLessThanOrEqual(height);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await provider.selectOption('provider-2');
        await model.selectOption('other-alternate');
        expect(await model.inputValue()).toBe('other-alternate');
      }
    } finally { await page.close(); }
  }, 60000);

  it('keeps deep rows and sub-goal form controls usable across pane widths (#18340)', async () => {
    const page = await browser.newPage();
    try {
      await page.route('**/api/**', route => route.fulfill({ json: [] }));
      await page.goto(`${origin}goals-test?list&layout`);
      const workspace = page.getByRole('main', { name: 'Goals workspace' });
      const selectGoal = workspace.getByRole('button', { name: /^Nested example 9/ });
      const deepTitle = selectGoal.getByText('Nested example 9', { exact: true });
      await deepTitle.waitFor({ timeout: ASYNC_UTIL_TIMEOUT_MS });
      const addSubGoal = workspace.getByRole('button', { name: 'Add sub-goal under Nested example 9', exact: true });
      const parentTitle = page.getByText('Nested example 1', { exact: true });
      const leafTitle = page.getByText('Sibling leaf', { exact: true });
      for (const [width, height] of [[320, 800], [360, 800], [768, 1024], [1024, 768], [1155, 900], [1156, 900], [1440, 900], [1536, 900]]) {
        await page.setViewportSize({ width, height });
        expect((await parentTitle.boundingBox()).x).toBe((await leafTitle.boundingBox()).x);
        expect((await deepTitle.boundingBox()).width, `title width at ${width}px viewport`).toBeGreaterThanOrEqual(120);
        await expectInside(addSubGoal, workspace);
        if (width <= 360) {
          await addSubGoal.click();
          await page.getByRole('textbox', { name: 'New goal title' }).fill('Example sub-goal');
          for (const control of [
            page.getByRole('combobox', { name: 'Horizon' }),
            page.getByRole('combobox', { name: 'Category' }),
            page.getByRole('button', { name: 'Create', exact: true }),
            page.getByRole('button', { name: 'Cancel', exact: true }),
          ]) {
            await expectInside(control, workspace);
            expect(await control.isEnabled()).toBe(true);
          }
          await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        }
        if (width >= 768) {
          await selectGoal.click();
          const panel = page.getByRole('region', { name: 'Goal details' });
          const workspaceWidth = (await workspace.boundingBox()).width;
          const panelBox = await panel.boundingBox();
          expect(panelBox.width).toBe(workspaceWidth < 900 ? workspaceWidth : 320);
          expect((await deepTitle.boundingBox()).width, `title width at ${width}px viewport`).toBeGreaterThanOrEqual(120);
          if (workspaceWidth >= 900) {
            const action = await addSubGoal.boundingBox();
            expect(action.x + action.width).toBeLessThanOrEqual(panelBox.x);
            await addSubGoal.click({ trial: true });
            await panel.getByRole('button', { name: 'Close panel' }).click();
            await panel.waitFor({ state: 'hidden' });
          } else {
            const heading = panel.getByRole('heading', { level: 2, name: 'Nested example 9' });
            await heading.waitFor();
            expect(await heading.evaluate(element => document.activeElement === element)).toBe(true);
            await page.keyboard.press('Escape');
            await panel.waitFor({ state: 'hidden' });
            expect(await selectGoal.evaluate(element => document.activeElement === element)).toBe(true);
          }
        }
      }
      await page.addStyleTag({ content: 'html { font-size: 20px; }' });
      expect((await parentTitle.boundingBox()).x).toBe((await leafTitle.boundingBox()).x);
    } finally { await page.close(); }
  }, 60000);

  it('fits long link options and phase fields in the tree detail overlay and rail (#18340)', async () => {
    const page = await browser.newPage();
    const activityName = 'W'.repeat(58);
    const calendarName = 'Example calendar with a long name for a recurring practice session';
    const linkRequests = [];
    const responses = {
      'meatspace/activities': [{ name: activityName }],
      'calendar/accounts': [{ subcalendars: [{ calendarId: 'calendar-1', name: calendarName, enabled: true }] }],
      'digital-twin/identity/goals/child-9/generate-phases': [
        { title: 'First phase', description: 'Practice regularly', targetDate: '2029-04-01', order: 0 },
      ],
    };
    try {
      await page.route('**/api/**', route => {
        const endpoint = new URL(route.request().url()).pathname.slice('/api/'.length);
        if (/child-9\/(activities|calendars)$/.test(endpoint)) {
          linkRequests.push(route.request().postDataJSON());
        }
        return route.fulfill({ json: responses[endpoint] ?? [] });
      });
      await page.goto(`${origin}goals-test?tree&layout&detail`);
      const panel = page.getByRole('region', { name: 'Goal details' });
      const workspace = page.getByRole('main', { name: 'Goals workspace' });
      const activity = page.getByRole('combobox', { name: 'Activity', exact: true });
      const calendar = page.getByRole('combobox', { name: 'Calendar to link' });
      await panel.waitFor({ timeout: ASYNC_UTIL_TIMEOUT_MS });
      await page.getByRole('button', { name: 'Plan', exact: true }).click();
      await page.getByRole('button', { name: 'Generate Plan' }).click();
      const phaseTitle = page.getByRole('textbox', { name: 'Phase 1 title' });
      const phaseDescription = page.getByRole('textbox', { name: 'Phase 1 description' });
      await phaseTitle.waitFor();
      for (const [width, height] of [[320, 800], [768, 1024], [1024, 768], [1440, 900]]) {
        await page.setViewportSize({ width, height });
        expect((await panel.boundingBox()).width).toBe(width < 1440 ? (await workspace.boundingBox()).width : 320);
        for (const select of [activity, calendar]) {
          await expectInside(select, panel);
          await expectInside(select.locator('..').getByRole('button', { name: 'Link', exact: true }), panel);
        }
        const date = await page.getByLabel('Phase 1 target date').boundingBox();
        for (const field of [phaseTitle, phaseDescription]) {
          const box = await field.boundingBox();
          expect(box.width).toBeGreaterThanOrEqual((await panel.boundingBox()).width - 52);
          expect(box.y + box.height).toBeLessThanOrEqual(date.y);
        }
        expect(await panel.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(await panel.evaluate(el => el.clientWidth));
      }
      await phaseTitle.fill('Updated title');
      await phaseDescription.fill('Updated description');
      await activity.selectOption(activityName);
      await activity.locator('..').getByRole('button', { name: 'Link', exact: true }).click();
      await calendar.selectOption('calendar-1');
      await calendar.locator('..').getByRole('button', { name: 'Link', exact: true }).click();
      expect(linkRequests).toEqual([
        { activityName },
        { subcalendarId: 'calendar-1', subcalendarName: calendarName, matchPattern: '' },
      ]);
    } finally { await page.close(); }
  }, 60000);
});


async function expectInside(control, container) {
  const box = await control.boundingBox();
  const bounds = await container.boundingBox();
  expect(box.width).toBeGreaterThan(0);
  expect(box.x).toBeGreaterThanOrEqual(bounds.x);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
}
