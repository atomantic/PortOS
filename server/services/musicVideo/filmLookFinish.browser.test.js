/**
 * The film look finishing pass with real Chrome and ffmpeg: what the pass does
 * to the pixels of a finished render. The stubbed suite (filmLookFinish.test.js)
 * covers what the pass stages and asks for; only a real browser shows what the
 * look's filter paints over the page's base.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
const { findFfmpeg, probeVideoGeometry } = await import('../../lib/ffmpeg.js');
const { applyFilmLookFinish, _filmLookFinishTestHooks } = await import('./filmLookFinish.js');
const { encodeFilmLookWeb } = await import('./filmLookWebEncoder.js');
const { openComposition } = await import('../htmlComposition/browser.js');
const { filmLookRuntimeSource, normalizeFilmLook } = await import('../../lib/filmLook.js');
const { titleCardRuntime } = await import('./titleCardFonts.js');
const ffmpeg = await findFfmpeg();
const canRun = browserSuiteCanRun('film look finishing pass', { Chrome: chrome, ffmpeg }, { onUnavailable: cleanupTempDataRoots });

const [W, H] = [320, 180];
/** The luma plane of the render's third frame. */
const lumaFrame = (path) => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-vf', 'select=eq(n\\,2)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 16 * 1024 * 1024 });
const at = (frame, x, y) => frame[y * W + x];

