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
const root = fileURLToPath(new URL('../../..', import.meta.url));

describe.skipIf(!chrome)('optional Look greybox references in Chromium', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'look-optional-greyboxes', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: temp => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/musicVideo/CastAndSetsCheckin.jsx'], include: ['react', 'react-dom/client', 'react-router'] },
        plugins: [react(), {
          name: 'look-greybox-fixture', enforce: 'pre',
          resolveId(id) {
            if (id === '/look-greybox-fixture.jsx') return '\0look-greybox-fixture.jsx';
            if (id.endsWith('/hooks/useMusicVideoGreyboxPlaces.js')) return '\0look-greybox-places';
          },
          load(id) {
            if (id === '\0look-greybox-places') return 'export default () => window.fixturePlaces;';
            if (id !== '\0look-greybox-fixture.jsx') return;
            return `
              import React, { useState } from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter } from 'react-router';
              import CastAndSetsCheckin from '/src/components/musicVideo/CastAndSetsCheckin.jsx';
              import '/src/index.css';
              const h = React.createElement;
              const mixed = new URLSearchParams(location.search).get('mode') === 'mixed';
              window.fixturePlaces = {
                'cat-stage': { ingredient: { type: 'place', payload: mixed ? { greybox: { shots: [{ id: 'wide', label: 'Wide' }] } } : {} }, media: mixed ? [{ kind: 'reference', role: 'greybox-shot:wide', mediaKey: 'synthetic.png' }] : [] },
                'cat-garden': { ingredient: { type: 'place', payload: {} }, media: [] },
              };
              const subjects = [{ id: 'stage-place', ingredientId: 'cat-stage', kind: 'place', name: 'Example stage' }, { id: 'garden-place', ingredientId: 'cat-garden', kind: 'place', name: 'Example garden' }];
              const initial = { id: 'example-project', concept: { subjects }, castAndSets: { status: 'review', revision: 1, plan: {}, images: {}, direction: { sets: [{ id: 'stage', name: 'Example stage' }, { id: 'garden', name: 'Example garden' }] } } };
              function Fixture() {
                const [project, setProject] = useState(initial);
                const edit = async ({ sets: updates }) => {
                  const direction = { ...project.castAndSets.direction, sets: project.castAndSets.direction.sets.map(set => set.id === updates[0].id ? { ...set, setReference: updates[0].setReference } : set) };
                  const greyboxPending = direction.sets.some(set => set.setReference?.greyboxShotId);
                  const next = { ...project, castAndSets: { ...project.castAndSets, direction, greyboxPending } };
                  window.lastSelection = updates[0].setReference;
                  setProject(next);
                  return { project: next, stage: next.castAndSets };
                };
                return h(MemoryRouter, null, h('main', { style: { maxWidth: '900px', margin: '0 auto', padding: '8px' } },
                  h(CastAndSetsCheckin, { project, busy: false, onEditDirection: edit, onApprove: () => { window.approvals = (window.approvals || 0) + 1; }, onRegenerate: () => {}, onSkip: () => {} })));
              }
              createRoot(document.getElementById('root')).render(h(Fixture));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/look-greybox-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/look-greybox-test', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/look-greybox-fixture.jsx"></script></body></html>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it.each([390, 1440])('allows ordinary and explicitly selected greybox workflows at %spx', async width => {
    const page = await fixture.browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === new URL(fixture.origin).origin && !/^\/(api|data|socket\.io)(\/|$)/.test(url.pathname)
        ? route.continue() : route.abort();
    });
    try {
      await page.goto(`${fixture.origin}look-greybox-test?mode=none`);
      const approve = page.getByRole('button', { name: 'Approve & continue' });
      await approve.waitFor();
      expect(await approve.isEnabled()).toBe(true);
      expect(await page.locator('details').getAttribute('open')).toBeNull();
      await page.getByText('Greybox references (optional)').click();
      const stagePlate = page.getByText('Set plate · Example stage').locator('..');
      await stagePlate.getByLabel('Set', { exact: true }).selectOption('stage-place');
      expect(await approve.isEnabled()).toBe(true);
      await approve.click();
      expect(await page.evaluate(() => window.approvals)).toBe(1);

      await page.goto(`${fixture.origin}look-greybox-test?mode=mixed`);
      await page.getByText('Greybox references (optional)').click();
      const plate = page.getByText('Set plate · Example stage').locator('..');
      await plate.getByLabel('Set', { exact: true }).selectOption('stage-place');
      expect(await approve.isEnabled()).toBe(true);
      await plate.getByLabel('Camera shot').selectOption('wide');
      expect(await approve.isDisabled()).toBe(true);
      expect(await page.getByText(/Regenerate to render the set plates/).count()).toBe(1);
      expect(await page.evaluate(() => window.lastSelection)).toEqual({ subjectId: 'stage-place', greyboxShotId: 'wide' });
      const controls = await page.locator('details select, details summary').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      }));
      for (const rect of controls) {
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(width);
        expect(rect.width).toBeGreaterThan(20);
      }
      await plate.getByLabel('Set', { exact: true }).selectOption('');
      expect(await approve.isEnabled()).toBe(true);
      expect(await page.evaluate(() => window.lastSelection)).toBeNull();
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60000);
});
