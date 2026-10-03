// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
// Prefer the client dev dependency; linked worktrees can also use the same
// pinned driver from the server without installing into shared node_modules.
const { chromium } = require(require.resolve('playwright-core', { paths: [
  fileURLToPath(new URL('../../..', import.meta.url)),
  fileURLToPath(new URL('../../../../server', import.meta.url)),
] }));
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

// This fixture exercises the real toolbar and Tailwind CSS with synthetic goals.
// Only WebGL is replaced: the canvas stub retains the production sizing props.
describe.skipIf(!chrome)('Goals Tree touch targets', () => {
  let server, browser, browserTemp, origin;
  beforeAll(async () => {
    browserTemp = await mkdtemp(join(tmpdir(), 'goals-touch-'));
    server = await createServer({
      configFile: false,
      cacheDir: join(browserTemp, 'vite-cache'),
      root: fileURLToPath(new URL('../../..', import.meta.url)),
      plugins: [react(), {
        name: 'goals-touch-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id === '/goals-fixture.jsx') return '\0goals-fixture.jsx';
          if (id === '@react-three/fiber') return '\0canvas-stub';
          if (id.endsWith('/useProviderModels')) return '\0provider-stub';
        },
        load(id) {
          if (id === '\0canvas-stub') return `
            import React from 'react';
            export const Canvas = ({ style }) => React.createElement('div', { 'data-testid': 'canvas', style });
            export const useFrame = () => {};
            export const useThree = () => null;
            export const extend = () => {};
          `;
          if (id === '\0provider-stub') return `
            export default () => ({ providers: [], selectedProviderId: '', selectedModel: '',
              availableModels: [], setSelectedProviderId: () => {}, setSelectedModel: () => {}, loading: false });
          `;
          if (id !== '\0goals-fixture.jsx') return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import GoalsTreeView from '/src/components/goals/GoalsTreeView.jsx';
            import '/src/index.css';
            const data = { flat: [
              { id: 'example-1', title: 'Example apex', category: 'mastery', horizon: 'lifetime', goalType: 'apex' },
              { id: 'example-2', title: 'Example craft', category: 'creative', horizon: '3-year', parentId: 'example-1' },
              { id: 'example-3', title: 'Example practice', category: 'mastery', horizon: '5-year', parentId: 'example-1' },
            ] };
            createRoot(document.getElementById('root')).render(React.createElement(GoalsTreeView, { data, onRefresh: () => {} }));
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/goals-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/goals-test',
              '<style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="/goals-fixture.jsx"></script>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    origin = server.resolvedUrls.local[0];
    browser = await chromium.launch({ executablePath: chrome, headless: true,
      env: { ...process.env, TMPDIR: browserTemp, TMP: browserTemp, TEMP: browserTemp } });
  }, 60000);
  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      await server?.close();
      if (browserTemp) await rm(browserTemp, { recursive: true, force: true });
    }
  });

  it.each([[360, 800], [768, 1024], [1440, 900]])('keeps targets usable at %sx%s', async (width, height) => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      // No live API or external service is reachable from this fixture.
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === new URL(origin).origin && !url.pathname.startsWith('/api/')
          ? route.continue() : route.fulfill({ contentType: 'application/json', body: '{}' });
      });
      await page.goto(origin + 'goals-test');
      const names = ['Creative', 'Family', 'Health', 'Financial', 'Legacy', 'Mastery', 'Labels', 'Add', 'Organize'];
      const boxes = [];
      for (const name of names) {
        const button = page.getByRole('button', { name, exact: true });
        await button.waitFor();
        const box = await button.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        boxes.push(box);
        expect(await button.evaluate(el => {
          const r = el.getBoundingClientRect();
          return [-20, 20].every(offset => el.contains(document.elementFromPoint(r.x + r.width / 2 + offset, r.y + r.height / 2)));
        })).toBe(true);
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
      const canvas = await page.getByTestId('canvas').boundingBox();
      expect(canvas.y).toBeGreaterThanOrEqual(Math.max(...boxes.map(b => b.y + b.height)));
      expect(canvas.height).toBeGreaterThan(height / 2);
      await page.getByRole('button', { name: 'Creative', exact: true }).click();
      await page.waitForFunction(() => document.body.textContent.includes('2 nodes'));
      const labels = page.getByRole('button', { name: 'Labels', exact: true });
      await labels.click();
      expect(await labels.getAttribute('aria-pressed')).toBe('false');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      const form = await page.getByRole('textbox', { name: 'New goal title' }).boundingBox();
      expect(form.y).toBeGreaterThan(Math.max(...boxes.map(b => b.y + b.height)));
      expect(await page.getByRole('button', { name: 'Organize', exact: true }).isDisabled()).toBe(true);
    } finally { await page.close(); }
  }, 60000);
});
