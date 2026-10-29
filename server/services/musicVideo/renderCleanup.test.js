import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const root = () => lazyTempDataRoot('mv-render-cleanup-');
vi.mock('../../lib/paths.js', async load => makePathsProxy(await load(), { dataRoot: root }));
const state = { project: null, others: [], collections: [], timelines: [], director: [], boards: [], active: false, failHistory: false, kitActive: false, jobs: [] };
vi.mock('../../lib/fileUtils.js', async load => {
  const actual = await load();
  return { ...actual, atomicWrite: async (path, data) => {
    if (state.failHistory && path.endsWith('video-history.json')) throw new Error('History write failed');
    return actual.atomicWrite(path, data);
  } };
});
vi.mock('./publishKit.js', () => ({ isPublishKitBuildActive: () => state.kitActive }));
vi.mock('../mediaJobQueue/index.js', () => ({ listJobs: () => state.jobs }));
vi.mock('./projects.js', () => ({
  getProject: vi.fn(async () => state.project), listProjects: vi.fn(async () => [state.project, ...state.others]),
  withProjectMediaMutation: async work => work({}),
}));
vi.mock('../mediaCollections.js', () => ({ listCollections: async () => state.collections }));
vi.mock('../videoTimeline/local.js', () => ({ listProjects: async () => state.timelines }));
vi.mock('../creativeDirector/local.js', () => ({ listProjects: async () => state.director }));
vi.mock('../moodBoard/db.js', () => {
  const listBoards = vi.fn(async () => state.boards);
  return { listBoards, withBoardMediaReferences: async work => work(await listBoards()) };
});
vi.mock('../mediaAssetIndex/index.js', () => ({ unindexVideo: vi.fn(async () => {}) }));
vi.mock('./render.js', () => ({ isProjectRenderActive: () => state.active }));
vi.mock('./shotSegments.js', () => ({
  assertSegmentCleanupIdle: vi.fn(), cleanupShotSegments: vi.fn(async () => {}),
  getSegmentCleanup: async () => ({ stale: [], unusedLooks: [] }),
}));

const { cleanupSupersededFinals, cleanupRenders, getRenderCleanup, withRenderCleanupReservation, assertRenderCleanupIdle } = await import('./renderCleanup.js');
const { PATHS } = await import('../../lib/fileUtils.js');
const { saveHistory, loadHistory } = await import('../videoGen/history.js');
const { unindexVideo } = await import('../mediaAssetIndex/index.js');
const { assertSegmentCleanupIdle } = await import('./shotSegments.js');
const { listBoards } = await import('../moodBoard/db.js');
const loomStore = await import('../fableLoom/store.js');
afterAll(cleanupTempDataRoots);
beforeEach(async () => {
  rmSync(root(), { recursive: true, force: true });
  mkdirSync(PATHS.videos, { recursive: true });
  mkdirSync(PATHS.videoThumbnails, { recursive: true });
  state.project = { id: 'example-project', renderHistoryId: 'current' };
  state.others = []; state.collections = []; state.timelines = []; state.director = []; state.active = false; state.failHistory = false; state.kitActive = false; state.jobs = [];
  state.boards = [];
  vi.clearAllMocks();
  assertSegmentCleanupIdle.mockReset();
  await saveHistory([]);
});
const entry = (id, over = {}) => ({ id, filename: `${id}.mp4`, thumbnail: `${id}.jpg`, modelId: 'music-video', musicVideoProjectId: 'example-project', ...over });
async function seed(entries) {
  for (const item of entries) {
    writeFileSync(join(PATHS.videos, item.filename), 'video');
    writeFileSync(join(PATHS.videoThumbnails, item.thumbnail), 'poster');
  }
  await saveHistory(entries);
}

