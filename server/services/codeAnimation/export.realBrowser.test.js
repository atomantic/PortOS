// Real-browser acceptance for the frame-exact Code Animation export (#9083):
// the staged document runs in real Chrome, renderComposition encodes it with
// real ffmpeg, and the MP4 is compared to direct renderFrame(t) screenshots.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { findFfmpeg, findFfprobe } from '../../lib/ffmpeg.js';
import { _cleanupTestBrowser, _waitForTestChrome } from '../htmlComposition/testBrowserCleanup.js';

const state = vi.hoisted(() => ({ html: '' }));
let endpoint;
vi.mock('../browserService.js', () => ({ cdpRequest: path => fetch(`${endpoint}${path}`) }));
vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-code-animation-export-'),
}));
vi.mock('../../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-code-animation-export-'),
}));
vi.mock('./jobStore.js', () => ({
  isCodeAnimationJobId: () => true,
  getCodeAnimationJobRecord: async () => ({ id: 'job', status: 'completed', frame: { width: 1280, height: 720, fps: 12, durationSeconds: 1 } }),
  readCodeAnimationHtml: async () => state.html,
}));

const { startCodeAnimationExport } = await import('./export.js');
const { renderComposition } = await import('../htmlComposition/index.js');
const { PATHS } = await import('../../lib/fileUtils.js');

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));
const ffmpeg = await findFfmpeg();
const ffprobe = await findFfprobe();

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 12;
const FRAMES = 12;
const FRAME_BYTES = WIDTH * HEIGHT * 3;

// A film whose every frame differs (moving square over a shifting background,
// so a duplicated or skipped frame cannot hide) and whose renderFrame blocks
// the page for ~200ms. The controls overlay sits ON TOP of the canvas: the
// export must hide it, while the reference screenshot below hides it the same way.
const FIXTURE = `<!doctype html><html><head><style>
body { margin: 0; background: #222; } canvas { display: block; }
#controls { position: fixed; left: 0; top: 0; width: 400px; height: 200px; background: rgb(0,255,0); z-index: 2147483647; }
</style></head><body>
<canvas id="film" width="${WIDTH}" height="${HEIGHT}"></canvas>
<div id="controls">controls</div>
<script>
window.ANIMATION_META = { title: 'Acceptance', duration: 1, fps: ${FPS}, width: ${WIDTH}, height: ${HEIGHT} };
window.renderFrame = (t) => {
  const end = performance.now() + 200;
  while (performance.now() < end) { /* slow frame on purpose */ }
  const ctx = document.getElementById('film').getContext('2d');
  ctx.fillStyle = 'hsl(' + Math.round(t * 300) + ', 60%, 30%)';
  ctx.fillRect(0, 0, ${WIDTH}, ${HEIGHT});
  ctx.fillStyle = 'rgb(255,255,255)';
  ctx.fillRect(40 + t * 1000, 300, 120, 120);
};
</script></body></html>`;

let proc;
let browser;
const decodeRaw = (input, extra = []) => execFileSync(ffmpeg, ['-v', 'error', '-i', input, ...extra, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 80 * 1024 * 1024 });
const meanAbsDiff = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

describe.skipIf(!chrome || !ffmpeg || !ffprobe)('Code Animation frame-exact export with real Chrome and ffmpeg', () => {
  beforeAll(async () => {
    const profile = join(lazyTempDataRoot('portos-code-animation-export-'), 'chrome-test-profile');
    proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      const ws = await _waitForTestChrome(proc);
      endpoint = new URL(ws).origin.replace('ws:', 'http:');
      browser = await chromium.connectOverCDP(endpoint);
    } catch (error) {
      try {
        await _cleanupTestBrowser({ browser, proc, cleanup: cleanupTempDataRoots });
        proc = undefined;
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${error.message}; cleanup: ${cleanupError.message}`);
      }
      throw error;
    }
  }, 30000);

  afterAll(() => _cleanupTestBrowser({ browser, proc, cleanup: cleanupTempDataRoots }));

  it('exports duration × fps unique frames from a slow renderFrame, matching direct screenshots, as BT.709 H.264 with the controls hidden', async () => {
    state.html = FIXTURE;
    const { directory } = await startCodeAnimationExport('11111111-2222-4333-8444-555555555555', {
      // Echo the staged directory back so the real renderer can be pointed at it.
      enqueueJob: async ({ params }) => ({ jobId: 'acceptance', directory: params.directory }),
    });
    expect(directory).toMatch(/^code-animation-exports\//);
    const result = await renderComposition({ directory, jobId: 'acceptance-render' });
    const video = join(PATHS.videos, result.filename);

    const pixels = decodeRaw(video);
    expect(pixels.length / FRAME_BYTES).toBe(FRAMES);
    const frames = Array.from({ length: FRAMES }, (_, i) => pixels.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES));
    expect(new Set(frames.map(frame => createHash('sha256').update(frame).digest('hex'))).size).toBe(FRAMES);

    const streams = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,color_primaries,color_transfer,color_space', '-of', 'json', video]));
    expect(streams.streams[0]).toMatchObject({ codec_name: 'h264', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709' });

    // Reference: the ORIGINAL page (no shim), renderFrame(t) called directly,
    // with the controls hidden the way the export hides them.
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
    try {
      const page = await context.newPage();
      await page.setContent(FIXTURE);
      await page.addStyleTag({ content: '#controls { display: none !important; }' });
      for (const frame of [0, 6, 11]) {
        await page.evaluate(t => window.renderFrame(t), frame / FPS);
        const shot = join(PATHS.data, `reference-${frame}.png`);
        await page.locator('#film').screenshot({ path: shot });
        // H.264 is lossy: allow small per-channel error, but a visible overlay
        // (a 400×200 green block, ~9% of the frame) or a wrong frame is far above it.
        expect(meanAbsDiff(frames[frame], decodeRaw(shot))).toBeLessThan(4);
      }
    } finally {
      await context.close();
    }
  }, 120000);
});
