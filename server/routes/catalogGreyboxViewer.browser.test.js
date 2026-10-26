import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun, resolveClientBundler, resolveTestChrome } from '../lib/browserSuiteGate.js';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../scripts/lib/browserFixture.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const client = join(root, 'client');
const chrome = resolveTestChrome();
const bundler = resolveClientBundler(root);
const canRun = browserSuiteCanRun('Environment greybox viewer', { chrome, clientBundler: bundler });

// An asymmetric L makes a mirrored Z axis visibly different from the intended
// floor. The overhead camera gives independently calculable world/pixel marks.
const scene = {
  version: 1, source: 'spec',
  parts: [{ id: 'floor', label: 'L floor', type: 'extrude', outline: [[-4, -1], [3, -1], [3, 1], [-1, 1], [-1, 4], [-4, 4]],
    height: 0.5, position: [0, 0, 0], rotationDegrees: [0, 0, 0], zone: 'floor-zone' }],
  zones: [{ id: 'floor-zone', label: 'Floor', color: '#38b85a' }],
  landmarks: [{ id: 'mark', label: 'Example landmark', position: [-3, 0.5, 2] }],
  anchors: [{ id: 'figure', label: 'Example figure', kind: 'figure', position: [0, 0.5, 0], heightMeters: 1.7, facingDegrees: 0 }],
  shots: [{ id: 'overhead', label: 'Overhead', position: [0, 12, 0.01], target: [0, 0, 0], focalLengthMm: 28, aspect: '16:9', figures: [{ anchorId: 'figure', pose: 'Standing' }] }],
};

