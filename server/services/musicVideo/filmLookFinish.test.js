/**
 * The film look finishing pass over a footage render, with the composition
 * browser, the shared encoder and ffmpeg stubbed at their boundaries: what the
 * pass stages and asks of them, that the render is replaced in place only
 * once the pass succeeds, and that nothing is left behind either way.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-film-look-finish-'),
}));
const { seen } = vi.hoisted(() => ({ seen: { opened: [], contract: null, options: null, progress: [], ffmpeg: [], encodeFail: null } }));
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: async () => 'ffmpeg',
  // 48 frames at 24 fps: the container reports a hair more than the frames hold.
  probeVideoGeometry: async () => ({ width: 1280, height: 720, fps: 24, numFrames: 48, durationSec: 2.04 }),
  runFfmpegProcess: async ({ args }) => {
    const { writeFile: write } = await import('node:fs/promises');
    seen.ffmpeg.push(args);
    await write(args.at(-1), 'finished-video');
    return { ok: true };
  },
}));
// The browser mock records the staged page the pass opens and how it opens it.
vi.mock('../htmlComposition/browser.js', () => ({
  openComposition: async (directory, options) => {
    const { readFile: read } = await import('node:fs/promises');
    const { join: joinPath } = await import('node:path');
    const { PATHS: paths } = await import('../../lib/paths.js');
    const dir = joinPath(paths.data, directory);
    seen.opened.push({
      directory, options,
      index: await read(joinPath(dir, 'index.html'), 'utf8'),
      app: await read(joinPath(dir, 'app.js'), 'utf8'),
      source: await read(joinPath(dir, 'media', 'source.mp4'), 'utf8'),
    });
    return { evaluate: async () => 'probably', check() {}, async close() {}, async send() { return {}; } };
  },
}));
vi.mock('../htmlComposition/encode.js', () => ({
  encodeComposition: vi.fn(),
  encodeCompositionSegments: async (_page, contract, outputPath, options) => {
    const { writeFile: write } = await import('node:fs/promises');
    seen.contract = contract;
    seen.options = options;
    if (seen.encodeFail) throw seen.encodeFail;
    options.onProgress?.(0.5);
    await write(outputPath, 'silent-video');
    return {};
  },
}));

const { PATHS } = await import('../../lib/paths.js');
const { FILM_LOOK_FINISH_SCRATCH_DIR, applyFilmLookFinish, filmLookFinishNeeded } = await import('./filmLookFinish.js');

const look = { preset: 'super8', grain: 0.5, halation: 0.4 };
let path;
beforeEach(async () => {
  seen.opened.length = 0;
  seen.ffmpeg.length = 0;
  seen.progress.length = 0;
  seen.contract = null;
  seen.options = null;
  seen.encodeFail = null;
  await mkdir(PATHS.videos, { recursive: true });
  path = join(PATHS.videos, 'music-video-example.mp4');
  await writeFile(path, 'composed-render');
});
afterAll(() => cleanupTempDataRoots());

describe('film look finishing pass', () => {
  it('leaves a render without a look alone, without a browser', async () => {
    expect(filmLookFinishNeeded({ filmLook: null })).toBe(false);
    expect(filmLookFinishNeeded({ filmLook: { preset: 'none' } })).toBe(false);
    expect(filmLookFinishNeeded({ filmLook: look })).toBe(true);
    expect(await applyFilmLookFinish({ project: { filmLook: null }, path, jobId: 'job-plain' })).toBe(false);
    expect(seen.opened).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe('composed-render');
  });

  it('plays the finished cut through the look on song time, copies its audio back and replaces it in place', async () => {
    const result = await applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-look', offsetSec: 3, onProgress: (f) => seen.progress.push(f) });
    expect(result).toBe(true);
    // The staged page: the render itself (linked, not re-encoded), full frame, seeking on song time.
    expect(seen.opened).toHaveLength(1);
    const [opened] = seen.opened;
    expect(opened.directory).toBe(`${FILM_LOOK_FINISH_SCRATCH_DIR}/job-look`);
    expect(opened.options).toMatchObject({ streamMedia: true, ownedBrowser: true });
    expect(opened.options.initScripts).toHaveLength(1);
    expect(opened.options.initScripts[0]).toContain('__portosFilmLook');
    expect(opened.options.initScripts[0]).toContain('"grain":0.5');
    expect(opened.source).toBe('composed-render');
    expect(opened.index).toContain('<video id="source" src="media/source.mp4"');
    expect(opened.app).toContain('OFFSET = 3');
    expect(opened.app).toContain('FPS = 24');
    expect(opened.app).toContain('globalThis.portosComposition =');
    // The contract is the render's own geometry on whole frames; the window starts at the excerpt's song time.
    expect(seen.contract).toEqual({ width: 1280, height: 720, fps: 24, durationSec: 2 });
    expect(seen.options).toMatchObject({ offsetSec: 3 });
    expect(seen.progress).toEqual([0.475, 1]);
    // Pixels from the pass, audio copied from the render, then swapped in.
    expect(seen.ffmpeg).toHaveLength(1);
    const mux = seen.ffmpeg[0];
    expect(mux.slice(mux.indexOf('-i'))).toEqual(['-i', `${path}.look.silent.mp4`, '-i', path, '-map', '0:v:0', '-map', '1:a?', '-c', 'copy', '-movflags', '+faststart', '-y', `${path}.look.mp4`]);
    expect(await readFile(path, 'utf8')).toBe('finished-video');
    expect(existsSync(join(PATHS.data, FILM_LOOK_FINISH_SCRATCH_DIR, 'job-look'))).toBe(false);
    expect(existsSync(`${path}.look.silent.mp4`)).toBe(false);
    expect(existsSync(`${path}.look.mp4`)).toBe(false);
  });

  it('keeps the render as it was when the capture fails, and cleans up', async () => {
    seen.encodeFail = new Error('browser died');
    await expect(applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-fail' })).rejects.toThrow('browser died');
    expect(await readFile(path, 'utf8')).toBe('composed-render');
    expect(seen.ffmpeg).toEqual([]);
    expect(existsSync(join(PATHS.data, FILM_LOOK_FINISH_SCRATCH_DIR, 'job-fail'))).toBe(false);
  });
});