// The title card cases: a frame wide enough for the look's gate weave to move the film by whole pixels.
const [CW, CH] = [640, 360];
// A red field with a white bar down its middle. The bar shows where the weave puts the film on a
// frame; the red shows a change of colour matrix, which a grey would hide.
const barField = (path, seconds) => execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0xc82828:s=${CW}x${CH}:r=24:d=${seconds}`,
  '-vf', `drawbox=x=${CW / 2}:y=0:w=12:h=${CH}:color=white:t=fill`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-y', path]);
/** Frame `n` of the video as its own Y, U and V planes, undecoded to RGB. */
const yuvFrame = (path, n) => {
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 16 * 1024 * 1024 });
  return { y: raw.subarray(0, CW * CH), u: raw.subarray(CW * CH, CW * CH * 5 / 4), v: raw.subarray(CW * CH * 5 / 4) };
};
/** The column the film's bar starts at, on the frame's middle row. */
const barLeft = ({ y }) => { for (let x = 0; x < CW; x++) if (y[(CH / 2) * CW + x] > 170) return x; return -1; };
/** The box around the card's cream type in its lower-left corner, and how many pixels of it there are. */
const cardBox = ({ y }) => {
  const box = { left: CW, top: CH, right: -1, bottom: -1, count: 0 };
  for (let row = CH / 2; row < CH; row++) {
    for (let x = 0; x < CW / 2 - 24; x++) {
      if (y[row * CW + x] <= 170) continue;
      box.left = Math.min(box.left, x); box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, row); box.bottom = Math.max(box.bottom, row);
      box.count += 1;
    }
  }
  return box;
};
// The encoder's noise can move one edge pixel across the threshold; the weave would move the whole box three.
const expectSameBox = (box, other) => {
  for (const edge of ['left', 'top', 'right', 'bottom']) expect(Math.abs(box[edge] - other[edge]), edge).toBeLessThanOrEqual(1);
  expect(Math.abs(box.count - other.count)).toBeLessThanOrEqual(other.count * 0.02);
};
/** The mean Y, U and V of a patch of the red field, clear of the bar and the card. */
const fieldLevels = ({ y, u, v }) => {
  const mean = (plane, width, [x0, y0, x1, y1]) => {
    let sum = 0;
    for (let row = y0; row < y1; row++) for (let x = x0; x < x1; x++) sum += plane[row * width + x];
    return sum / ((x1 - x0) * (y1 - y0));
  };
  return [mean(y, CW, [40, 40, 240, 140]), mean(u, CW / 2, [20, 20, 120, 70]), mean(v, CW / 2, [20, 20, 120, 70])];
};
const TITLE_CARD = { title: 'Example Song', artist: 'Example Artist', style: 'outline', size: 150, fadeSec: 0, steady: true };

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
  it('keeps frame cadence, copied audio and final progress through an automatically selected finish', async () => {
    await mkdir(PATHS.data, { recursive: true });
    const path = join(PATHS.data, 'motion-audio.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=24:d=10`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-y', path]);
    const audioHash = () => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).toString();
    const before = audioHash();
    let progress = 0;
    const finished = await applyFilmLookFinish({ look: { grain: 0.4 }, path, jobId: 'job-auto-web', workers: 1, onProgress: value => { progress = value; } })
      .catch((error) => (error?.code === 'COMPOSITION_BROWSER_CODEC' && !process.env.PORTOS_REQUIRE_BROWSER_SUITES ? error.code : Promise.reject(error)));
    if (finished === 'COMPOSITION_BROWSER_CODEC') return;
    expect(finished).toBe(true);
    expect(progress).toBe(1);
    expect(audioHash()).toBe(before);
    const geometry = await probeVideoGeometry(path);
    expect(geometry).toMatchObject({ width: W, height: H, fps: 24, numFrames: 240 });
    expect(geometry.durationSec).toBeCloseTo(10, 2);
  }, 180000);

  // Uniquely catches a steady card the pass never draws (the join left it out), one drawn under the
  // look's SVG filter (it would weave with the film), or one a page screenshot does not hold.
  it('draws a title card it is handed over the look: in every frame, and still while the film weaves under it', async () => {
    await mkdir(PATHS.data, { recursive: true });
    const path = join(PATHS.data, 'card-svg.mp4');
    barField(path, 0.5);
    const finished = await applyFilmLookFinish({ look: { version: 2, weave: 1 }, path, jobId: 'job-card-svg', useGpu: false, workers: 1,
      titleCard: { ...TITLE_CARD, startSec: 0, endSec: 5 } })
      .catch((error) => (error?.code === 'COMPOSITION_BROWSER_CODEC' && !process.env.PORTOS_REQUIRE_BROWSER_SUITES ? error.code : Promise.reject(error)));
    if (finished === 'COMPOSITION_BROWSER_CODEC') {
      console.log('⏭️ film look finishing pass: this Chrome cannot decode H.264, so the pass cannot play a render');
      return;
    }
    expect(finished).toBe(true);
    // Song frames 2 and 10: the weave puts the film about three and a half pixels apart on them at this width.
    const [early, late] = [yuvFrame(path, 2), yuvFrame(path, 10)];
    // The look moves the film between these frames...
    expect(Math.abs(barLeft(early) - barLeft(late))).toBeGreaterThanOrEqual(3);
    // ...and the card is on both, in the same place.
    expect(cardBox(early).count).toBeGreaterThan(300);
    expectSameBox(cardBox(late), cardBox(early));
  }, 120000);

  // Uniquely catches a WebCodecs frame without the card (the encoder reads the GPU canvas, which a
  // layer over it is not part of), a card that weaves with the film there, one left on frames outside
  // its window, and a flattened frame encoded at other levels than the frames beside it.
  it('flattens the title card onto the WebCodecs frames it shows in, at the levels of the frames around them', async ({ skip }) => {
    const directory = 'web-encoder-card';
    const dir = join(PATHS.data, directory);
    await mkdir(join(dir, 'media'), { recursive: true });
    barField(join(dir, 'media', 'source.mp4'), 1);
    const look = normalizeFilmLook({ version: 2, weave: 1 });
    const files = _filmLookFinishTestHooks.filmLookFinishPage({ width: CW, height: CH, fps: 24, durationSec: 1, look });
    await Promise.all(Object.entries(files).map(([name, body]) => writeFile(join(dir, name), body)));
    // In its window for song frames 6 to 17 only.
    const page = await openComposition(directory, { streamMedia: true, ownedBrowser: true,
      initScripts: [filmLookRuntimeSource(look), titleCardRuntime({ ...TITLE_CARD, startSec: 0.25, endSec: 0.75 })] });
    try {
      const capabilities = await page.evaluate(`(async () => {
        const gpu = globalThis.__portosFilmLookFinish.gpuInfo().available;
        if (!gpu || typeof VideoEncoder !== 'function' || !document.createElement('video').canPlayType('video/mp4; codecs=\"avc1.640028\"')) return false;
        const result = await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: ${CW}, height: ${CH}, framerate: 24,
          bitrateMode: 'quantizer', hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' }, latencyMode: 'realtime' });
        return result.supported && result.config.bitrateMode === 'quantizer';
      })()`);
      if (!capabilities) { console.log('⏭️ WebCodecs title card: browser lacks GPU, H.264 or quantizer support'); skip(); }
      expect((await page.evaluate('globalThis.__portosFilmLookFinish.useGpu(true)')).on).toBe(true);
      const output = join(dir, 'encoded.mp4');
      const screenshots = new Map();
      const result = await encodeFilmLookWeb(page, { width: CW, height: CH, fps: 24, durationSec: 1 }, output, {
        // What the PNG path would have captured of the same frames, the look drawn by the GPU.
        captureReference: async (target, n) => {
          if (n !== 2 && n !== 7) return;
          const { data } = await target.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
          const sharp = (await import('sharp')).default;
          screenshots.set(n, { y: await sharp(Buffer.from(data, 'base64')).resize(CW, CH, { fit: 'fill' }).greyscale().raw().toBuffer() });
        },
      });
      expect(result.timing).toMatchObject({ frames: 24, gpuFrames: 24 });
      expect(cardBox(screenshots.get(2)).count).toBe(0);
      expect(cardBox(screenshots.get(7)).count).toBeGreaterThan(300);
      // Frames 7 and 10 sit as far apart in the weave as 2 and 10 do; 2 and 20 are outside the card's window.
      const [before, early, late, after] = [2, 7, 10, 20].map((n) => yuvFrame(output, n));
      expect(cardBox(before).count).toBe(0);
      expect(cardBox(after).count).toBe(0);
      expect(cardBox(early).count).toBeGreaterThan(300);
      expectSameBox(cardBox(late), cardBox(early));
      expect(Math.abs(barLeft(early) - barLeft(late))).toBeGreaterThanOrEqual(3);
      // A flattened frame and a frame read straight from the GPU canvas carry the same picture.
      const [direct, flattened] = [fieldLevels(before), fieldLevels(early)];
      flattened.forEach((level, plane) => expect(Math.abs(level - direct[plane]), `plane ${plane}`).toBeLessThanOrEqual(2));
    } finally { await page.close(); }
  }, 120000);

  it('encodes the admitted GPU canvas with WebCodecs when the browser supports it', async ({ skip }) => {
    const directory = 'web-encoder-browser';
    const dir = join(PATHS.data, directory);
    await mkdir(join(dir, 'media'), { recursive: true });
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=24:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(dir, 'media', 'source.mp4')]);
    const look = normalizeFilmLook({ grain: 0.4 });
    const files = _filmLookFinishTestHooks.filmLookFinishPage({ width: W, height: H, fps: 24, durationSec: 1, look });
    await Promise.all(Object.entries(files).map(([name, body]) => writeFile(join(dir, name), body)));
    const page = await openComposition(directory, { streamMedia: true, ownedBrowser: true, initScripts: [filmLookRuntimeSource(look)] });
    try {
      const capabilities = await page.evaluate(`(async () => {
        const gpu = globalThis.__portosFilmLookFinish.gpuInfo().available;
        if (!gpu || typeof VideoEncoder !== 'function' || !document.createElement('video').canPlayType('video/mp4; codecs=\"avc1.640028\"')) return false;
        const result = await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: ${W}, height: ${H}, framerate: 24,
          bitrateMode: 'quantizer', hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' }, latencyMode: 'realtime' });
        return result.supported && result.config.bitrateMode === 'quantizer';
      })()`);
      if (!capabilities) { console.log('⏭️ WebCodecs adapter: browser lacks GPU, H.264 or quantizer support'); skip(); }
      const switched = await page.evaluate('globalThis.__portosFilmLookFinish.useGpu(true)');
      expect(switched.on).toBe(true);
      const output = join(dir, 'encoded.mp4');
      const result = await encodeFilmLookWeb(page, { width: W, height: H, fps: 24, durationSec: 1 }, output);
      expect(result.timing).toMatchObject({ frames: 24, gpuFrames: 24, svgFrames: 0 });
      expect(await probeVideoGeometry(output)).toMatchObject({ width: W, height: H, fps: 24, numFrames: 24 });
    } finally { await page.close(); }
  }, 120000);

});
