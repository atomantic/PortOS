/**
 * The cutting room floor outro pass over a finished render, with the
 * composition browser, the shared encoder and ffmpeg stubbed at their
 * boundaries: what the pass stages and asks of them, that the render grows by
 * the outro only once the pass succeeds, and that nothing is left behind.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-stats-outro-'),
}));
const { seen } = vi.hoisted(() => ({ seen: { opened: [], contract: null, ffmpeg: [], encodeFail: null } }));
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: async () => 'ffmpeg',
  probeVideoGeometry: async () => ({ width: 1920, height: 1080, fps: 24, numFrames: 480, durationSec: 20 }),
  runFfmpegProcess: async ({ args }) => {
    const { writeFile: write } = await import('node:fs/promises');
    seen.ffmpeg.push(args);
    await write(args.at(-1), 'render-with-outro');
    return { ok: true };
  },
}));
vi.mock('../../lib/imageThumbnail.js', () => ({ ensureImageThumbnail: async () => false }));
vi.mock('../mediaCollections.js', () => ({
  musicVideoCollectionId: (id) => `mvc-${id}`,
  getCollection: async () => ({ items: [{ kind: 'image', ref: 'floor.png' }, { kind: 'video', ref: 'clip-floor' }] }),
}));
vi.mock('../videoGen/history.js', () => ({ loadHistory: async () => [{ id: 'clip-stamped', musicVideo: { projectId: 'mv-1' } }] }));
vi.mock('../htmlComposition/browser.js', () => ({
  openComposition: async (directory, options) => {
    const { readFile: read, readdir } = await import('node:fs/promises');
    const { join: joinPath } = await import('node:path');
    const { PATHS: paths } = await import('../../lib/paths.js');
    const dir = joinPath(paths.data, directory);
    seen.opened.push({ directory, options, index: await read(joinPath(dir, 'index.html'), 'utf8'), app: await read(joinPath(dir, 'app.js'), 'utf8'), fonts: await readdir(joinPath(dir, 'fonts')) });
    return { check() {}, async close() {} };
  },
}));
vi.mock('../htmlComposition/encode.js', () => ({
  encodeComposition: async (_page, contract, outputPath) => {
    const { writeFile: write } = await import('node:fs/promises');
    seen.contract = contract;
    if (seen.encodeFail) throw seen.encodeFail;
    await write(outputPath, 'outro-clip');
  },
}));

const { PATHS } = await import('../../lib/paths.js');
const { STATS_OUTRO_SCRATCH_DIR, appendStatsOutro } = await import('./statsOutro.js');

const project = { id: 'mv-1', statsOutro: { enabled: true, durationSec: 6 }, scenes: [{ sceneId: 's', referenceImageId: 'kept.png' }] };
let path;
beforeEach(async () => {
  seen.opened.length = 0;
  seen.ffmpeg.length = 0;
  seen.contract = null;
  seen.encodeFail = null;
  await mkdir(PATHS.videos, { recursive: true });
  path = join(PATHS.videos, 'music-video-example.mp4');
  await writeFile(path, 'render');
});
afterAll(() => cleanupTempDataRoots());

describe('cutting room floor outro pass', () => {
  it('leaves a render alone, without a browser, while the outro is off', async () => {
    expect(await appendStatsOutro({ project: { ...project, statsOutro: { enabled: false } }, path, jobId: 'job-off' })).toBe(0);
    expect(await appendStatsOutro({ project: { ...project, statsOutro: null }, path, jobId: 'job-none' })).toBe(0);
    expect(seen.opened).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe('render');
  });

  it('draws the tally at the render\'s own size and joins it after the song with silence under it', async () => {
    expect(await appendStatsOutro({ project, path, jobId: 'job-on' })).toBe(6);
    const [opened] = seen.opened;
    expect(opened.directory).toBe(`${STATS_OUTRO_SCRATCH_DIR}/job-on`);
    expect(opened.options).toMatchObject({ ownedBrowser: true });
    expect(opened.fonts.sort()).toEqual(['archivo-variable.woff2', 'ibm-plex-mono-500.woff2']);
    expect(opened.index).toContain('<canvas id="outro">');
    // The counts the page draws are the project's: its shot, its collection and the clip stamped with it.
    expect(opened.app).toContain('"stills":{"made":2,"kept":1},"clips":{"made":2,"kept":0}');
    expect(seen.contract).toEqual({ width: 1920, height: 1080, fps: 24, durationSec: 6 });
    const [join2] = seen.ffmpeg;
    expect(join2).toEqual(expect.arrayContaining(['-i', path, '-i', `${path}.outro.mp4`, 'anullsrc=r=48000:cl=stereo']));
    expect(join2[join2.indexOf('-filter_complex') + 1]).toContain('concat=n=2:v=1:a=1');
    expect(await readFile(path, 'utf8')).toBe('render-with-outro');
    expect(existsSync(join(PATHS.data, STATS_OUTRO_SCRATCH_DIR, 'job-on'))).toBe(false);
    expect(existsSync(`${path}.outro.mp4`)).toBe(false);
  });

  it('keeps the render as it was when the capture fails, and cleans up', async () => {
    seen.encodeFail = new Error('browser died');
    await expect(appendStatsOutro({ project, path, jobId: 'job-fail' })).rejects.toThrow('browser died');
    expect(await readFile(path, 'utf8')).toBe('render');
    expect(seen.ffmpeg).toEqual([]);
    expect(existsSync(join(PATHS.data, STATS_OUTRO_SCRATCH_DIR, 'job-fail'))).toBe(false);
  });
});
