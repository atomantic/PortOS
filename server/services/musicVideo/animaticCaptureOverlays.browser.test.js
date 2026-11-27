import { describe, expect, it, onTestFinished } from 'vitest';
import sharp from 'sharp';
import { browserSuiteCanRun } from '../../lib/browserSuiteGate.js';
import { filmLookPreset } from '../../lib/filmLook.js';
import { prerequisites, project, still, useAnimaticCaptureBrowserFixture } from './animaticCapture.browser.test.fixture.js';

const canRun = browserSuiteCanRun('animatic overlay frame capture', prerequisites);

// The CI planner selects both suites for StoryboardAnimatic.jsx, musicVideoFrameCapture.js, FrameStepper.jsx and PreviewVideo.jsx.
describe.skipIf(!canRun)('saved storyboard pixels in a real browser', () => {
  const { state, errors, show, capture, enableFilmLook, phase } = useAnimaticCaptureBrowserFixture('overlays');

  it('isolates a deferred filter commit from box, song and both paused footage revisions', async () => {
    const { page } = state;
    onTestFinished(async () => {
      await page.reload();
      await page.waitForFunction(() => typeof window.show === 'function');
    });
    await page.reload();
    await page.waitForFunction(() => typeof window.show === 'function');
    await page.evaluate(() => {
      const Observer = window.ResizeObserver;
      window.ResizeObserver = function(callback) {
        return new Observer((entries, observer) => {
          const apply = () => callback(entries, observer);
          if (window.deferFilterResize && entries.some(entry => entry.target.dataset.filmLook === 'exact')) window.applyFilterResize = apply;
          else apply();
        });
      };
    });
    await show(project([
      { ...still, visualLayer: 'footage', videoHistoryId: 'smpte170m', cutEffect: { style: 'dissolve', enabled: true, overlapSec: 1 } },
      { ...still, sceneId: 'incoming', order: 1, startSec: 4, endSec: 8, visualLayer: 'footage', videoHistoryId: 'bt709' },
    ], { filmLook: filmLookPreset('vhs') }), 3.5);
    await enableFilmLook();
    await page.waitForFunction(() => document.querySelector('[data-film-look-width="640"]'));
    await page.evaluate(() => { window.deferFilterResize = true; document.querySelector('main').style.width = '602px'; });
    await page.waitForFunction(() => typeof window.applyFilterResize === 'function');
    const provisional = await capture('deferred filter at stable resized box');
    const before = await page.evaluate(() => window.previewMetadata());
    await page.evaluate(() => { window.uploads = []; window.gateCaptureOnce(); });
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureDecodePending);
    await page.evaluate(() => { window.deferFilterResize = false; window.applyFilterResize(); });
    await page.waitForFunction(() => document.querySelector('[data-film-look-width="600"]'));
    const after = await page.evaluate(() => window.previewMetadata());
    expect(after.box).toEqual(before.box);
    expect(after.songFrame).toBe(before.songFrame);
    expect(after.videos).toEqual(before.videos);
    expect(after.filter).not.toEqual(before.filter);
    await page.evaluate(() => window.releaseCapture());
    await page.waitForFunction(() => window.uploads.length > 0 || window.captureErrors.length > 0);
    const uploaded = await page.evaluate(() => window.uploads.at(-1));
    if (uploaded) {
      // A regressed guard must retain the rejected control's actual pixels,
      // rather than the earlier, successful provisional-filter capture.
      state.captureEvidence = { label: 'deferred filter negative control', platform: process.platform,
        arch: process.arch, browser: state.browserVersion, ffmpegVersion: state.ffmpegVersion,
        beforeFilterCommit: before, afterFilterCommit: after,
        frozen: await page.evaluate(() => window.captureFrozen),
        serialized: await page.evaluate(() => window.captureSerialized),
        saved: Buffer.from(uploaded), beforeScreenshot: await page.evaluate(() => window.previewMetadata()),
        displayed: await page.getByLabel('Storyboard animatic', { exact: true }).locator(':scope > div').first().screenshot(),
        afterScreenshot: await page.evaluate(() => window.previewMetadata()),
      };
    }
    expect(Boolean(uploaded)).toBe(false);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Preview changed during capture');
    expect(Buffer.compare(provisional, await capture('committed filter at same resized box'))).not.toBe(0);
  });

  it('saves end-frame effects, flash/develop, incoming dissolves and fade-black in their displayed order', async () => {
    for (const [effect, t] of [['end-fade', 1.3], ['end-fade', 3], ['flash-develop', 0.1], ['flash-develop', 1]]) {
      await show(project([{ ...still, imageEffect: effect, imageEffectSec: 1, endImageId: 'end.png', stillMove: 'pan' }]), t);
      await capture();
    }
    await show(project([{ ...still, cutEffect: { style: 'dissolve', enabled: true, overlapSec: 1 } },
      { ...still, sceneId: 'next', order: 1, startSec: 4, endSec: 8, referenceImageId: 'end.png', stillMove: 'push' }]), 3.5);
    await capture();
    await show(project([{ ...still, cutEffect: { style: 'fade-black', enabled: true, overlapSec: 1 } }]), 3.8);
    await capture();
  });

  it('captures the exact paused film-look filter after freezing a newer audio clock across a shot boundary', async () => {
    const { page } = state;
    const look = filmLookPreset('vhs');
    await show(project([still, { ...still, sceneId: 'next', startSec: 4, endSec: 8, order: 1, referenceImageId: 'end.png' }], { filmLook: look }), 3);
    await enableFilmLook();
    await page.evaluate(() => {
      const audio = document.querySelector('audio');
      audio.currentTime = 4.5;
      audio.dispatchEvent(new Event('play'));
    });
    const styled = await capture();
    expect(await page.locator('[data-film-look="exact"]').count()).toBe(1);
    expect(await page.locator('figure img').first().getAttribute('src')).toBe('/data/images/end.png');
    await page.getByRole('button', { name: 'Film look', exact: true }).click();
    await page.evaluate(() => { window.uploads = []; });
    const clean = await capture();
    expect(Buffer.compare(styled, clean)).not.toBe(0);
  });

  it('captures the opaque lyric and title canvases only after the requested song seek completes', async () => {
    const { page } = state;
    const extra = { audioAnalysis: { durationSec: 8 }, lyricCues: [{ id: 'line', text: 'EXAMPLE WORDS', startSec: 1, endSec: 4 }],
      titleCard: { enabled: true, title: 'Example title', artist: 'Example artist', startSec: 0, endSec: 5 } };
    state.lyricProject = project([{ ...still, referenceImageId: null }], extra);
    await show(project([still], extra), 2);
    const frame = page.frameLocator('iframe');
    await frame.locator('#stage').waitFor();
    const withWords = await capture();
    await page.getByRole('button', { name: 'Lyrics', exact: true }).click();
    await page.evaluate(() => { window.uploads = []; });
    const withoutWords = await capture();
    expect(Buffer.compare(withWords, withoutWords)).not.toBe(0);
  });

  // Uniquely catches a steady title card lost from a saved frame (its layer sits outside the tree the
  // capture freezes), or saved under the film look the preview shows it over.
  it('saves a steady title card over the film look, and a card that is not steady through it', async () => {
    const { page } = state;
    const card = { enabled: true, title: 'Example title', artist: 'Example artist', style: 'mtv', accentColor: '#00ff00', startSec: 0, endSec: 5 };
    // Pixels of the lower third's bar that kept its exact colour: none does once the look has filtered it.
    const barPixels = async (png) => {
      const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] === 0 && data[i + 1] === 255 && data[i + 2] === 0) count += 1;
      return count;
    };
    const shown = async (titleCard) => {
      const extra = { composition: { mode: 'composed' }, audioAnalysis: { durationSec: 8 }, filmLook: filmLookPreset('vhs'), titleCard };
      state.lyricProject = project([{ ...still, referenceImageId: null }], extra);
      await show(project([still], extra), 2);
      await enableFilmLook();
      await page.frameLocator('iframe').locator('canvas[data-portos-title-card]').waitFor();
    };
    await shown(card);
    expect(await page.locator('figure [data-film-look] iframe').count()).toBe(0);
    const steady = await barPixels(await capture('steady title card'));
    expect(steady).toBeGreaterThan(20);
    await shown({ ...card, steady: false });
    expect(await page.locator('figure [data-film-look] iframe').count()).toBe(1);
    expect(await barPixels(await capture())).toBeLessThan(steady / 10);
    await page.getByRole('button', { name: 'Film look', exact: true }).click();
  });

  it('rejects a loading video-only shot without uploading a blank or a preloaded frame', async () => {
    const { page } = state;
    await page.route('**/data/videos/clip.webm', (route) => route.abort());
    await show(project([{ ...still, referenceImageId: null, visualLayer: 'footage', videoHistoryId: 'loading' }]), 1);
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureErrors.length > 0);
    expect(await page.evaluate(() => window.uploads.length)).toBe(0);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Video frame is still loading');
    await page.unroute('**/data/videos/clip.webm');
  });

  it('freezes the displayed outro canvas and exact look before capture', async () => {
    const { page } = state;
    await show(project([still], { statsOutro: { enabled: true, durationSec: 8 }, filmLook: filmLookPreset('polaroid') }), 1);
    const look = page.getByRole('button', { name: 'Film look', exact: true });
    await phase('outro-enable-look', async () => {
      if (await look.getAttribute('aria-pressed') === 'false') await look.click();
    });
    // The canvas mounts with provisional counts, so its presence/fonts do not
    // establish a capture basis. Wait for the tally, then let React paint it.
    const statsReady = page.waitForResponse('**/api/music-video/*/stats-outro');
    await phase('outro-activate', () => page.getByRole('button', { name: 'Ending', exact: true }).click());
    await phase('outro-canvas-ready', () => page.getByTestId('animatic-stats-outro').waitFor());
    const statsResponse = await phase('outro-stats-response', () => statsReady);
    expect(statsResponse.ok()).toBe(true);
    expect(await phase('outro-stats-finished', () => statsResponse.finished())).toBeNull();
    await phase('outro-fonts-ready', () => page.evaluate(() => document.fonts.ready));
    await phase('outro-paint-settled', () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))));
    const saved = await capture();
    expect(await phase('outro-exact-look', () => page.locator('[data-film-look="exact"]').count())).toBe(1);
    await phase('outro-repeat-paint', () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))));
    await phase('outro-repeat-reset', () => page.evaluate(() => { window.uploads = []; }));
    expect(Buffer.compare(saved, await capture())).toBe(0);
  });

  it('rejects a project change or late outro statistics while async frame rasterization is pending', async () => {
    const { page } = state;
    await show(project(), 1);
    await page.evaluate(() => window.gateCaptureOnce());
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureDecodePending);
    await show(project([{ ...still, referenceImageId: 'end.png' }]), 1);
    await page.evaluate(() => window.releaseCapture());
    await page.waitForFunction(() => window.captureErrors.length > 0);
    expect(await page.evaluate(() => window.uploads.length)).toBe(0);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Preview changed during capture');

    let pendingStats;
    await page.route('**/api/music-video/*/stats-outro', (route) => { pendingStats = route; });
    await show(project([still], { statsOutro: { enabled: true, durationSec: 8 } }), 1);
    await page.getByRole('button', { name: 'Ending', exact: true }).click();
    await page.getByTestId('animatic-stats-outro').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.gateCaptureOnce());
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureDecodePending);
    expect(pendingStats).toBeTruthy();
    // The old success fixture's entire readiness condition is now true, yet
    // the statistics request is still held and capture has not uploaded.
    const controlState = () => page.evaluate(() => ({
      seeking: document.querySelector('audio').seeking,
      time: document.querySelector('audio').currentTime,
      ending: document.querySelector('[data-testid="animatic-stats-outro"]') !== null,
      errors: window.captureErrors, uploads: window.uploads.length,
    }));
    expect(await controlState()).toEqual({ seeking: false, time: 1, ending: true, errors: [], uploads: 0 });
    await pendingStats.fulfill({ json: { stats: { shots: 9, floorImages: [] } } });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect(await controlState()).toEqual({ seeking: false, time: 1, ending: true, errors: [], uploads: 0 });
    await page.evaluate(() => window.releaseCapture());
    await page.waitForFunction(() => window.captureErrors.length > 0);
    expect(await page.evaluate(() => window.uploads.length)).toBe(0);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Preview changed during capture');
    await page.unroute('**/api/music-video/*/stats-outro');
    // With that same Ending paused and its response applied, capture succeeds
    // and keeps the exact displayed pixels on a second independent save.
    const saved = await capture();
    expect(Buffer.compare(saved, await capture())).toBe(0);
  });
  it('rejects a late exact-filter resize while keeping the selected song and footage frames frozen', async () => {
    const { page } = state;
    await show(project([
      { ...still, visualLayer: 'footage', videoHistoryId: 'smpte170m', cutEffect: { style: 'dissolve', enabled: true, overlapSec: 1 } },
      { ...still, sceneId: 'incoming', order: 1, startSec: 4, endSec: 8, visualLayer: 'footage', videoHistoryId: 'bt709' },
    ], { filmLook: filmLookPreset('vhs') }), 3.5);
    const look = page.getByRole('button', { name: 'Film look', exact: true });
    if (await look.getAttribute('aria-pressed') === 'false') await look.click();
    await page.evaluate(() => { window.uploads = []; window.gateCaptureOnce(); });
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureDecodePending);
    await page.locator('video[data-preview-video][aria-hidden="true"]').first().evaluate(video => { video.dataset.ready = 'false'; });
    await page.evaluate(() => window.releaseCapture());
    await page.waitForFunction(() => window.uploads.length > 0 || window.captureErrors.length > 0);
    expect(await page.evaluate(() => window.captureErrors)).toEqual([]);
    expect(await page.evaluate(() => window.uploads.length)).toBe(1);
    await page.evaluate(() => { window.uploads = []; window.gateCaptureOnce(); });
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureDecodePending);
    const frozen = await page.evaluate(() => window.captureFrozen);
    // No audio seek or project edit: only the box and the size-dependent SVG
    // change after the actual preview has already been serialized.
    await page.locator('main').evaluate(el => { el.style.width = '602px'; });
    await page.waitForFunction(() => document.querySelector('[data-film-look-width="600"]'));
    const resized = await page.evaluate(() => window.previewMetadata());
    expect(resized.songFrame).toBe(frozen.songFrame);
    expect(resized.videos).toEqual(frozen.videos);
    expect(resized.filter).not.toEqual(frozen.filter);
    await page.evaluate(() => window.releaseCapture());
    await page.waitForFunction(() => window.captureErrors.length > 0 || window.uploads.length > 0);
    expect(await page.evaluate(() => window.uploads.length)).toBe(0);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Preview changed during capture');
    try { await capture(); }
    finally { await page.locator('main').evaluate(el => { el.style.width = '642px'; }); }
  });

  it('reports an unavailable paused color surface without uploading a different native-video image', async () => {
    const { page } = state;
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      window.restoreContext = () => { HTMLCanvasElement.prototype.getContext = original; };
      HTMLCanvasElement.prototype.getContext = function(...args) { return this.dataset.pausedVideo ? null : original.apply(this, args); };
    });
    try {
      await show(project([{ ...still, visualLayer: 'footage', videoHistoryId: 'smpte170m' }]), 1.02);
      await page.waitForFunction(() => document.querySelector('video')?.dataset.previewError);
      await page.getByRole('button', { name: 'Save frame', exact: true }).click();
      await page.waitForFunction(() => window.captureErrors.length > 0);
      expect(await page.evaluate(() => window.uploads.length)).toBe(0);
      expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Frame capture unavailable');
      expect(await page.locator('video').evaluate(v => getComputedStyle(v).visibility)).toBe('hidden');
    } finally { await page.evaluate(() => window.restoreContext()); }
    expect(errors).toEqual([]);
  });
});
