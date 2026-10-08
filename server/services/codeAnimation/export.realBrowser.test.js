// Real-browser acceptance for the frame-exact Code Animation export (#9083):
// the staged document runs in real Chrome, renderComposition encodes it with
// real ffmpeg, and the MP4 is compared to direct renderFrame(t) screenshots.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
const { openComposition } = await import('../htmlComposition/browser.js');
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

// A three-renderer film (#10464): imports three and addons by bare name and
// never writes an import map, so the host's map and the vendored modules are the
// only way it can run. The post stack is the bloom + OutputPass finish the prompt teaches.
const THREE_FIXTURE = `<!doctype html><html><head><style>body { margin: 0; background: #000; }</style></head><body>
<canvas id="film" width="${WIDTH}" height="${HEIGHT}"></canvas>
<script type="module">
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
window.ANIMATION_META = { title: 'Three', duration: 1, fps: ${FPS}, width: ${WIDTH}, height: ${HEIGHT} };
const film = document.getElementById('film');
const renderer = new THREE.WebGLRenderer({ canvas: film, antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(${WIDTH}, ${HEIGHT}, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101820);
const camera = new THREE.PerspectiveCamera(45, ${WIDTH} / ${HEIGHT}, 0.1, 50);
camera.position.set(0, 1, 6);
scene.add(new THREE.HemisphereLight(0xaaccff, 0x222233, 1.2));
const box = new THREE.Mesh(new RoundedBoxGeometry(1.6, 1.6, 1.6, 4, 0.2), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(3, 1.6, 0.8), emissiveIntensity: 0.6 }));
scene.add(box);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(${WIDTH}, ${HEIGHT}), 0.6, 0.4, 1.2));
composer.addPass(new OutputPass());
window.renderFrame = (t) => {
  box.rotation.set(t * 3, t * 5, 0);
  box.position.x = Math.sin(t * 4) * 1.5;
  composer.render();
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
    proc = spawn(chrome, ['--headless=new', '--mute-audio', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      const ws = await _waitForTestChrome(proc);
      endpoint = new URL(ws).origin.replace('ws:', 'http:');
      browser = await chromium.connectOverCDP(endpoint);
    } catch (error) {
      // Retain the owned handle for afterAll if termination itself fails.
      await _cleanupTestBrowser({ browser, proc, cleanup: cleanupTempDataRoots, startupError: error });
    }
    // Enclose the existing startup (20s), disconnect (5s) and owned-child
    // termination (10s) budgets without cutting off evidence.
  }, 40000);

  afterAll(() => _cleanupTestBrowser({ browser, proc, cleanup: cleanupTempDataRoots }), 20000);

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

  it('runs a three.js film from the vendored modules alone: repeated renderFrame(t) is pixel-identical, the render is network-free, and the files are hashed', async () => {
    state.html = THREE_FIXTURE;
    const { directory } = await startCodeAnimationExport('11111111-2222-4333-8444-555555555556', {
      enqueueJob: async ({ params }) => ({ jobId: 'three', directory: params.directory }),
    });
    const manifest = JSON.parse(readFileSync(join(PATHS.data, directory, 'dependencies.json'), 'utf8'));
    expect(manifest).toMatchObject({ network: false, packages: [{ name: 'three' }] });
    for (const { path, sha256 } of manifest.packages[0].files) {
      expect(createHash('sha256').update(readFileSync(join(PATHS.data, directory, path))).digest('hex')).toBe(sha256);
    }

    const page = await openComposition(directory);
    const shots = [];
    try {
      const contract = await page.evaluate('(() => { const c = globalThis.portosComposition; return { width: c.width, height: c.height }; })()');
      await page.send('Emulation.setDeviceMetricsOverride', { width: contract.width, height: contract.height, deviceScaleFactor: 1, mobile: false });
      // 0.25, 0.75, then 0.25 again on the same page and the same persistent scene.
      for (const t of [0.25, 0.75, 0.25]) {
        await page.evaluate(`globalThis.portosComposition.seek(${t})`);
        const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
        shots.push(createHash('sha256').update(Buffer.from(shot.data, 'base64')).digest('hex'));
      }
      // close({ verify }) rejects when the page tried a refused (non-vendored) request.
      await page.close({ verify: true });
    } catch (error) {
      await page.close();
      throw error;
    }
    expect(shots[0]).toBe(shots[2]);
    expect(shots[0]).not.toBe(shots[1]);
  }, 120000);
});
