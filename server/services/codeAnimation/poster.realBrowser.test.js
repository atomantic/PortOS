// Real-Chrome check of the gallery poster readout: the page's own animation
// loop must be stopped, the poster must be renderFrame(30% of duration), and
// a controls overlay stacked over the canvas must not appear in it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { cleanupTempDataRoots, lazyTempDataRoot } from '../../lib/mockPathsDataRoot.js';
import { _cleanupTestBrowser, _createTestArtifactsRoot, _waitForTestChrome } from '../htmlComposition/testBrowserCleanup.js';
import { resolveTestChrome } from '../../lib/browserSuiteGate.js';

vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
vi.mock('./jobStore.js', () => ({}));

const { posterCaptureScript } = await import('./poster.js');
const chrome = resolveTestChrome();

// The rAF loop paints red; renderFrame(t) paints blue proportional to t.
const film = ({ withRenderFrame }) => `<!doctype html><html><head><style>
body { margin: 0; background: #222; } canvas { display: block; width: 100vw; }
#controls { position: fixed; inset: 0 auto auto 0; width: 100vw; height: 100vh; background: rgb(0,255,0); }
</style></head><body><canvas id="film" width="1280" height="720"></canvas><div id="controls">controls</div><script>
window.ANIMATION_META = { duration: 10, fps: 24, width: 1280, height: 720 };
const ctx = document.getElementById('film').getContext('2d');
${withRenderFrame ? `window.renderFrame = (t) => { ctx.fillStyle = 'rgb(0,0,' + Math.round(t * 25.5) + ')'; ctx.fillRect(0, 0, 1280, 720); };` : ''}
const tick = () => { ctx.fillStyle = 'rgb(255,0,0)'; ctx.fillRect(0, 0, 1280, 720); requestAnimationFrame(tick); };
requestAnimationFrame(tick);
</script></body></html>`;

let proc;
let browser;
let artifacts;
const detachedChromeProcessGroupId = () => process.platform === 'win32' ? undefined : proc?.pid;

async function posterPixel(html) {
  const page = await browser.contexts()[0].newPage();
  try {
    await page.setContent(html);
    const data = await page.evaluate(posterCaptureScript(0));
    expect(typeof data).toBe('string');
    return await page.evaluate(async (b64) => {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${b64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const [r, g, b] = ctx.getImageData(image.width / 2, image.height / 2, 1, 1).data;
      return { width: image.width, height: image.height, r, g, b };
    }, data);
  } finally {
    await page.close();
  }
}

describe.skipIf(!chrome)('Code Animation gallery poster readout in real Chrome', () => {
  beforeAll(async () => {
    const profile = join(lazyTempDataRoot('portos-code-animation-poster-'), 'chrome-test-profile');
    proc = spawn(chrome, ['--headless=new', '--mute-audio', '--no-sandbox', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    try {
      const ws = await _waitForTestChrome(proc);
      artifacts = _createTestArtifactsRoot();
      browser = await chromium.connectOverCDP(new URL(ws).origin.replace('ws:', 'http:'), { artifactsDir: artifacts.path });
    } catch (error) {
      await _cleanupTestBrowser({ browser, proc, artifacts, cleanup: cleanupTempDataRoots, startupError: error, detachedProcessGroupId: detachedChromeProcessGroupId() });
    }
  }, 45000);

  afterAll(() => _cleanupTestBrowser({ browser, proc, artifacts, cleanup: cleanupTempDataRoots, detachedProcessGroupId: detachedChromeProcessGroupId() }), 25000);

  it('draws renderFrame at 30% of the film, scaled to 640px, without the loop or the overlay', async () => {
    const pixel = await posterPixel(film({ withRenderFrame: true }));
    expect({ width: pixel.width, height: pixel.height }).toEqual({ width: 640, height: 360 });
    expect(pixel.r).toBeLessThan(20);
    expect(pixel.g).toBeLessThan(20);
    expect(Math.abs(pixel.b - 77)).toBeLessThan(12);
  }, 20000);

  it('still reads the live canvas from a page that skipped the renderFrame contract', async () => {
    const pixel = await posterPixel(film({ withRenderFrame: false }));
    expect(pixel.r).toBeGreaterThan(200);
    expect(pixel.g).toBeLessThan(30);
  }, 20000);
});