describe('derived render retention', () => {
  it('retains upscaled deliverables while retiring obsolete final renders', async () => {
    await seed([entry('current'), entry('old'), entry('topaz', { upscaledFrom: 'current', upscaleMethod: 'topaz' }), entry('lanczos', { upscaledFrom: 'current', upscaleMethod: 'lanczos' })]);
    expect((await getRenderCleanup('example-project')).finals.map(item => item.id)).toEqual(['old']);
    expect(await cleanupSupersededFinals('example-project', { replacementId: 'current' })).toBe(1);
    expect((await loadHistory()).map(item => item.id)).toEqual(['current', 'topaz', 'lanczos']);
    expect(existsSync(join(PATHS.videos, 'topaz.mp4'))).toBe(true);
    expect(existsSync(join(PATHS.videos, 'lanczos.mp4'))).toBe(true);
  });

  it('retains and reports an upscale already present in the cleanup journal', async () => {
    const saved = entry('saved-upscale', { upscaledFrom: 'current', upscaleMethod: 'topaz' });
    await seed([entry('current'), saved]);
    await saveHistory([entry('current')]);
    writeFileSync(join(PATHS.videos, '.music-video-render-cleanup.json'), JSON.stringify({ version: 1, entries: [saved] }));
    expect((await getRenderCleanup('example-project')).finals).toEqual([expect.objectContaining({ id: 'saved-upscale', pending: true, reason: expect.stringMatching(/Upscaled deliverable retained/) })]);
    expect(await cleanupSupersededFinals('example-project')).toBe(0);
    expect(existsSync(join(PATHS.videos, 'saved-upscale.mp4'))).toBe(true);
    expect(existsSync(join(PATHS.videos, '.music-video-render-cleanup.json'))).toBe(true);
  });

  it('retains FableLoom scene and playback videos until their saved owner is deleted', async () => {
    const protectedIds = ['scene', 'entry', 'hold', 'exit'];
    await seed(['current', ...protectedIds, 'unused'].map(id => entry(id)));
    const loom = {
      id: 'loom-example', episodes: [{ nodes: [{ videoHistoryId: 'scene', playbackAssets: {
        entryVideoHistoryId: 'entry', holdLoopVideoHistoryIds: ['hold'], exitByTransition: { next: 'exit' },
      } }] }],
    };
    await loomStore.writeRaw(loom.id, loom);

    expect((await getRenderCleanup('example-project')).finals.filter(item => !item.reason).map(item => item.id)).toEqual(['unused']);
    expect(await cleanupSupersededFinals('example-project', { replacementId: 'current' })).toBe(1);
    expect((await cleanupRenders('example-project')).finals.every(item => item.reason)).toBe(true);
    expect((await loadHistory()).map(item => item.id)).toEqual(['current', ...protectedIds]);
    for (const id of protectedIds) expect(existsSync(join(PATHS.videos, `${id}.mp4`))).toBe(true);
    await loomStore.writeRaw(loom.id, { ...loom, deleted: true });
    expect(await cleanupSupersededFinals('example-project')).toBe(protectedIds.length);
  });

  it('keeps history and video bytes when FableLoom ownership cannot be read', async () => {
    await seed([entry('current'), entry('old')]);
    const read = vi.spyOn(loomStore, 'withLoomMediaReferences').mockRejectedValueOnce(new Error('Loom store unavailable'));
    try {
      await expect(cleanupSupersededFinals('example-project')).rejects.toThrow('Loom store unavailable');
      expect((await loadHistory()).map(item => item.id)).toEqual(['current', 'old']);
      expect(existsSync(join(PATHS.videos, 'old.mp4'))).toBe(true);
      expect(unindexVideo).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
    expect(await cleanupSupersededFinals('example-project')).toBe(1);
  });

  it('removes superseded composites, posters, proof sheets and index rows, preserving sources and referenced renders', async () => {
    const ids = ['current', 'old', 'take', 'clone', 'collection', 'timeline', 'director', 'derived'];
    await seed([...ids.map(id => entry(id)), entry('source', { modelId: 'video-model' }), entry('other', { musicVideoProjectId: 'another-project' }), entry('child', { sourceId: 'derived', musicVideoProjectId: null })]);
    state.project.scenes = [{ takes: [{ assetId: 'take' }] }];
    state.project.productionRuns = [{ status: 'completed', finalRender: { jobId: 'old' } }];
    state.project.autonomousRun = { status: 'completed', output: { renderJobId: 'old', finalReviewedJobId: 'old' } };
    state.others = [{ revision: { sourceRenderId: 'clone' } }];
    state.collections = [{ items: [{ ref: 'collection' }] }];
    state.timelines = [{ clips: [{ videoHistoryId: 'timeline' }] }];
    state.director = [{ finalVideoId: 'director' }];
    writeFileSync(join(PATHS.videoThumbnails, 'old-proof.png'), 'proof');
    const inventory = await getRenderCleanup('example-project');
    expect(inventory.finals.filter(item => !item.reason).map(item => item.id)).toEqual(['old']);
    expect(await cleanupSupersededFinals('example-project', { replacementId: 'current' })).toBe(1);
    expect((await loadHistory()).map(item => item.id)).not.toContain('old');
    expect(unindexVideo).toHaveBeenCalledWith('old', { strict: true });
    for (const file of ['old.mp4']) expect(existsSync(join(PATHS.videos, file))).toBe(false);
    for (const file of ['old.jpg', 'old-proof.png']) expect(existsSync(join(PATHS.videoThumbnails, file))).toBe(false);
    for (const id of [...ids.filter(id => id !== 'old'), 'source', 'other']) expect(existsSync(join(PATHS.videos, `${id}.mp4`))).toBe(true);
  });

  it('preserves canonical render URLs during automatic and explicit cleanup', async () => {
    await seed([entry('current'), entry('path'), entry('url'), entry('proof'), entry('poster', { thumbnail: 'poster sample.jpg' }), entry('unused')]);
    writeFileSync(join(PATHS.videoThumbnails, 'proof-proof.png'), 'proof');
    state.others = [{ composition: { media: '/data/videos/path.mp4' }, proof: '/data/video-thumbnails/proof-proof.png' }];
    state.collections = [{ items: [{ url: 'https://example.test/data/videos/url.mp4?download=1' }, { poster: 'https://example.test/data/video-thumbnails/poster%20sample.jpg' }] }];
    expect(await cleanupSupersededFinals('example-project', { replacementId: 'current' })).toBe(1);
    const result = await cleanupRenders('example-project');
    expect(result.finals.map(item => [item.id, !!item.reason])).toEqual([['path', true], ['url', true], ['proof', true], ['poster', true]]);
    expect(existsSync(join(PATHS.videoThumbnails, 'proof-proof.png'))).toBe(true);
    expect(existsSync(join(PATHS.videoThumbnails, 'poster sample.jpg'))).toBe(true);
    for (const id of ['current', 'path', 'url', 'proof', 'poster']) expect(existsSync(join(PATHS.videos, `${id}.mp4`))).toBe(true);
    expect(existsSync(join(PATHS.videos, 'unused.mp4'))).toBe(false);
  });

  it('retains finals consumed by active publishing-kit builds and queued media jobs', async () => {
    await seed([entry('current'), entry('old')]);
    state.kitActive = true;
    expect(await cleanupSupersededFinals('example-project', { replacementId: 'current' })).toBe(0);
    expect((await getRenderCleanup('example-project')).finals[0].reason).toMatch(/publishing-kit/);
    state.kitActive = false;
    state.jobs = [{ status: 'queued', params: { sourceId: 'old' } }];
    expect(await cleanupSupersededFinals('example-project')).toBe(0);
    expect(existsSync(join(PATHS.videos, 'old.mp4'))).toBe(true);
    state.jobs = [];
    expect(await cleanupSupersededFinals('example-project')).toBe(1);
  });

  it('preserves mood-board video keys and poster URLs through automatic and manual cleanup', async () => {
    await seed([entry('current'), entry('pinned', { filename: 'pinned final.mp4' }), entry('poster'), entry('unused')]);
    state.boards = [{ id: 'example-board', items: [
      { type: 'video', mediaKey: 'video:pinned final.mp4' },
      { type: 'image', imageUrl: 'https://example.test/data/video-thumbnails/poster.jpg?preview=1' },
    ] }];
    const reason = 'Referenced by saved media or production records';
    expect((await getRenderCleanup('example-project')).finals.map(item => [item.id, item.reason]))
      .toEqual([['pinned', reason], ['poster', reason], ['unused', null]]);
    expect(await cleanupSupersededFinals('example-project', { replacementId: 'current' })).toBe(1);
    expect((await cleanupRenders('example-project')).finals.map(item => item.id)).toEqual(['pinned', 'poster']);
    expect((await loadHistory()).map(item => item.id)).toEqual(['current', 'pinned', 'poster']);
    expect(existsSync(join(PATHS.videos, 'pinned final.mp4'))).toBe(true);
    expect(existsSync(join(PATHS.videoThumbnails, 'poster.jpg'))).toBe(true);
    expect(unindexVideo.mock.calls.map(([id]) => id)).toEqual(['unused']);
  });

  it('retires nothing when mood-board ownership cannot be read, then rechecks on retry', async () => {
    await seed([entry('current'), entry('old')]);
    listBoards.mockRejectedValueOnce(new Error('Mood board store unavailable'));
    await expect(cleanupSupersededFinals('example-project')).rejects.toThrow('Mood board store unavailable');
    expect((await loadHistory()).map(item => item.id)).toEqual(['current', 'old']);
    expect(existsSync(join(PATHS.videos, 'old.mp4'))).toBe(true);
    expect(unindexVideo).not.toHaveBeenCalled();
    state.boards = [{ items: [{ type: 'video', mediaKey: 'video:old.mp4' }] }];
    expect(await cleanupSupersededFinals('example-project')).toBe(0);
    state.boards = [];
    expect(await cleanupSupersededFinals('example-project')).toBe(1);
  });

  it('keeps a pending retirement when a mood-board pin arrives before its retry', async () => {
    await seed([entry('current'), entry('old')]);
    state.failHistory = true;
    await expect(cleanupSupersededFinals('example-project')).rejects.toThrow('History write failed');
    state.failHistory = false;
    state.boards = [{ items: [{ type: 'video', mediaKey: 'video:old.mp4' }] }];
    expect(await cleanupSupersededFinals('example-project')).toBe(0);
    expect((await loadHistory()).map(item => item.id)).toEqual(['current', 'old']);
    expect(existsSync(join(PATHS.videos, 'old.mp4'))).toBe(true);
    expect((await getRenderCleanup('example-project')).finals[0]).toMatchObject({ id: 'old', pending: true, reason: 'Referenced by saved media or production records' });
    state.boards = [];
    expect(await cleanupSupersededFinals('example-project')).toBe(1);
    expect(existsSync(join(PATHS.videos, '.music-video-render-cleanup.json'))).toBe(false);
  });

  it('keeps history and bytes retryable when index removal fails, then settles them on retry', async () => {
    await seed([entry('current'), entry('old')]);
    unindexVideo.mockRejectedValueOnce(new Error('Index temporarily unavailable'));
    await expect(cleanupSupersededFinals('example-project')).rejects.toThrow('Index temporarily unavailable');
    expect((await loadHistory()).map(item => item.id)).toContain('old');
    expect(existsSync(join(PATHS.videos, 'old.mp4'))).toBe(true);
    expect(await cleanupSupersededFinals('example-project')).toBe(1);
    expect((await loadHistory()).map(item => item.id)).not.toContain('old');
    expect(existsSync(join(PATHS.videos, 'old.mp4'))).toBe(false);
    expect(unindexVideo).toHaveBeenCalledTimes(2);
  });

  it('retains recovery metadata and all video bytes if history publication fails', async () => {
    await seed([entry('current'), entry('old')]);
    state.failHistory = true;
    await expect(cleanupSupersededFinals('example-project')).rejects.toThrow('History write failed');
    expect((await loadHistory()).map(item => item.id)).toContain('old');
    expect(existsSync(join(PATHS.videos, 'old.mp4'))).toBe(true);
    expect((await getRenderCleanup('example-project')).finals).toEqual([expect.objectContaining({ id: 'old', pending: true })]);
    state.failHistory = false;
    expect(await cleanupSupersededFinals('example-project')).toBe(1);
    expect(existsSync(join(PATHS.videos, '.music-video-render-cleanup.json'))).toBe(false);
    expect((await loadHistory()).map(item => item.id)).toEqual(['current']);
  });

  it('keeps the previous final when its replacement failed to become the current render, or its file is missing', async () => {
    await seed([entry('current'), entry('new')]);
    expect(await cleanupSupersededFinals('example-project', { replacementId: 'new' })).toBe(0);
    expect(existsSync(join(PATHS.videos, 'new.mp4'))).toBe(true);
    state.project.renderHistoryId = 'new';
    rmSync(join(PATHS.videos, 'new.mp4'));
    expect(await cleanupSupersededFinals('example-project', { replacementId: 'new' })).toBe(0);
    expect(existsSync(join(PATHS.videos, 'current.mp4'))).toBe(true);
  });

  it('refuses cleanup while renders are active and fences new starts until cleanup settles', async () => {
    await seed([entry('current'), entry('old')]);
    state.active = true;
    await expect(cleanupRenders('example-project')).rejects.toMatchObject({ code: 'RENDER_IN_PROGRESS' });
    state.active = false;
    assertSegmentCleanupIdle.mockImplementationOnce(() => { throw Object.assign(new Error('busy'), { code: 'SHOT_RENDER_ACTIVE' }); });
    await expect(cleanupRenders('example-project')).rejects.toMatchObject({ code: 'SHOT_RENDER_ACTIVE' });
    expect(existsSync(join(PATHS.videos, 'old.mp4'))).toBe(true);
    await withRenderCleanupReservation('example-project', async () => {
      expect(() => assertRenderCleanupIdle('example-project')).toThrow(/cleanup is in progress/);
      await expect(cleanupRenders('example-project')).rejects.toMatchObject({ code: 'RENDER_CLEANUP_ACTIVE' });
    });
    expect(() => assertRenderCleanupIdle('example-project')).not.toThrow();
  });

  it('reconciles a partially deleted batch without leaving broken history rows, and reports unreadable history', async () => {
    await seed([entry('current'), entry('retired'), entry('old')]);
    rmSync(join(PATHS.videoThumbnails, 'old.jpg'));
    mkdirSync(join(PATHS.videoThumbnails, 'old.jpg'));
    await expect(cleanupSupersededFinals('example-project')).rejects.toThrow();
    expect((await loadHistory()).map(item => item.id)).toEqual(['current']);
    expect(existsSync(join(PATHS.videos, 'retired.mp4'))).toBe(false);
    expect((await getRenderCleanup('example-project')).finals).toEqual([expect.objectContaining({ id: 'old', pending: true })]);
    expect(existsSync(join(PATHS.videos, 'current.mp4'))).toBe(true);
    rmSync(join(PATHS.videoThumbnails, 'old.jpg'), { recursive: true });
    expect(await cleanupSupersededFinals('example-project')).toBe(1);
    expect((await getRenderCleanup('example-project')).finals).toEqual([]);
    writeFileSync(join(PATHS.data, 'video-history.json'), '{invalid');
    await expect(cleanupSupersededFinals('example-project')).rejects.toThrow();
    expect(existsSync(join(PATHS.videos, 'current.mp4'))).toBe(true);
  });
});
