/**
 * The film look finishing pass with real Chrome and ffmpeg: what the pass does
 * to the pixels of a finished render. The stubbed suite (filmLookFinish.test.js)
 * covers what the pass stages and asks for; only a real browser shows what the
 * look's filter paints over the page's base.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { browserSuiteCanRun, resolveTestChrome } from '../../lib/browserSuiteGate.js';

const chrome = resolveTestChrome();
// The pass launches its own headless browser: point that launch at the suite's Chrome.
vi.mock('../browserService.js', () => ({
  loadConfig: async () => ({ chromePath: chrome }),
  cdpRequest: async () => { throw new Error('the finishing pass owns its browser'); },
}));
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-film-look-browser-'),
}));

const { PATHS } = await import('../../lib/paths.js');
const { findFfmpeg } = await import('../../lib/ffmpeg.js');
const { applyFilmLookFinish } = await import('./filmLookFinish.js');
const ffmpeg = await findFfmpeg();
const canRun = browserSuiteCanRun('film look finishing pass', { Chrome: chrome, ffmpeg }, { onUnavailable: cleanupTempDataRoots });

const [W, H] = [320, 180];
/** The luma plane of the render's third frame. */
const lumaFrame = (path) => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-vf', 'select=eq(n\\,2)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 16 * 1024 * 1024 });
const at = (frame, x, y) => frame[y * W + x];

describe.skipIf(!canRun)('film look finishing pass with real Chrome and ffmpeg', () => {
  afterAll(cleanupTempDataRoots);

  it('darkens the corners of a finished render for a vignette and leaves its middle at the level it was encoded at', async () => {
    await mkdir(PATHS.data, { recursive: true });
    const path = join(PATHS.data, 'flat-gray.mp4');
    // A flat mid-gray render: every difference across the frame is the look's own.
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:r=12:d=0.5`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-y', path]);
    const before = at(lumaFrame(path), W / 2, H / 2);
    const finished = await applyFilmLookFinish({ look: { version: 2, vignette: 0.6 }, path, jobId: 'job-vignette', useGpu: false, workers: 1 })
      .catch((error) => (error?.code === 'COMPOSITION_BROWSER_CODEC' && !process.env.PORTOS_REQUIRE_BROWSER_SUITES ? error.code : Promise.reject(error)));
    if (finished === 'COMPOSITION_BROWSER_CODEC') {
      console.log('⏭️ film look finishing pass: this Chrome cannot decode H.264, so the pass cannot play a render');
      return;
    }
    expect(finished).toBe(true);
    const frame = lumaFrame(path);
    const middle = at(frame, W / 2, H / 2);
    // A look that changes no tone keeps the render's levels: the browser's BT.709 → sRGB conversion lifted middle gray by 12.
    expect(Math.abs(middle - before)).toBeLessThanOrEqual(3);
    // The fall-off is partly transparent: over the browser's white base it read lighter than the middle.
    for (const [x, y] of [[3, 3], [W - 4, 3], [3, H - 4], [W - 4, H - 4]]) expect(at(frame, x, y), `corner ${x},${y}`).toBeLessThan(middle - 25);
    expect(at(frame, 3, H / 2), 'left edge').toBeLessThan(middle - 10);
  }, 90000);
});