async function openEnvironment(fixture, { warmup = false } = {}) {
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    // Only timing/method names from this synthetic fixture, capped per page.
    window.greyboxGpuCalls = [];
    for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      for (const method of ['compileShader', 'linkProgram', 'getProgramParameter', 'getShaderParameter', 'drawElements', 'drawArrays']) {
        const original = type?.prototype[method];
        if (!original) continue;
        type.prototype[method] = function (...args) {
          const start = performance.now();
          try { return original.apply(this, args); }
          finally {
            const elapsed = Math.round(performance.now() - start);
            if (elapsed >= 100 && window.greyboxGpuCalls.length < 32) window.greyboxGpuCalls.push({ method, elapsed });
          }
        };
      }
    }
  });
  const state = { captures: [], errors: [], viewerRequests: 0, phase: 'navigation' };
  const ingredient = { id: 'example-place', type: 'place', name: 'Example environment', tags: [], payload: { description: 'Synthetic browser fixture', greybox: structuredClone(scene) } };
  const media = [];
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') state.errors.push(message.text()); });
  // No live records, sockets, providers or external network. Only the real
  // client modules and the explicitly enumerated synthetic HTTP responses run.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(fixture.origin).origin || url.pathname.startsWith('/socket.io')) return route.abort();
    if (url.pathname.includes('/GreyboxViewer.jsx')) state.viewerRequests++;
    if (url.pathname === '/api/catalog/types') return route.fulfill({ json: { types: [] } });
    if (url.pathname === '/api/providers') return route.fulfill({ json: [] });
    if (url.pathname === '/api/catalog/ingredients/example-place/details') return route.fulfill({ json: { ingredient, media, relations: { outbound: [], inbound: [] }, refs: [], sources: [], missingMedia: [] } });
    if (url.pathname === '/api/catalog/ingredients/example-place/greybox' && route.request().method() === 'PUT') {
      ingredient.payload.greybox = route.request().postDataJSON().greybox;
      return route.fulfill({ json: ingredient });
    }
    if (url.pathname === '/api/catalog/ingredients/example-place/greybox/shots/overhead/capture') {
      state.captures.push(route.request().postDataJSON());
      const row = { id: 'capture', kind: 'reference', role: 'greybox-shot:overhead', mediaKey: 'example-capture.png' };
      media.splice(0, media.length, row);
      return route.fulfill({ json: row });
    }
    if (url.pathname === '/data/images/example-capture.png') return route.fulfill({ contentType: 'image/png', body: Buffer.from(state.captures.at(-1).dataBase64, 'base64') });
    if (url.pathname.startsWith('/api/')) {
      state.errors.push(`Unexpected fixture API: ${url.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  try {
    await page.goto(`${fixture.origin}environments/example-place/plates`);
    state.phase = 'Greybox tab';
    await page.getByRole('tab', { name: 'Greybox', exact: true }).waitFor();
    if (warmup) {
      state.phase = 'lazy chunk compilation';
      await page.evaluate("import('/src/components/catalog/GreyboxViewer.jsx').then(() => true)");
      return { page, state, ingredient };
    }
    expect(state.viewerRequests).toBe(0);
    // Keep bounded, synthetic-only evidence when Chromium's actionability
    // check stalls. Timer samples distinguish moving layout from a renderer
    // that stopped producing animation frames; neither retries the action.
    await page.evaluate(() => {
      const evidence = { frames: 0, samples: [], started: performance.now() };
      let frame;
      const tick = () => { evidence.frames++; frame = requestAnimationFrame(tick); };
      frame = requestAnimationFrame(tick);
      const timer = setInterval(() => {
        const button = [...document.querySelectorAll('button')].find(el => el.textContent.includes('Overhead'));
        evidence.samples.push({ elapsed: Math.round(performance.now() - evidence.started), frames: evidence.frames,
          rect: button?.getBoundingClientRect().toJSON(), disabled: button?.disabled,
          visibility: document.visibilityState, fonts: document.fonts.status });
        if (evidence.samples.length === 44) { clearInterval(timer); cancelAnimationFrame(frame); }
      }, 250);
      window.greyboxReadinessEvidence = () => {
        clearInterval(timer); cancelAnimationFrame(frame);
        delete window.greyboxReadinessEvidence;
        return evidence;
      };
    });
    state.phase = 'viewer attachment';
    await page.getByRole('tab', { name: 'Greybox', exact: true }).click();
    await page.locator('[data-testid="greybox-viewer"] canvas').waitFor({ state: 'attached' });
    state.phase = 'shot selection';
    await page.getByRole('button', { name: /Overhead/, pressed: false }).click();
    await page.waitForFunction(() => document.querySelector('#greybox-lens')?.value === '28');
    // Demand rendering and Html placement finish after React commits.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.locator('[data-testid="greybox-viewer"] canvas').isVisible()).toBe(true);
    await page.evaluate(() => window.greyboxReadinessEvidence?.());
    const slowGpuCalls = await page.evaluate(() => window.greyboxGpuCalls);
    if (slowGpuCalls.length) console.info(`Greybox startup GPU calls: ${JSON.stringify(slowGpuCalls)}`);
    return { page, state, ingredient };
  } catch (error) {
    const readiness = await page.evaluate(() => ({ ...window.greyboxReadinessEvidence?.(), gpuCalls: window.greyboxGpuCalls }));
    const viewers = await page.getByTestId('greybox-viewer').evaluateAll(elements => elements.map(el => ({
      rect: el.getBoundingClientRect().toJSON(), canvases: [...el.querySelectorAll('canvas')].map(c => ({
        rect: c.getBoundingClientRect().toJSON(), width: c.width, height: c.height, visibility: getComputedStyle(c).visibility, display: getComputedStyle(c).display,
      })),
    })));
    await page.close();
    throw new Error(`${state.phase}: ${error.message}; viewers: ${JSON.stringify(viewers)}; readiness: ${JSON.stringify(readiness)}; browser errors: ${state.errors.join('; ')}`, { cause: error });
  }
}

// Read the uploaded PNG with the browser's decoder, independently of Three.js.
// Floor samples use the 24mm sensor height and the 11.5m camera/top separation.
async function capturePixels(page, dataBase64, focalLengthMm = 28) {
  return page.evaluate(async ({ dataBase64, focalLengthMm }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${dataBase64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0; let squares = 0;
    for (let i = 0; i < data.length; i += 4) { sum += data[i]; squares += data[i] ** 2; }
    const count = data.length / 4;
    const span = 2 * 11.5 * 12 / focalLengthMm;
    const sample = ([x, z]) => {
      const px = Math.round(canvas.width / 2 + x * canvas.height / span);
      const py = Math.round(canvas.height / 2 + z * canvas.height / span);
      const at = (py * canvas.width + px) * 4;
      return Array.from(data.slice(at, at + 3));
    };
    return { width: canvas.width, height: canvas.height, variance: squares / count - (sum / count) ** 2,
      floor: [[-2, 3], [-2, 0], [2, 0]].map(sample), outside: [[2, 3], [-2, -3], [0, 3]].map(sample) };
  }, { dataBase64, focalLengthMm });
}

const canvasState = page => page.locator('[data-testid="greybox-viewer"] canvas').evaluate(canvas => ({
  width: canvas.width, height: canvas.height, cssWidth: canvas.getBoundingClientRect().width,
  cssHeight: canvas.getBoundingClientRect().height, pixels: canvas.toDataURL(),
}));

async function waitForRedraw(page, previous) {
  await page.waitForFunction(pixels => document.querySelector('[data-testid="greybox-viewer"] canvas').toDataURL() !== pixels, previous.pixels);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

describe.skipIf(!canRun)('Environment greybox in Chromium', () => {
  let fixture;
  // Separate browser processes keep one scenario's WebGL lifecycle from
  // delaying the next. Warmup compiles the lazy chunk without mounting a canvas.
  beforeEach(async () => {
    fixture = undefined;
    const { createServer } = await import(bundler[0]);
    const { default: react } = await import(bundler[1]);
    const { default: tailwind } = await import(bundler[2]);
    fixture = await startBrowserFixture({
      name: 'catalog-greybox', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
      viteConfig: temp => ({
        configFile: false, root: client, cacheDir: join(temp, 'vite-cache'),
        css: { postcss: { plugins: [tailwind({ base: client })] } },
        resolve: { dedupe: ['three'] },
        optimizeDeps: { entries: ['src/pages/CatalogIngredient.jsx', 'src/components/catalog/GreyboxPanel.jsx', 'src/components/catalog/GreyboxViewer.jsx'], include: ['react', 'react-dom/client', 'react-router'] },
        plugins: [react(), {
          name: 'greybox-browser-fixture', enforce: 'pre',
          resolveId(id) {
            if (id === '/greybox-fixture.jsx') return '\0greybox-fixture';
            if (/\/services\/socket(?:\.js)?$/.test(id)) return '\0greybox-socket';
          },
          load(id) {
            if (id === '\0greybox-socket') return 'export default { on() {}, off() {} };';
            if (id !== '\0greybox-fixture') return;
            return `
              import React from 'react';
              import { createRoot } from 'react-dom/client';
              import { createBrowserRouter, RouterProvider } from 'react-router';
              import CatalogIngredient from '/src/pages/CatalogIngredient.jsx';
              import { THEMES } from '/src/themes/portosThemes.js';
              import '/src/index.css';
              window.setFixtureTheme = id => {
                const theme = THEMES[id];
                document.documentElement.dataset.portTheme = id;
                document.documentElement.dataset.portThemeFamily = theme.family;
                for (const [key, value] of Object.entries({ ...theme.colors, ...theme.tokens })) document.documentElement.style.setProperty(key, value);
              };
              window.setFixtureTheme('lumen-glass-day');
              createRoot(document.getElementById('root')).render(
                React.createElement(RouterProvider, { router: createBrowserRouter([
                  { path: '/environments/:id/:tab?', element: React.createElement(CatalogIngredient) }
                ]) }));`;
          },
          configureServer(vite) {
            vite.middlewares.use('/environments', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/greybox-test', '<div id="root"></div><script type="module" src="/greybox-fixture.jsx"></script>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
      warmup: async (page, origin) => {
        await openEnvironment({ browser: { newPage: async () => page }, origin }, { warmup: true });
      },
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterEach(() => fixture?.close());

  it('uploads an oriented L floor at fixed landscape/portrait resolution and restores the HiDPI viewport', async () => {
    const { page, state, ingredient } = await openEnvironment(fixture);
    try {
      expect(state.viewerRequests).toBeGreaterThan(0);
      expect(new URL(page.url()).searchParams.get('shot')).toBe('overhead');
      for (const [aspect, width, height] of [['16:9', 1280, 720], ['9:16', 720, 1280]]) {
        await page.getByRole('combobox', { name: /^Frame/ }).selectOption(aspect);
        await page.waitForFunction(ratio => { const c = document.querySelector('[data-testid="greybox-viewer"] canvas'); return Math.abs(c.width / c.height - ratio) < 0.01; }, width / height);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const before = await canvasState(page);
        await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/details?view=media')),
          page.getByRole('button', { name: /(?:Capture|Replace) reference image/ }).click(),
        ]);
        const pixels = await capturePixels(page, state.captures.at(-1).dataBase64);
        expect(pixels).toMatchObject({ width, height });
        expect(pixels.variance).toBeGreaterThan(100);
        for (const [r, g, b] of pixels.floor) { expect(g).toBeGreaterThan(r * 1.3); expect(g).toBeGreaterThan(b * 1.2); }
        for (const [r, g, b] of pixels.outside) expect(Math.max(r, g, b)).toBeLessThan(60);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const { pixels: _beforePixels, ...beforeSize } = before;
        const { pixels: _afterPixels, ...afterSize } = await canvasState(page);
        expect(afterSize).toEqual(beforeSize);
        expect(ingredient.payload.greybox.shots[0].aspect).toBe(aspect);
      }
      expect(state.errors).toEqual([]);
    } finally { await page.close(); }
  }, 60000);

  it('redraws the demand canvas when the lens or frame changes and keeps labels readable in day/night themes', async () => {
    const { page, state } = await openEnvironment(fixture);
    try {
      const original = await canvasState(page);
      await page.getByLabel(/Lens:/).press('ArrowRight');
      await waitForRedraw(page, original);
      const longerLens = await canvasState(page);
      expect(longerLens.width).toBe(original.width);
      expect(longerLens.height).toBe(original.height);
      await page.getByRole('combobox', { name: /^Frame/ }).selectOption('1:1');
      await waitForRedraw(page, longerLens);
      const square = await canvasState(page);
      expect(square.cssWidth / square.cssHeight).toBeCloseTo(1, 2);
      const squarePixels = await capturePixels(page, square.pixels.split(',')[1], 29);
      for (const [r, g, b] of squarePixels.floor) { expect(g).toBeGreaterThan(r * 1.3); expect(g).toBeGreaterThan(b * 1.2); }
      await page.getByLabel(/Lens:/).press('ArrowLeft');
      for (const theme of ['lumen-glass-day', 'kestrel-neon']) {
        await page.evaluate(theme => window.setFixtureTheme(theme), theme);
        for (const text of ['Example landmark', 'Example figure']) {
          const label = page.getByTestId('greybox-viewer').getByText(text, { exact: true });
          await label.waitFor({ state: 'visible' });
          expect(await label.evaluate(el => getComputedStyle(el).fontSize)).toBe('10px');
          const contrast = await label.evaluate(label => {
            const style = getComputedStyle(label);
            const luminance = color => {
              const rgb = color.match(/[\d.]+/g).slice(0, 3).map(v => Number(v) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
              return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
            };
            const ink = luminance(style.color); const surface = luminance(style.backgroundColor);
            return { ratio: (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05), color: style.color, background: style.backgroundColor };
          });
          expect(contrast.ratio, JSON.stringify({ theme, text, ...contrast })).toBeGreaterThanOrEqual(4.5);
        }
        if (process.env.GREYBOX_VISUAL_ARTIFACTS) {
          await page.getByTestId('greybox-viewer').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
          await page.screenshot({
            clip: await page.getByTestId('greybox-viewer').boundingBox(), animations: 'disabled',
            path: join(process.env.GREYBOX_VISUAL_ARTIFACTS, `${theme}.png`),
          });
        }
      }
      expect(state.errors).toEqual([]);
    } finally { await page.close(); }
  }, 60000);
});
