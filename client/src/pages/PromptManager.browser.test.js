// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../test/browserFixture.js';

vi.setConfig({ testTimeout: 30000 });

const require = createRequire(import.meta.url);
// Prefer the client dev dependency; linked worktrees can also use the same
// pinned driver from the server without installing into shared node_modules.
const { chromium } = require(require.resolve('playwright-core', { paths: [
  fileURLToPath(new URL('../..', import.meta.url)),
  fileURLToPath(new URL('../../../server', import.meta.url)),
] }));
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

// Where the Layout would put the page: the viewport minus the sidebar. The
// fixture draws that box itself, so the matrix can vary navigation state.
const NAV_EXPANDED = 256;
const NAV_COLLAPSED = 64;
const SCENARIOS = [
  [1440, 900, NAV_EXPANDED], [1280, 800, NAV_EXPANDED], [1024, 768, NAV_EXPANDED],
  [1024, 768, NAV_COLLAPSED], [768, 1024, NAV_COLLAPSED], [390, 844, 0], [320, 812, 0],
];
const TABS = [
  ['stages', 'stage=family-3-stage-1', 'Save'],
  ['variables', 'tab=variables&var=var-6', 'Save'],
  ['job-skills', 'tab=job-skills&skill=skill-5', 'Save'],
];

describe.skipIf(!chrome)('Prompt Manager selection-first workspace geometry (#11142)', () => {
  let fixture;
  let browser;
  let origin;
  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'prompt-manager',
      createServer,
      chromium,
      viteConfig: temp => ({
        configFile: false,
        cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: {
          entries: ['src/pages/PromptManager.jsx'],
          include: ['react-dom/client', 'react-router', 'lucide-react'],
        },
        root: fileURLToPath(new URL('../..', import.meta.url)),
        plugins: [react(), {
          name: 'prompt-manager-browser-fixture',
          enforce: 'pre',
          resolveId(id, importer) {
            if (id === '/prompt-fixture.jsx') return '\0prompt-fixture.jsx';
            if (importer?.endsWith('/PromptManager.jsx')) {
              if (id === '../services/apiPrompts') return '\0prompt-api';
              if (id === '../services/apiProviders') return '\0prompt-providers';
              if (id === '../components/settings/SettingsTabsHeader') return '\0prompt-tabs-header';
            }
          },
          load(id) {
            // 17 synthetic stage families (all collapsed but the selected one),
            // 8+ variables and 8+ skills: the catalogues the audit measured.
            if (id === '\0prompt-api') return `
              const stages = {};
              for (let f = 1; f <= 17; f++) for (let s = 1; s <= 4; s++) {
                stages['family-' + f + '-stage-' + s] = { name: 'Family ' + f + ' — Stage ' + s, description: 'Example stage' };
              }
              const variables = {};
              for (let v = 1; v <= 8; v++) variables['var-' + v] = { name: 'Variable ' + v, category: 'rules', content: 'example ' + v };
              const skills = [];
              for (let k = 1; k <= 8; k++) skills.push({ name: 'skill-' + k, jobId: 'job-' + k, hasTemplate: true });
              export const getPrompts = async () => ({ stages, systemStages: [] });
              export const getPrompt = async (name) => ({ name: stages[name].name, template: 'example template', variables: [] });
              export const getPromptVariables = async () => ({ variables });
              export const getJobSkills = async () => ({ skills });
              export const getJobSkill = async (name) => ({ content: '# ' + name, jobName: 'Job ' + name, jobId: 'job-' + name, category: 'maintenance', interval: 'daily' });
              const none = async () => ({});
              export const createPrompt = none, savePrompt = none, deletePrompt = none, previewPrompt = none, getPromptUsage = none,
                createPromptVariable = none, savePromptVariable = none, deletePromptVariable = none, saveJobSkill = none, previewJobSkill = none;
            `;
            if (id === '\0prompt-providers') return 'export const getProviders = async () => ({ providers: [], activeProvider: null });';
            if (id === '\0prompt-tabs-header') return 'export default function SettingsTabsHeader() { return null; }';
            if (id !== '\0prompt-fixture.jsx') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { MemoryRouter } from 'react-router';
              import PromptManager from '/src/pages/PromptManager.jsx';
              import '/src/index.css';
              const q = new URLSearchParams(location.search);
              const entry = '/prompts?' + (q.get('entry') || '');
              createRoot(document.getElementById('root')).render(
                React.createElement('div', { style: { width: q.get('w') + 'px', height: '100vh', marginLeft: 'auto' } },
                  React.createElement(MemoryRouter, { initialEntries: [entry] }, React.createElement(PromptManager)))
              );
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/prompt-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/prompt-test',
                '<div id="root"></div><script type="module" src="/prompt-fixture.jsx"></script>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
      launchOptions: { executablePath: chrome },
      warmup: async (page, url) => {
        await page.goto(`${url}prompt-test?w=1000&entry=stage%3Dfamily-1-stage-1`, { timeout: 20000 });
        await page.getByRole('button', { name: /^Save$/ }).waitFor({ timeout: 10000 });
      },
    });
    ({ browser, origin } = fixture);
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close(), 60000);

  for (const [tabName, entry] of TABS) {
    it.each(SCENARIOS)(`${tabName}: selected editor action is above the fold at %ix%i (nav %ipx)`, async (width, height, nav) => {
      const page = await browser.newPage({ viewport: { width, height } });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`${origin}prompt-test?w=${width - nav}&entry=${encodeURIComponent(entry)}`, { timeout: 15000 });
        const save = page.getByRole('button', { name: /^Save$/ });
        await save.waitFor();
        // The workspace re-lays out after mount (container measurement, then
        // the selected record loads), so a box read straight after waitFor can
        // be null or pre-layout. Poll until two consecutive reads agree.
        let previous = null;
        await expect.poll(async () => {
          const next = await save.boundingBox().catch(() => null);
          const stable = next && previous && ['x', 'y', 'width', 'height'].every(k => next[k] === previous[k]);
          previous = next;
          return Boolean(stable);
        }, { timeout: 8000, interval: 100 }).toBe(true);
        const box = await save.boundingBox();
        // The primary action sits inside the first screen without scrolling.
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
        // Nothing is clipped sideways.
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        const narrow = width - nav - 32 < 720;
        const chooser = page.getByRole('button', { name: /Choose another/ });
        await expect.poll(() => chooser.count(), { timeout: 8000 }).toBe(narrow ? 1 : 0);
        if (narrow) {
          await chooser.click();
          const drawer = page.getByRole('dialog');
          await drawer.waitFor();
          const drawerBox = await drawer.boundingBox();
          expect(drawerBox.x).toBeGreaterThanOrEqual(0);
          expect(drawerBox.x + drawerBox.width).toBeLessThanOrEqual(width);
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }
});
