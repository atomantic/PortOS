/** Pixel contracts at the document encoder, ending encoder and isolated live preview. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun, resolveTestChrome } from '../../lib/browserSuiteGate.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
// Native loading preserves browser-inlined function source (Vite rewrites imported identifiers).
vi.mock('../../lib/musicVideoEnding.js', async original => ({ ...await original(), endingPageSource: options => execFileSync(process.execPath, ['--input-type=module', '-e', `import { endingPageSource } from ${JSON.stringify(new URL('../../lib/musicVideoEnding.js', import.meta.url).href)}; process.stdout.write(endingPageSource(JSON.parse(process.argv[1])));`, JSON.stringify(options)], { encoding: 'utf8' }) }));
const chrome = resolveTestChrome();
vi.mock('../browserService.js', () => ({ loadConfig: async () => ({ chromePath: chrome }) }));
vi.mock('../../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-document-vignette-') }));
// A white-base baseline exercises the same encoder with only this fix removed.
const baseline = vi.hoisted(() => ({ white: false }));
vi.mock('../htmlComposition/browser.js', async original => {
  const actual = await original();
  return { ...actual, openComposition: async (...args) => {
    const page = await actual.openComposition(...args);
    const send = page.send;
    page.send = (method, params) => send(method, baseline.white && method === 'Emulation.setDefaultBackgroundColorOverride'
      ? { color: { r: 255, g: 255, b: 255, a: 1 } } : params);
    return page;
  } };
});
const { PATHS } = await import('../../lib/paths.js');
const { findFfmpeg } = await import('../../lib/ffmpeg.js');
const { encodeDocumentComposition, openIsolatedDocumentPreview } = await import('./documentRender.js');
const { renderStatsOutroClip } = await import('./statsOutro.js');
const ffmpeg = await findFfmpeg();
const canRun = browserSuiteCanRun('document vignette', { Chrome: chrome, ffmpeg }, { onUnavailable: cleanupTempDataRoots });
const W = 1280, H = 720;
const frame = path => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
const corners = [[3, 3], [W - 4, 3], [3, H - 4], [W - 4, H - 4]];
const pixel = (raw, x, y) => raw[y * W + x];

describe.skipIf(!canRun)('opaque document film-look canvas with Chrome and ffmpeg', () => {
  afterAll(cleanupTempDataRoots);
  it('composites standalone preview finishes on black without changing authored colors or transparent overlays', async () => {
    const dir = join(PATHS.data, 'standalone-preview');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'index.html');
    const authored = `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#808080}button{position:fixed;left:200px;top:200px}#system{color:CanvasText;background:Canvas}</style></head><body><button>Native control</button><span id="system">System colors</span><script>window.portosComposition={width:1280,height:720,fps:24,durationSec:1,seek:async()=>{}};</script></body></html>`;
    await writeFile(path, authored);
    // Native loading keeps the actual builder's browser-inlined function sources intact.
    const build = look => execFileSync(process.execPath, ['--input-type=module', '-e', `import { buildDocumentPreview } from ${JSON.stringify(new URL('./documentPreview.js', import.meta.url).href)}; const result=await buildDocumentPreview({id:'standalone',scenes:[],audioAnalysis:{durationSec:1},filmLook:JSON.parse(process.argv[2])},{files:new Map([['index.html',{abs:process.argv[1]}]])});process.stdout.write(result.html);`, path, JSON.stringify(look)], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const colors = () => page.evaluate(() => ['button', '#system'].map(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return [style.color, style.backgroundColor, style.colorScheme];
    }));
    const screenshot = async () => sharp(await page.screenshot()).removeAlpha().raw().toBuffer();
    try {
      await page.setContent(authored);
      const originalColors = await colors();
      const html = build({ version: 2, vignette: 0.6 });
      await page.setContent(html);
      await page.evaluate(() => portosComposition.seek(0));
      const raw = await screenshot();
      for (const [x, y] of corners) expect(raw[(y * W + x) * 3]).toBeLessThan(raw[(H / 2 * W + W / 2) * 3] - 25);
      expect(await colors()).toEqual(originalColors);
      // The same document with the opt-in disabled is the pre-fix baseline.
      const neutral = build({ version: 2, contrast: 0.2 });
      await page.setContent(neutral);
      const opaque = await screenshot();
      const legacy = neutral.replace('if (true) {\n      const filter = host.querySelector', 'if (false) {\n      const filter = host.querySelector');
      expect(legacy).not.toBe(neutral);
      await page.setContent(legacy);
      expect(await screenshot()).toEqual(opaque);
      // No-look overlays remain transparent and retain the direct globals used by capture scripts.
      await writeFile(path, authored.replace('background:#808080', 'background:transparent'));
      await page.setContent(build(null));
      expect(await page.evaluate(() => ({ filter: document.documentElement.style.filter, background: getComputedStyle(document.body).backgroundColor, seek: typeof portosComposition.seek })))
        .toEqual({ filter: '', background: 'rgba(0, 0, 0, 0)', seek: 'function' });
      const transparent = await sharp(await page.screenshot({ omitBackground: true })).ensureAlpha().raw().toBuffer();
      expect(transparent[((H - 4) * W + W - 4) * 4 + 3]).toBe(0);
    } finally { await browser.close(); }
  }, 60000);
  it('darkens document and ending corners, preserves a no-vignette look, and keeps the preview opaque', async () => {
    const directory = 'music-video/mv-vignette/composition/doc-vignette';
    const dir = join(PATHS.data, directory);
    await mkdir(dir, { recursive: true });
    // A frame fills the viewport without inline-canvas baseline overflow. Explicit classic
    // scrollbar styling exposes accidental overflow even on macOS overlay-scrollbar hosts.
    const html = `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block}::-webkit-scrollbar{width:16px;height:16px;background:#fff}</style></head><body style="margin:0"><canvas id="stage" width="${W}" height="${H}"></canvas><script>window.portosComposition={width:${W},height:${H},fps:12,durationSec:1,seek:()=>{const c=document.getElementById('stage').getContext('2d');c.fillStyle='#808080';c.fillRect(0,0,${W},${H});}};</script></body></html>`;
    await writeFile(join(dir, 'index.html'), html);
    const audio = join(dir, 'audio.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1', '-y', audio]);
    const project = { id: 'vignette', scenes: [], audioAnalysis: { durationSec: 1, sections: [] }, composition: { mode: 'document', document: { directory } }, filmLook: { version: 2, vignette: 0.6 } };
    const plan = { directory, songDurationSec: 1, frame: { width: W, height: H }, clock: { fps: 12, durationSec: 1, frames: 12 } };
    const encode = async (name, look, white = false) => {
      baseline.white = white;
      const path = join(dir, `${name}.mp4`);
      await encodeDocumentComposition({ project: { ...project, filmLook: look }, plan, jobId: name, audioPath: audio, outputPath: path, windowStart: 0, windowEnd: 1 / 12 });
      return frame(path);
    };
    const dark = await encode('dark', project.filmLook);
    const middle = pixel(dark, W / 2, H / 2);
    for (const [x, y] of corners) expect(pixel(dark, x, y)).toBeLessThan(middle - 25);
    const noVignette = { version: 2, contrast: 0.2 };
    expect(await encode('opaque-black', noVignette)).toEqual(await encode('opaque-white', noVignette, true));
    baseline.white = false;
    const ending = join(dir, 'ending.mp4');
    await renderStatsOutroClip({ project: { ...project, statsOutro: { enabled: true, durationSec: 1 } }, outputPath: ending, width: W, height: H, fps: 1, jobId: 'ending', withFilmLook: true, stats: { floorImages: [] } });
    const outro = frame(ending);
    // The unlit floor is already dark; a white browser base used to wash its corners above 100.
    for (const [x, y] of corners) expect(pixel(outro, x, y)).toBeLessThan(25);
    const preview = await openIsolatedDocumentPreview({ project, jobId: 'live-preview' });
    const page = preview.page;
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
      await page.evaluate('portosComposition.seek(0)');
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      const raw = await sharp(Buffer.from(data, 'base64')).removeAlpha().raw().toBuffer();
      for (const [x, y] of corners) expect(raw[(y * W + x) * 3]).toBeLessThan(raw[(H / 2 * W + W / 2) * 3] - 25);
    } finally { await page.close(); await rm(preview.scratchRoot, { recursive: true, force: true }); }
  }, 120000);
});
