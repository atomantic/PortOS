/**
 * Composition-document render staging, through encodeDocumentComposition with
 * the composition browser stubbed at its boundary: the job folder holds
 * portos-mv.js with each scene's selected take and the take files beside the
 * page, a reserved media name is refused, the page must be (or declare) the
 * project's aspect, and the job folder is removed however the render ends.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../htmlComposition/encode.js', async (importOriginal) => ({ ...(await importOriginal()), encodeComposition: vi.fn(async () => { throw new Error('stop at encoder'); }) }));
const { encodeComposition } = await import('../htmlComposition/encode.js');

const { browser } = vi.hoisted(() => ({ browser: { seen: null, contract: null } }));
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-document-stage-'),
}));
// The staging assertions stop before ffmpeg ever runs; CI images have no
// ffmpeg on PATH, so resolve the lookup instead of depending on the host.
vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findFfmpeg: async () => 'ffmpeg',
}));
// Capture the frozen job folder the page would open, then stop the render.
vi.mock('../htmlComposition/browser.js', () => ({
  openComposition: async (directory) => {
    const { readFile: read, readdir: list } = await import('node:fs/promises');
    const { join: joinPath } = await import('node:path');
    const { PATHS: paths } = await import('../../lib/paths.js');
    const dir = joinPath(paths.data, directory);
    const media = {};
    for (const name of await list(joinPath(dir, 'media'))) media[name] = await read(joinPath(dir, 'media', name), 'utf8');
    const window = {};
    new Function('window', await read(joinPath(dir, 'portos-mv.js'), 'utf8'))(window);
    browser.seen = { directory, data: window.PORTOS_MV, media, song: JSON.parse(await read(joinPath(dir, 'song.json'), 'utf8')) };
    return {
      async evaluate(expression) {
        if (expression.includes('canPlayType')) return 'probably';
        if (browser.contract) return browser.contract;
        throw new Error('stop after staging');
      },
      check() {},
      async close() {},
      async send() { return {}; },
    };
  },
}));

const { PATHS } = await import('../../lib/paths.js');
const { encodeDocumentComposition, documentRenderClock } = await import('./documentRender.js');

afterAll(() => cleanupTempDataRoots());
beforeEach(() => { browser.seen = null; browser.contract = null; });

const performanceTake = (assetId) => ({ takeId: 'mvt-p', kind: 'video', assetId, status: 'candidate', shotInstruction: { shotMode: 'performance', edit: { inSec: 0.5, outSec: 3.5 } } });

async function fixture({ shipped = {} } = {}) {
  await mkdir(PATHS.videos, { recursive: true });
  await mkdir(PATHS.images, { recursive: true });
  await writeFile(join(PATHS.videos, 'clip-a.mp4'), 'video-a');
  await writeFile(join(PATHS.images, 'still-b.png'), 'image-b');
  await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-a', filename: 'clip-a.mp4', numFrames: 96, fps: 24, width: 1280, height: 720 }]));
  const directory = 'music-video/mv-stage/composition/doc-test';
  await rm(join(PATHS.data, directory), { recursive: true, force: true });
  await mkdir(join(PATHS.data, directory), { recursive: true });
  await writeFile(join(PATHS.data, directory, 'index.html'), '<!doctype html><script src="portos-mv.js"></script>');
  for (const [name, body] of Object.entries(shipped)) {
    await mkdir(join(PATHS.data, directory, name, '..'), { recursive: true });
    await writeFile(join(PATHS.data, directory, name), body);
  }
  const project = {
    id: 'mv-stage', name: 'Stage', audioAnalysis: { durationSec: 30, beats: [0, 0.5], downbeats: [0], sections: [] },
    lyricCues: [{ id: 'l1', text: 'first line', startSec: 1, endSec: 2 }],
    composition: { mode: 'document', textCues: [{ id: 'c1', text: 'hero', startSec: 1, endSec: 2, emphasis: 'hero' }], overlay: { enabled: true, ticker: ['a'] } },
    scenes: [
      { sceneId: 'a', order: 0, startSec: 0, endSec: 4, videoHistoryId: 'vh-a', referenceImageId: 'still-b.png' },
      { sceneId: 'b', order: 1, startSec: 4, endSec: 8, videoHistoryId: 'vh-gone', referenceImageId: 'still-b.png', visualLayer: 'still', stillMove: 'push' },
      { sceneId: 'c', order: 2, startSec: 8, endSec: 9, visualLayer: 'card', cardText: 'Title' },
      { sceneId: 'd', order: 3, startSec: 9, endSec: 12, shotMode: 'performance', videoHistoryId: 'vh-a', takes: [performanceTake('vh-a')] },
    ],
  };
  const plan = { directory, songDurationSec: 30, clock: documentRenderClock(30), frame: { width: 1920, height: 1080 } };
  return { project, plan };
}

const encode = (project, plan, jobId) => encodeDocumentComposition({ project, plan, jobId, audioPath: join(PATHS.data, 'none.wav'), outputPath: join(PATHS.videos, `${jobId}.mp4`) });
const scratchEntries = async () => (await readdir(join(PATHS.data, 'music-video-song-renders')).catch(() => []));

describe('composition document staging', () => {
  it('preserves the document shutter sampling contract through the shared encoder', async () => {
    const { project, plan } = await fixture();
    browser.contract = { durationSec: 30, fps: 24, width: 1920, height: 1080, motionBlur: 4, layout: false };
    await expect(encode(project, plan, 'job-shutter')).rejects.toThrow('stop at encoder');
    expect(encodeComposition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ motionBlur: 4 }), expect.any(String), expect.any(Object));
  });
  it('writes portos-mv.js with each scene\'s selected take (video first) and copies the files beside the page', async () => {
    const { project, plan } = await fixture();
    await expect(encode(project, plan, 'job-stage')).rejects.toThrow('stop after staging');
    const { data, media, song } = browser.seen;
    const byId = Object.fromEntries(data.scenes.map((s) => [s.sceneId, s]));
    expect(byId.a.media).toMatchObject({ kind: 'video', src: 'media/scene-a.mp4', inSec: 0, outSec: 4, fps: 24 });
    expect(byId.b.media).toMatchObject({ kind: 'image', src: 'media/scene-b.png' });
    expect(byId.b).toMatchObject({ visualLayer: 'still', stillMove: 'push' });
    expect(byId.c).toMatchObject({ media: null, visualLayer: 'card', cardText: 'Title' });
    expect(byId.d.media).toMatchObject({ kind: 'video', src: 'media/scene-d.mp4', inSec: 0.5, outSec: 3.5 });
    expect(data.render).toEqual({ width: 1920, height: 1080, fps: 24, frames: 720, durationSec: 30 });
    expect(data.song).toMatchObject({ durationSec: 30, beats: [0, 0.5], downbeats: [0] });
    expect(data.lyrics.map((l) => l.text)).toEqual(['first line']);
    expect(data.textCues.map((c) => c.emphasis)).toEqual(['hero']);
    expect(data.composition).toMatchObject({ mode: 'document', overlay: { enabled: true, ticker: ['a'] } });
    expect(media).toEqual({ 'scene-a.mp4': 'video-a', 'scene-b.png': 'image-b', 'scene-d.mp4': 'video-a' });
    expect(song).toMatchObject({ beats: [0, 0.5], downbeats: [0] });
    // The source document is untouched and the job folder is gone.
    expect(existsSync(join(PATHS.data, plan.directory, 'portos-mv.js'))).toBe(false);
    expect(await scratchEntries()).toEqual([]);
  });

  it('refuses a document that ships a file under a name PortOS writes at render time', async () => {
    const { project, plan } = await fixture({ shipped: { 'media/scene-a.mp4': 'mine' } });
    await expect(encode(project, plan, 'job-clash')).rejects.toMatchObject({ code: 'COMPOSITION_DOCUMENT_INVALID' });
    expect(browser.seen).toBeNull();
    expect(await readFile(join(PATHS.data, plan.directory, 'media/scene-a.mp4'), 'utf8')).toBe('mine');
    expect(await scratchEntries()).toEqual([]);
  });

  it('renders the project aspect only when the page is that aspect or declares it', async () => {
    const { project, plan } = await fixture();
    browser.contract = { durationSec: 10, fps: 24, width: 1280, height: 720, layout: false };
    const vertical = { ...project, treatment: { brief: { aspectRatio: '9:16' } } };
    await expect(encode(vertical, plan, 'job-aspect')).rejects.toMatchObject({ code: 'COMPOSITION_DOCUMENT_FORMAT' });
    browser.contract = { ...browser.contract, durationSec: 31 };
    await expect(encode(project, plan, 'job-long')).rejects.toMatchObject({ code: 'COMPOSITION_DOCUMENT_CONTRACT' });
    expect(await scratchEntries()).toEqual([]);
  });
});

// Uniquely prevents an imported timeline from failing with only a generic schema message.
it('explains fractional document frames before encoding without changing the imported duration', async () => {
  const { project, plan } = await fixture();
  browser.contract = { durationSec: 10.01, fps: 24, width: 1920, height: 1080 };
  await expect(encode(project, plan, 'job-fractional')).rejects.toMatchObject({
    code: 'COMPOSITION_DOCUMENT_FRAME_ALIGNMENT', status: 422,
    message: expect.stringContaining('240/24 (10s)'),
    context: { durationSec: 10.01, fps: 24, frames: 240.24 },
  });
  expect(browser.contract.durationSec).toBe(10.01);
  expect(await scratchEntries()).toEqual([]);
});
