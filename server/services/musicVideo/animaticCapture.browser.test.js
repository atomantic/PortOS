import { describe, expect, it, onTestFinished } from 'vitest';
import sharp from 'sharp';
import { browserSuiteCanRun } from '../../lib/browserSuiteGate.js';
import { filmLookPreset } from '../../lib/filmLook.js';
import { chartRgb, prerequisites, project, still, useAnimaticCaptureBrowserFixture } from './animaticCapture.browser.test.fixture.js';

const canRun = browserSuiteCanRun('animatic frame capture', prerequisites);

// The CI planner selects both suites for StoryboardAnimatic.jsx, musicVideoFrameCapture.js, FrameStepper.jsx and PreviewVideo.jsx.
describe.skipIf(!canRun)('saved storyboard pixels in a real browser', () => {
  const { state, errors, show, capture, enableFilmLook, colorReferences, colorYuvReferences } = useAnimaticCaptureBrowserFixture('color-seek', { readColorReferences: true });

  it('saves actual cover crops and camera endpoints for asymmetric push/pan stills', async () => {
    for (const move of ['hold', 'push', 'pan']) {
      await show(project([{ ...still, stillMove: move }]), 0);
      const first = await capture();
      await show(project([{ ...still, stillMove: move }]), 4 - 1 / 24);
      const last = await capture();
      expect(Buffer.compare(first, last) === 0).toBe(move === 'hold');
    }
    expect(errors).toEqual([]);
  });

  it('saves decoded footage with black, still, fill and VHS fitting while ignoring hidden preloads', async () => {
    const { page } = state;
    for (const frameFit of ['black', 'still', 'fill', 'vhs']) {
      await show(project([{ ...still, visualLayer: 'footage', videoHistoryId: 'clip', frameFit },
        { ...still, sceneId: 'next', order: 1, startSec: 4, endSec: 8, visualLayer: 'footage', videoHistoryId: 'preloaded' }]), 1);
      await page.waitForFunction(() => document.querySelector('video[data-ready="true"]:not([aria-hidden="true"])')?.seeking === false);
      await capture(frameFit);
    }
  });

  it('keeps BT601/709 saturated colors and grayscale identical across paused preview, decoded pixels and PNG', async () => {
    const { page } = state;
    const points = [...Array.from({ length: 8 }, (_, i) => [i * 60 + 30, 60]), ...Array.from({ length: 16 }, (_, i) => [i * 30 + 15, 160]), [240, 220]];
    const samples = (data, width, channels, locations) => locations.map(([x, y]) => [...data.subarray((y * width + x) * channels, (y * width + x) * channels + 3)]);
    for (const matrix of ['smpte170m', 'bt709']) {
      const value = project([{ ...still, referenceImageId: null, visualLayer: 'footage', videoHistoryId: matrix, frameFit: 'black' }]);
      for (const t of [0.02, 2.02, 1.02, 1.06, 1.02]) {
        await show(value, t);
        const saved = await capture(`${matrix} @ ${t}`);
        const pixels = await page.evaluate(async (points) => {
          const video = document.querySelector('video[data-ready="true"]');
          const canvas = video.nextElementSibling;
          const ctx = canvas.getContext('2d');
          const frame = new VideoFrame(video, { timestamp: 0 });
          try {
            const metadata = frame.colorSpace.toJSON();
            const format = frame.format;
            if (!['I420', 'NV12'].includes(format)) throw new Error(`Unexpected synthetic VP9 pixel format: ${format}`);
            const bytes = new Uint8Array(frame.allocationSize());
            const layout = await frame.copyTo(bytes);
            const yuv = points.map(([x, y]) => [bytes[layout[0].offset + y * layout[0].stride + x], ...[1, 2].map(i => {
              const plane = layout[format === 'NV12' ? 1 : i];
              return bytes[plane.offset + Math.floor(y / 2) * plane.stride + (format === 'NV12' ? 2 * Math.floor(x / 2) + i - 1 : Math.floor(x / 2))];
            })]);
            // Read a new draw of the source video, never the product canvas.
            const fresh = document.createElement('canvas'); fresh.width = video.videoWidth; fresh.height = video.videoHeight;
            const decoded = fresh.getContext('2d', { colorSpace: 'srgb' }); decoded.drawImage(video, 0, 0);
            const read = context => points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3));
            return { metadata, format, yuv, currentTime: video.currentTime, samples: read(ctx), fresh: read(decoded) };
          } finally { frame.close(); }
        }, points);
        expect(pixels.currentTime).toBeCloseTo(t, 5);
        expect(pixels.metadata).toEqual({ matrix, primaries: matrix, transfer: matrix, fullRange: false });
        const raw = await sharp(saved).raw().toBuffer({ resolveWithObject: true });
        const scale = raw.info.width / 480;
        const pngPoints = points.map(([x, y]) => [Math.floor(x * scale), Math.floor((raw.info.height - 240 * scale) / 2 + y * scale)]);
        const exported = samples(raw.data, raw.info.width, raw.info.channels, pngPoints);
        const frameIndex = Math.floor(t * 24);
        const offset = frameIndex * 480 * 240 * 3;
        const yuv = colorYuvReferences.get(matrix).subarray(frameIndex * 480 * 240 * 3 / 2);
        const sourceYuv = points.map(([x, y]) => [yuv[y * 480 + x], yuv[480 * 240 + Math.floor(y / 2) * 240 + Math.floor(x / 2)],
          yuv[480 * 240 * 5 / 4 + Math.floor(y / 2) * 240 + Math.floor(x / 2)]]);
        const [kr, kb] = matrix === 'bt709' ? [0.2126, 0.0722] : [0.299, 0.114];
        const expectedYuv = points.map(([x, y]) => {
          const [r, g, b] = chartRgb(x, y, frameIndex).map(channel => channel / 255);
          const luma = kr * r + (1 - kr - kb) * g + kb * b;
          return [16 + 219 * luma, 128 + 112 * (b - luma) / (1 - kb), 128 + 112 * (r - luma) / (1 - kr)].map(Math.round);
        });
        const reference = samples(colorReferences.get(matrix).subarray(offset), 480, 3, points);
        let displayed;
        if (t === 0.02) {
          // Retain native-display negative evidence; it is diagnostic, not the
          // reference used to relax the strict actual-preview capture assertion.
          const video = page.locator('video[data-ready="true"]');
          await video.evaluate(v => { v.style.visibility = ''; v.nextElementSibling.style.visibility = 'hidden'; });
          let native;
          try { native = await video.screenshot(); }
          finally { await video.evaluate(v => { v.style.visibility = 'hidden'; v.nextElementSibling.style.visibility = ''; }); }
          const nativePixels = await sharp(native).raw().toBuffer({ resolveWithObject: true });
          displayed = samples(nativePixels.data, nativePixels.info.width, nativePixels.info.channels, pngPoints);
          console.log(`🎨 ${process.platform}/${process.arch} ${state.browserVersion} ${matrix} limited YUV -> sRGB: ${JSON.stringify({ native: displayed, decoded: pixels.samples, png: exported, ffmpeg: reference })}`);
        }
        // CI intentionally silences console output. Preserve the complete
        // independent measurements in the assertion failure, before bailing.
        const evidence = JSON.stringify({ platform: process.platform, arch: process.arch, browser: state.browserVersion, ffmpegVersion: state.ffmpegVersion,
          matrix, t, metadata: pixels.metadata, format: pixels.format, native: displayed, decoded: pixels.samples, fresh: pixels.fresh,
          png: exported, ffmpeg: reference, sourceYuv, browserYuv: pixels.yuv, expectedYuv });
        expect(pixels.yuv, `Source frame ${matrix} @ ${t}: ${evidence}`).toEqual(sourceYuv);
        expect(pixels.samples, `Paused frame ${matrix} @ ${t}: ${evidence}`).toEqual(pixels.fresh);
        for (let i = 0; i < points.length; i++) for (let c = 0; c < 3; c++) {
          expect(Math.abs(exported[i][c] - pixels.samples[i][c]), `PNG ${matrix} ${i}/${c}: ${evidence}`).toBeLessThanOrEqual(1);
          // Quantization from the lossy VP9 chart is bounded independently of
          // any browser or FFmpeg RGB conversion and checked for every frame.
          expect(Math.abs(sourceYuv[i][c] - expectedYuv[i][c]), `Encoded YUV ${matrix} ${i}/${c}: ${evidence}`).toBeLessThanOrEqual(2);
        }
      }
    }
  }, 30000);

  it('uses native continuous playback, then freezes the selected source frame on pause and resume', async () => {
    const { page } = state;
    await show(project([{ ...still, referenceImageId: null, visualLayer: 'footage', videoHistoryId: 'bt709' }]), 0.02);
    await capture();
    await page.evaluate(async () => { await document.querySelector('audio').play(); });
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime > 0.3 && !v.dataset.pausedFrame && getComputedStyle(v).visibility === 'visible'; });
    await page.evaluate(() => document.querySelector('audio').pause());
    await capture();
    await page.evaluate(async () => { await document.querySelector('audio').play(); });
    await page.waitForFunction(() => !document.querySelector('video').paused && !document.querySelector('video').dataset.pausedFrame);
    await page.evaluate(() => document.querySelector('audio').pause());
    await capture();
  });

  it('keeps a video-only picture visible on every animation frame through pause and three frame steps', async () => {
    const { page } = state;
    await show(project([{ ...still, referenceImageId: null, visualLayer: 'footage', videoHistoryId: 'bt709', frameFit: 'black' }]), 0.02);
    await capture();
    await page.evaluate(async () => { await document.querySelector('audio').play(); });
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return !video.paused && video.currentTime > 0.3 && getComputedStyle(video).visibility === 'visible';
    });
    for (const action of ['pause', 'step', 'step', 'step']) {
      const samples = await page.evaluate(async action => {
        const video = document.querySelector('video');
        const canvas = video.nextElementSibling;
        const samples = [];
        let settledFrames = 0;
        if (action === 'pause') document.querySelector('audio').pause();
        else document.querySelector('button[aria-label="Forward 1 frame"]').click();
        // Observe the whole handover, including the two compositor frames before
        // the paused canvas is repainted. No still sits underneath this clip.
        for (let frame = 0; frame < 120 && settledFrames < 4; frame++) {
          await new Promise(requestAnimationFrame);
          const current = !video.seeking && video.dataset.pausedFrame === String(video.currentTime);
          samples.push({ video: getComputedStyle(video).visibility, canvas: getComputedStyle(canvas).visibility,
            opacity: getComputedStyle(video.parentElement).opacity, current, time: video.currentTime,
            captureError: current ? null : await window.capturePreviewFrame(document.querySelector('figure').firstElementChild)
              .then(() => 'Unexpected capture success', error => error.message) });
          settledFrames = current ? settledFrames + 1 : 0;
        }
        return samples;
      }, action);
      expect(samples.length, action).toBeGreaterThanOrEqual(4);
      expect(samples.at(-1).current, action).toBe(true);
      expect(samples.every(sample => Number(sample.opacity) > 0), action).toBe(true);
      expect(samples.filter(sample => sample.video === 'hidden' && sample.canvas === 'hidden'), action).toEqual([]);
      expect(samples.at(-1), action).toMatchObject({ video: 'hidden', canvas: 'visible' });
      const pending = samples.filter(sample => !sample.current);
      expect(pending.length, action).toBeGreaterThan(0);
      expect(pending.every(sample => sample.captureError === 'Video frame is still loading'), action).toBe(true);
    }
    await capture();
    await page.evaluate(async () => { await document.querySelector('audio').play(); });
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return !video.paused && !video.dataset.pausedFrame && getComputedStyle(video).visibility === 'visible'
        && getComputedStyle(video.nextElementSibling).visibility === 'hidden';
    });
    await page.evaluate(() => document.querySelector('audio').pause());
    await capture();
    // A released source has no replacement picture coming: do not retain its
    // paused canvas after the browser empties the media element.
    await page.locator('video').evaluate(video => { video.removeAttribute('src'); video.load(); });
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video.readyState === 0 && !video.dataset.pausedFrame
        && getComputedStyle(video.nextElementSibling).visibility === 'hidden';
    });
  });

  it('shares both footage surfaces through an incoming dissolve and the selected exact film look', async () => {
    const { page } = state;
    await show(project([
      { ...still, visualLayer: 'footage', videoHistoryId: 'smpte170m', cutEffect: { style: 'dissolve', enabled: true, overlapSec: 1 } },
      { ...still, sceneId: 'incoming', order: 1, startSec: 4, endSec: 8, visualLayer: 'footage', videoHistoryId: 'bt709' },
    ], { filmLook: filmLookPreset('vhs') }), 3.5);
    await enableFilmLook();
    await capture();
    expect(await page.locator('canvas[data-paused-video]:visible').count()).toBe(2);
    expect(await page.locator('[data-film-look="exact"]').count()).toBe(1);
  });

  it('waits for metadata-only active footage before freezing a dissolve, without waiting for hidden preloads', async () => {
    const { page } = state;
    onTestFinished(async () => {
      await page.reload();
      await page.waitForFunction(() => typeof window.show === 'function');
    });
    await page.reload();
    await page.waitForFunction(() => typeof window.show === 'function');
    await page.evaluate(() => {
      // The pending probe counts frames, but the settle deadline is 2 s of wall
      // clock; a slow runner under the VHS look spends that on 8 frames (#15755).
      // Stretch only that deadline here: the deadline test below still covers it.
      const realSetTimeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 2000 ? 60000 : delay, ...args);
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
      Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
        ...descriptor,
        get() {
          if (this.dataset.documentScene === 'still' && !window.releaseActiveDecode) return Math.min(1, descriptor.get.call(this));
          if (this.dataset.documentScene === 'preload') return 0;
          return descriptor.get.call(this);
        },
      });
      window.decodeActiveClip = () => {
        window.releaseActiveDecode = true;
        const video = document.querySelector('video[data-document-scene="still"]');
        video.dispatchEvent(new Event('loadeddata'));
        video.dispatchEvent(new Event('seeked'));
      };
    });
    await show(project([
      { ...still, visualLayer: 'footage', videoHistoryId: 'smpte170m', cutEffect: { style: 'dissolve', enabled: true, overlapSec: 1 } },
      { ...still, sceneId: 'incoming', order: 1, startSec: 4, endSec: 8, visualLayer: 'footage', videoHistoryId: 'bt709' },
      { ...still, sceneId: 'preload', order: 2, startSec: 8, endSec: 12, visualLayer: 'footage', videoHistoryId: 'preloaded' },
    ], { filmLook: filmLookPreset('vhs') }), 3.5);
    await enableFilmLook();
    await page.waitForFunction(() => {
      const active = document.querySelector('video[data-document-scene="still"]');
      const incoming = document.querySelector('video[data-testid="beat-toggle-clip"]');
      return active?.readyState === 1 && !active.seeking && active.currentTime === 3.5
        && getComputedStyle(active.parentElement).opacity === '0' && !active.dataset.pausedFrame
        && incoming?.dataset.pausedFrame === String(incoming?.currentTime);
    });
    await capture('delayed active decode', async () => {
      const pending = await page.evaluate(async () => {
        for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
        return { frozen: window.captureDecodePending, uploads: window.uploads.length, errors: window.captureErrors };
      });
      expect(pending).toEqual({ frozen: false, uploads: 0, errors: [] });
      await page.evaluate(() => window.decodeActiveClip());
    });
    const visible = state.captureEvidence.frozen.videos.filter(video => Number(video.opacity) > 0);
    expect(visible).toHaveLength(2);
    expect(visible.map(video => video.source)).toEqual(['smpte170m.webm', 'bt709.webm']);
    expect(visible.every(video => video.readyState >= 2 && video.pausedFrame === String(video.time))).toBe(true);
    expect(state.captureEvidence.frozen.videos.find(video => video.readyState === 0)).toMatchObject({ opacity: '0', pausedFrame: undefined });
    expect(await page.locator('[data-film-look="exact"]').count()).toBe(1);
  });

  it.each([
    ['first activation', false, 642, 'smpte170m', 'bt709'],
    ['already active', true, 642, 'smpte170m', 'bt709'],
    ['resize before activation', false, 602, 'smpte170m', 'bt709'],
    ['resize while active', true, 602, 'smpte170m', 'bt709'],
    ['reverse footage order', false, 642, 'bt709', 'smpte170m'],
  ])('compares natural dissolve capture revisions: %s', async (label, active, width, outgoing, incoming) => {
    const { page } = state;
    onTestFinished(async () => {
      await page.reload();
      await page.waitForFunction(() => typeof window.show === 'function');
    });
    // Enable the viewer preference before mounting so first activation still
    // exercises a project look being added, independently of earlier tests.
    await page.evaluate(() => localStorage.setItem('portos-mv-preview-film-look', 'on'));
    await page.reload();
    await page.waitForFunction(() => typeof window.show === 'function');
    const scenes = [
      { ...still, visualLayer: 'footage', videoHistoryId: outgoing, cutEffect: { style: 'dissolve', enabled: true, overlapSec: 1 } },
      { ...still, sceneId: 'incoming', order: 1, startSec: 4, endSec: 8, visualLayer: 'footage', videoHistoryId: incoming },
    ];
    await show(project(scenes, active ? { filmLook: filmLookPreset('vhs') } : {}), 3.5);
    await page.locator('main').evaluate((el, width) => { el.style.width = `${width}px`; }, width);
    await show(project(scenes, { filmLook: filmLookPreset('vhs') }), 3.5);
    await capture(label);
    expect(await page.locator('canvas[data-paused-video]:visible').count()).toBe(2);
    expect(await page.locator('[data-film-look="exact"]').count()).toBe(1);
  });

  it('saves a settled dissolve when animation frames arrive slower than the settle deadline (#16180)', async () => {
    const { page } = state;
    onTestFinished(async () => {
      await page.reload();
      await page.waitForFunction(() => typeof window.show === 'function');
    });
    await show(project([
      { ...still, visualLayer: 'footage', videoHistoryId: 'smpte170m', cutEffect: { style: 'dissolve', enabled: true, overlapSec: 1 } },
      { ...still, sceneId: 'incoming', order: 1, startSec: 4, endSec: 8, visualLayer: 'footage', videoHistoryId: 'bt709' },
    ], { filmLook: filmLookPreset('vhs') }), 3.5);
    await enableFilmLook();
    // A loaded runner rasterizing the VHS look can deliver frames over a
    // second apart. capture() waits for the settled preview before clicking,
    // so only a deadline expiring between the settle wait's frames fails it.
    await page.evaluate(() => {
      const frame = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => frame(() => setTimeout(() => callback(performance.now()), 1100));
    });
    await capture('slow frames');
    expect(await page.locator('canvas[data-paused-video]:visible').count()).toBe(2);
  });

  it('refuses a save at the settle deadline when a hidden tab suspends animation frames', async () => {
    const { page } = state;
    onTestFinished(async () => {
      await page.reload();
      await page.waitForFunction(() => typeof window.show === 'function');
    });
    await show(project(), 1);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      window.requestAnimationFrame = () => 0;
    });
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureErrors.length > 0, null, { timeout: 10000 });
    expect(await page.evaluate(() => window.uploads.length)).toBe(0);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Preview did not settle');
  });

  it('keeps a visible save waiting past the deadline for a frame, then refuses it once the tab hides', async () => {
    const { page } = state;
    onTestFinished(async () => {
      await page.reload();
      await page.waitForFunction(() => typeof window.show === 'function');
    });
    await show(project(), 1);
    await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    // Visible frames that have not arrived yet are slow, not a failed preview.
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => window.captureErrors)).toEqual([]);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => window.captureErrors.length > 0, null, { timeout: 2000 });
    expect(await page.evaluate(() => window.uploads.length)).toBe(0);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Preview did not settle');
  });
});
