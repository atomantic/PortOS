/**
 * A composed shot whose typography overlay never paints must fail the shot,
 * with the timeout and the scene id, instead of leaving it stale. A later
 * capture of the same shot renders and clears that failure.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-shot-overlay-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));

const browser = vi.hoisted(() => {
  const state = { hangSeek: false, signal: null, opened: [] };
  const page = {
    evaluate: vi.fn((expression) => {
      if (state.hangSeek && String(expression).includes('.seek(')) {
        return new Promise((resolve, reject) => {
          const signal = state.signal;
          if (!signal) return;
          const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Render cancelled'));
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail, { once: true });
        });
      }
      return Promise.resolve(undefined);
    }),
    send: vi.fn(async (method) => (method === 'Page.captureScreenshot'
      ? { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }
      : {})),
    close: vi.fn(async () => {}),
    check: vi.fn(),
  };
  return {
    state,
    page,
    openComposition: vi.fn(async (directory, options) => {
      state.signal = options?.signal || null;
      state.opened.push({ directory, options });
      return page;
    }),
  };
});
vi.mock('../htmlComposition/browser.js', () => ({ openComposition: browser.openComposition }));

const fixture = { clips: [], audioPath: null };
vi.mock('./render.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    planMusicVideoRender: vi.fn(async () => ({
      ffmpeg: 'ffmpeg', audioPath: fixture.audioPath, composed: true, clips: fixture.clips.map((clip) => ({ ...clip })),
      audioDurationSec: 1, soundBed: null, aspect: null, coldOpen: null,
    })),
  };
});
vi.mock('./filmLookFinish.js', () => ({ applyFilmLookFinish: vi.fn(async () => true) }));
vi.mock('./projects.js', () => ({
  getProject: vi.fn(async (id) => (id === fixture.project?.id ? fixture.project : null)),
  withProjectMediaMutation: async (work) => work({}),
}));

const { buildTypographyDocument } = await import('./composition.js');
const { titleCardRuntimeSource } = await import('../../lib/musicVideoTitleCard.js');
const { typographyOverlayWindows } = await import('./compositionRender.js');
const { cancelShotRender, getShotRenderStatus, startShotRender } = await import('./shotSegments.js');
const { musicVideoEvents } = await import('./events.js');
const { PATHS } = await import('../../lib/fileUtils.js');

const previousTimeout = process.env.PORTOS_MUSIC_VIDEO_OVERLAY_FRAME_TIMEOUT_MS;
afterAll(() => {
  if (previousTimeout === undefined) delete process.env.PORTOS_MUSIC_VIDEO_OVERLAY_FRAME_TIMEOUT_MS;
  else process.env.PORTOS_MUSIC_VIDEO_OVERLAY_FRAME_TIMEOUT_MS = previousTimeout;
  cleanupTempDataRoots();
});

const hasFfmpeg = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

describe('typography overlay capture bounds', () => {
  it('drops a window that is not a finite frame count and keeps a real one', () => {
    expect(typographyOverlayWindows({
      cues: [{ startSec: 0, endSec: Number.POSITIVE_INFINITY }], fps: 24, durationSec: Number.POSITIVE_INFINITY,
    })).toEqual([]);
    expect(typographyOverlayWindows({
      cues: [{ startSec: 0, endSec: 0.5 }], fps: 24, durationSec: 1,
    })).toEqual([{ name: 'doc', windows: [{ startSec: 0, frames: 12 }] }]);
  });

  it('bounds the overlay seek and the title-card font wait in the page', () => {
    const html = buildTypographyDocument({
      cues: [{ id: 'c', text: 'Hello', startSec: 0, endSec: 1, template: 'fade', placement: 'lower', emphasis: 'subtitle' }],
      style: {}, width: 320, height: 180, durationSec: 1, fps: 24,
    });
    expect(html).toContain('setTimeout(resolve, 250)');
    expect(titleCardRuntimeSource({ enabled: true, title: 'Example Song' })).toContain('setTimeout(resolve, 2000)');
  });
});

describe.skipIf(!hasFfmpeg)('a hung typography overlay fails the shot', () => {
  beforeAll(() => {
    const media = join(ROOT(), 'fixture');
    mkdirSync(media, { recursive: true });
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(media, 'a.mp4')]);
    fixture.audioPath = join(media, 'song.wav');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-y', fixture.audioPath]);
    fixture.clips = [{
      sceneId: 'a', videoPath: join(media, 'a.mp4'), width: 320, height: 180, fps: 24, duration: 1,
      sourceSec: 1, inSec: 0, outSec: 1, loop: false, frameFit: 'fill',
    }];
  });

  const project = () => ({
    id: 'mv-overlay-shot', name: 'Example', composition: { mode: 'composed' },
    scenes: [{ sceneId: 'a', order: 0 }],
    titleCard: { enabled: true, title: 'Example Song', artist: 'Example Artist', startSec: 0, endSec: 0.5, fadeSec: 0 },
  });

  const waitForShot = (state) => vi.waitFor(() => {
    const match = events.find((event) => event.state === state);
    expect(match).toBeTruthy();
    return match;
  }, { timeout: 8000 });

  let events = [];
  const onShot = (event) => { if (event.projectId === 'mv-overlay-shot') events.push(event); };

  it('reports failed within the timeout, then renders and clears it', async () => {
    expect(PATHS.data).toContain('mv-shot-overlay-');
    process.env.PORTOS_MUSIC_VIDEO_OVERLAY_FRAME_TIMEOUT_MS = '250';
    browser.state.hangSeek = true;
    browser.state.opened.length = 0;
    events = [];
    fixture.project = project();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    musicVideoEvents.on('shot-render', onShot);
    const started = Date.now();
    try {
      expect(await startShotRender('mv-overlay-shot', 'a')).toMatchObject({ state: 'rendering' });
      const failed = await waitForShot('failed');
      expect(Date.now() - started).toBeLessThan(8000);
      expect(failed.error).toMatch(/timed out after 250ms for scene a/);
      expect(failed.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(errorLog.mock.calls.some(([line]) => String(line).includes('timed out after 250ms for scene a'))).toBe(true);
      const status = await getShotRenderStatus('mv-overlay-shot');
      expect(status.shots[0]).toMatchObject({
        sceneId: 'a', state: 'failed', rendering: false, files: [], error: failed.error, failedAt: failed.failedAt,
      });
      expect(browser.state.opened[0].options).toMatchObject({ ownedBrowser: true });

      browser.state.hangSeek = false;
      events = [];
      expect(await startShotRender('mv-overlay-shot', 'a')).toMatchObject({ state: 'rendering' });
      await waitForShot('rendered');
      const rendered = await getShotRenderStatus('mv-overlay-shot');
      expect(rendered.shots[0].state).toBe('rendered');
      expect(rendered.shots[0].error).toBeUndefined();
      expect(rendered.shots[0].files.length).toBeGreaterThan(0);
    } finally {
      browser.state.hangSeek = false;
      errorLog.mockRestore();
      musicVideoEvents.off('shot-render', onShot);
    }
  }, 30000);

  it('records a cancel as canceled, not failed', async () => {
    process.env.PORTOS_MUSIC_VIDEO_OVERLAY_FRAME_TIMEOUT_MS = '5000';
    browser.state.hangSeek = true;
    events = [];
    fixture.project = { ...project(), id: 'mv-overlay-cancel' };
    const onCancel = (event) => { if (event.projectId === 'mv-overlay-cancel') events.push(event); };
    musicVideoEvents.on('shot-render', onCancel);
    try {
      expect(await startShotRender('mv-overlay-cancel', 'a')).toMatchObject({ state: 'rendering' });
      expect(cancelShotRender('mv-overlay-cancel', 'a')).toBe(true);
      const canceled = await vi.waitFor(() => {
        const match = events.find((event) => event.state === 'canceled');
        expect(match).toBeTruthy();
        return match;
      }, { timeout: 3000 });
      expect(canceled.error).toBeNull();
      expect(events.some((event) => event.state === 'failed')).toBe(false);
      const status = await getShotRenderStatus('mv-overlay-cancel');
      expect(status.shots[0].state).toBe('stale');
      expect(status.shots[0].error).toBeUndefined();
    } finally {
      browser.state.hangSeek = false;
      musicVideoEvents.off('shot-render', onCancel);
    }
  }, 15000);
});
