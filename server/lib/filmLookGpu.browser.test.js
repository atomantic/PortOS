/**
 * The GPU film look against the SVG filter it replaces, in the same Chrome:
 * every preset (and a look with every control at its extreme) drawn both ways
 * over one synthetic picture must match within the finishing pass's own
 * 40 dB gate. Uniquely catches a shader that drifts from Chrome's filter
 * pipeline, which the turbulence and kernel unit tests cannot see.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { startOwnedBrowserFixture } from '../test/browserFixture.js';
import { _withTestPreviewLoadDiagnostics } from '../services/musicVideo/testPreviewLoadDiagnostics.js';
import { browserSuiteCanRun, resolveTestChrome } from './browserSuiteGate.js';
import { FILM_LOOK_CONTROLS, FILM_LOOK_PRESETS, filmLookFilterMarkup, filmLookPreset, normalizeFilmLook } from './filmLook.js';
import { filmLookGpuRuntimeSource } from './filmLookGpu.js';

const chrome = resolveTestChrome();
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
  // Isolate the regressions: small blurs were skipped/box-approximated, and
  // translated channels invented colored edge pixels when sampled downstream.
  ['soft focus 0.30', normalizeFilmLook({ defocus: 0.3 })],
  ['soft focus 0.35', normalizeFilmLook({ defocus: 0.35 })],
  ['color fringing 0.40', normalizeFilmLook({ chroma: 0.4 })],
  // Fractional flood rectangles run through a wide blur; Chrome's accelerated
  // blur reads them slightly wider than their subregion (the extreme look
  // drifted to 38.6 dB when the version-2 leak joined the vignette).
  ['light leak 1.00 (version 2)', normalizeFilmLook({ version: 2, leak: 1 })],
  ['vignette 1.00', normalizeFilmLook({ version: 2, vignette: 1 })],
];

const psnr = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return sum === 0 ? 99 : 10 * Math.log10((255 * 255 * a.length) / sum);
};

// The same Chrome uses different SVG blur kernels with GPU compositing and
// software rasterization. Exercise both without changing the pixel oracle.
describe.skipIf(!canRun).each([
  ['default compositor', []],
  ['software compositor', ['--disable-gpu', '--enable-unsafe-swiftshader']],
])('film look on the GPU in Chrome (%s)', (_backend, args) => {
  let fixture, svgPage, gpuPage, available;
  beforeAll(async () => {
    fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true, args } });
    svgPage = await fixture.browser.newPage({ viewport: { width, height } });
    gpuPage = await fixture.browser.newPage({ viewport: { width, height } });
    await svgPage.setContent(page(`${picture}<svg id="fx" width="0" height="0" style="position:absolute"></svg>`));
    await gpuPage.setContent(page(`${picture}<canvas id="out" width="${width}" height="${height}"></canvas><script>${filmLookGpuRuntimeSource()}</script>`));
    available = await gpuPage.evaluate(() => globalThis.__portosFilmLookGpu.available());
    if (available) await gpuPage.evaluate(() => { globalThis.renderer = globalThis.__portosFilmLookGpu.create(document.getElementById('out')); });
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it('keeps translucent color and highlight gradation in the new image finish', async () => {
    const w = 256, h = 2;
    const input = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      input.set([x, x, x, y ? 128 : 255], i);
    }
    const src = (await sharp(input, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()).toString('base64');
    const alphaPage = await fixture.browser.newPage({ viewport: { width: w, height: h } });
    try {
      const built = filmLookFilterMarkup(normalizeFilmLook({ version: 2, shoulder: 0.5, toe: 0.2 }), { width: w, height: h });
      await alphaPage.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;filter:${built.css}}</style>${built.svg}<img width="${w}" height="${h}" src="data:image/png;base64,${src}">`);
      const pixels = await sharp(await alphaPage.screenshot({ omitBackground: true })).ensureAlpha().raw().toBuffer();
      expect(pixels[255 * 4]).toBeGreaterThan(pixels[230 * 4]);
      expect(pixels[255 * 4]).toBeLessThan(255);
      expect(pixels[(w + 128) * 4 + 3]).toBe(128);
      expect(Math.abs(pixels[(w + 128) * 4] - pixels[128 * 4])).toBeLessThanOrEqual(2);
    } finally { await alphaPage.close(); }
  });

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

  // Independent video pixels, not two consumers of one canvas. The untagged
  // SD clip decodes as NV12/SMPTE-C on macOS hardware and I420 in software;
  // only the former omits the primary conversion during canvas staging.
  it.for(['untagged SD', 'converted BT709'])('preserves native source colors and Neon rain for %s', async (kind, { skip }) => {
    if (!available) skip();
    const w = 640, h = 360, tagged = kind === 'converted BT709';
    const dir = mkdtempSync(join(tmpdir(), 'film-look-primary-'));
    const path = join(dir, 'clip.mp4');
    const pages = [];
    try {
      // testsrc is RGB: this performs a real matrix conversion, not a relabel
      // of the SD YUV bytes. Both frame and container tags mirror the encoder.
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        `${tagged ? 'testsrc' : 'testsrc2'}=s=${w}x${h}:r=24`, '-t', '0.25',
        ...(tagged ? ['-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709',
          '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
        '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-y', path], { timeout: 10000 });
      const clip = readFileSync(path);
      const yuv = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', path,
        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'], { timeout: 10000, maxBuffer: w * h * 2 });
      // Uniform bar interiors avoid chroma-siting differences. Decode the
      // independent YUV planes with the declared limited-range 601/709 matrix.
      const xs = [40, 140, 340, 440, 540];
      const rawSamples = xs.map(x => {
        const p = w * h, uv = 100 * (w / 2) + x / 2;
        const y = (yuv[200 * w + x] - 16) / 219, u = (yuv[p + uv] - 128) / 224, v = (yuv[p * 1.25 + uv] - 128) / 224;
        const kr = tagged ? 0.2126 : 0.299, kb = tagged ? 0.0722 : 0.114, kg = 1 - kr - kb;
        return [y + 2 * (1 - kr) * v, y - 2 * kb * (1 - kb) / kg * u - 2 * kr * (1 - kr) / kg * v, y + 2 * (1 - kb) * u]
          .map(c => Math.round(Math.max(0, Math.min(1, c)) * 255));
      });
      const expectedRaw = tagged ? [[0, 0, 0], [0, 254, 255], [254, 255, 0], [0, 255, 1], [0, 0, 0]]
        : [[254, 0, 0], [0, 255, 1], [0, 0, 255], [255, 0, 254], [1, 255, 255]];
      rawSamples.forEach((rgb, i) => rgb.forEach((c, j) => expect(Math.abs(c - expectedRaw[i][j])).toBeLessThanOrEqual(2)));
      const origin = 'http://film-look-primary.test';
      const open = async gpu => {
        const p = await fixture.browser.newPage({ viewport: { width: w, height: h } });
        pages.push(p);
        await p.route(`${origin}/**`, route => route.fulfill(route.request().url().endsWith('.mp4')
          ? { body: clip, contentType: 'video/mp4' }
          : { contentType: 'text/html', body: `<!doctype html><style>*{margin:0}video,canvas{display:block;width:${w}px;height:${h}px}#out{position:fixed;left:0;top:0}</style>
            <video id="v" src="/clip.mp4" muted preload="auto"></video><svg id="fx" width="0" height="0" style="position:absolute"></svg>
            ${gpu ? `<canvas id="out" width="${w}" height="${h}"></canvas><script>${filmLookGpuRuntimeSource()}</script>` : ''}` }));
        await p.goto(`${origin}/`);
        await p.waitForFunction(() => document.getElementById('v').readyState >= 2, null, { timeout: 10000 });
        // The paused first frame is the frame independently decoded above.
        return p;
      };
      const svg = await open(false), gpu = await open(true);
      const metadata = await svg.evaluate(() => {
        const snapshot = new VideoFrame(document.getElementById('v'));
        try { return { format: snapshot.format, ...snapshot.colorSpace.toJSON() }; }
        finally { snapshot.close(); }
      });
      expect(metadata).toMatchObject({ fullRange: false, matrix: tagged ? 'bt709' : 'smpte170m', primaries: tagged ? 'bt709' : 'smpte170m' });
      expect(['NV12', 'I420']).toContain(metadata.format);
      expect(metadata.transfer).toBe(tagged || metadata.format === 'NV12' ? 'bt709' : 'smpte170m');
      const native = await sharp(await svg.screenshot()).removeAlpha().raw().toBuffer();
      if (!tagged) {
        const expectedNative = metadata.format === 'NV12'
          ? [[248, 36, 0], [63, 251, 0], [26, 35, 255], [249, 52, 255], [69, 253, 255]] : rawSamples;
        xs.forEach((x, i) => expectedNative[i].forEach((c, j) => expect(Math.abs(native[(200 * w + x) * 3 + j] - c)).toBeLessThanOrEqual(3)));
      }
      const look = filmLookPreset('neon-rain');
      await gpu.evaluate(({ look, w, h }) => {
        globalThis.primaryRenderer = globalThis.__portosFilmLookGpu.create(document.getElementById('out'));
        globalThis.primaryRenderer.render(document.getElementById('v'), look, { frame: 0, width: w, height: h, until: 0 });
      }, { look, w, h });
      const source = await sharp(await gpu.screenshot()).removeAlpha().raw().toBuffer();
      expect(psnr(native, source)).toBeGreaterThanOrEqual(40);
      const { filter, css } = filmLookFilterMarkup(look, { frame: 0, width: w, height: h });
      await svg.evaluate(({ filter, css }) => {
        document.getElementById('fx').innerHTML = `<defs>${filter}</defs>`;
        document.documentElement.style.filter = css;
      }, { filter, css });
      await gpu.evaluate(({ look, w, h }) => globalThis.primaryRenderer.render(document.getElementById('v'), look, { frame: 0, width: w, height: h }), { look, w, h });
      const reference = await sharp(await _withTestPreviewLoadDiagnostics(svg, () => svg.screenshot(),
        { phase: 'film-look-reference-screenshot' })).removeAlpha().raw().toBuffer();
      const finished = await sharp(await gpu.screenshot()).removeAlpha().raw().toBuffer();
      expect(psnr(reference, finished)).toBeGreaterThanOrEqual(40);
    } finally {
      await Promise.all(pages.map(p => p.close()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  // A video is read the way the page's compositor reads it, scaled to fill the
  // frame. WebGL's own video upload converted colour differently (about 30 dB
  // off on the soft-analog look) and copied another size unscaled.
  it.for(['soft-analog', 'neon-rain', 'vhs'])('draws %s over a video of another size as the page fills the frame', async (preset, { skip }) => {
    let clip;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'film-look-gpu-video-'));
      const path = join(dir, 'clip.webm');
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=480x264:r=24', '-t', '1', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-y', path]);
      clip = readFileSync(path);
      rmSync(dir, { recursive: true, force: true });
    } catch { skip(); }
    if (!available) skip();
    const look = filmLookPreset(preset);
    const origin = 'http://film-look.test';
    const body = (extra) => `<video id="v" src="${origin}/clip.webm" muted style="display:block;width:${width}px;height:${height}px;object-fit:fill"></video>${extra}`;
    const open = async (extra) => {
      const p = await fixture.browser.newPage({ viewport: { width, height } });
      await p.route(`${origin}/**`, (route) => route.fulfill(route.request().url().endsWith('.webm')
        ? { body: clip, contentType: 'video/webm' } : { body: page(body(extra)), contentType: 'text/html' }));
      await p.goto(`${origin}/`);
      await p.evaluate(() => new Promise((resolve) => {
        const v = document.getElementById('v');
        const go = () => { v.addEventListener('seeked', () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true }); v.currentTime = 0.5; };
        if (v.readyState >= 2) go(); else v.addEventListener('loadeddata', go, { once: true });
      }));
      return p;
    };
    const svg = await open('<svg id="fx" width="0" height="0" style="position:absolute"></svg>');
    const gpu = await open(`<canvas id="out" width="${width}" height="${height}"></canvas><script>${filmLookGpuRuntimeSource()}</script>`);
    const { filter, css } = filmLookFilterMarkup(look, { frame, width, height });
    await svg.evaluate(({ filter, css }) => {
      document.getElementById('fx').innerHTML = `<defs>${filter}</defs>`;
      document.documentElement.style.filter = css;
    }, { filter, css });
    await gpu.evaluate(({ look, frame, width, height }) => {
      globalThis.__portosFilmLookGpu.create(document.getElementById('out')).render(document.getElementById('v'), look, { frame, width, height });
    }, { look, frame, width, height });
    const [a, b] = await Promise.all([svg, gpu].map(async (p) => sharp(await p.screenshot()).removeAlpha().raw().toBuffer()));
    await Promise.all([svg.close(), gpu.close()]);
    expect(psnr(a, b)).toBeGreaterThanOrEqual(40);
  }, 60000);
});
