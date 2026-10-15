/**
 * The GPU film look against the SVG filter it replaces, in the same Chrome:
 * every preset (and a look with every control at its extreme) drawn both ways
 * over one synthetic picture must match within the finishing pass's own
 * 40 dB gate. Uniquely catches a shader that drifts from Chrome's filter
 * pipeline, which the turbulence and kernel unit tests cannot see.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { startOwnedBrowserFixture } from '../test/browserFixture.js';
import { browserSuiteCanRun } from './browserSuiteGate.js';
import { FILM_LOOK_CONTROLS, FILM_LOOK_PRESETS, filmLookFilterMarkup, filmLookPreset, normalizeFilmLook } from './filmLook.js';
import { filmLookGpuRuntimeSource } from './filmLookGpu.js';

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((path) => path && existsSync(path));
const canRun = browserSuiteCanRun('film look GPU browser', { Chrome: chrome });
const width = 320;
const height = 180;
const frame = 17;

// A deterministic picture with edges, gradients and saturated color for the blurs and blends to act on.
const picture = `<canvas id="src" width="${width}" height="${height}"></canvas><script>
  const c = document.getElementById('src').getContext('2d');
  const g = c.createLinearGradient(0, 0, ${width}, ${height});
  g.addColorStop(0, '#261349'); g.addColorStop(0.5, '#e8bf43'); g.addColorStop(1, '#0f6f8f');
  c.fillStyle = g; c.fillRect(0, 0, ${width}, ${height});
  for (let i = 0; i < 24; i++) { c.fillStyle = 'hsl(' + (i * 47 % 360) + ',90%,' + (30 + i % 5 * 12) + '%)'; c.fillRect((i * 53) % ${width}, (i * 31) % ${height}, 18 + i % 7 * 6, 10 + i % 4 * 9); }
  c.fillStyle = '#fff'; c.fillRect(${width / 2 - 6}, 20, 12, ${height - 40});
</script>`;
const page = (body) => `<!doctype html><html><head><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}canvas{display:block;width:${width}px;height:${height}px}#out{position:fixed;left:0;top:0}</style></head><body>${body}</body></html>`;
// Every slider at its far end (the signed ones at their negative end, which is the harder one to draw).
const extreme = normalizeFilmLook(Object.fromEntries(FILM_LOOK_CONTROLS.map((control) => [control.id,
  control.type === 'toggle' ? true : control.type === 'color' ? control.def : control.min < 0 ? control.min : control.max])));
const looks = [
  ...FILM_LOOK_PRESETS.filter(({ id }) => id !== 'none').map(({ id }) => [id, filmLookPreset(id)]),
  ['every control at its extreme', extreme],
];

const psnr = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return sum === 0 ? 99 : 10 * Math.log10((255 * 255 * a.length) / sum);
};

describe.skipIf(!canRun)('film look on the GPU in Chrome', () => {
  let fixture, svgPage, gpuPage, available;
  beforeAll(async () => {
    fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } });
    svgPage = await fixture.browser.newPage({ viewport: { width, height } });
    gpuPage = await fixture.browser.newPage({ viewport: { width, height } });
    await svgPage.setContent(page(`${picture}<svg id="fx" width="0" height="0" style="position:absolute"></svg>`));
    await gpuPage.setContent(page(`${picture}<canvas id="out" width="${width}" height="${height}"></canvas><script>${filmLookGpuRuntimeSource()}</script>`));
    available = await gpuPage.evaluate(() => globalThis.__portosFilmLookGpu.available());
    if (available) await gpuPage.evaluate(() => { globalThis.renderer = globalThis.__portosFilmLookGpu.create(document.getElementById('out')); });
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it.for(looks)('draws %s within 40 dB of the SVG filter', async ([, look], { skip }) => {
    // A Chrome without WebGL2 keeps the SVG filter; there is nothing to compare.
    if (!available) skip();
    const { filter, css } = filmLookFilterMarkup(look, { frame, width, height });
    await svgPage.evaluate(({ filter, css }) => {
      document.getElementById('fx').innerHTML = `<defs>${filter}</defs>`;
      document.documentElement.style.filter = css;
    }, { filter, css });
    await gpuPage.evaluate(({ look, frame, width, height }) => {
      globalThis.renderer.render(document.getElementById('src'), look, { frame, width, height });
    }, { look, frame, width, height });
    const [svg, gpu] = await Promise.all([svgPage, gpuPage].map(async (p) => sharp(await p.screenshot()).removeAlpha().raw().toBuffer()));
    expect(psnr(svg, gpu)).toBeGreaterThanOrEqual(40);
  }, 60000);
});
