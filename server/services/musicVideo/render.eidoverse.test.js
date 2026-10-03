import { expect, it, vi, afterAll } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
vi.mock('../../lib/paths.js', async load => makePathsProxy(await load(), { dataRoot: () => lazyTempDataRoot('portos-mv-eidoverse-plan-') }));
vi.mock('./productionReview.js', async load => ({ ...await load(), assertProductionApproval: vi.fn() }));
vi.mock('../../lib/ffmpeg.js', async load => ({ ...await load(), generateThumbnail: vi.fn(async () => 'thumb.jpg') }));
vi.mock('../instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'test-instance') }));
vi.mock('../videoGen/local.js', () => ({ loadHistory: vi.fn(async () => []), mutateVideoHistory: vi.fn(async () => {}) }));
vi.mock('./codeRender.js', async load => ({ ...await load(), writeCodeProofSheet: vi.fn(async () => null) }));
vi.mock('./eidoverseRender.js', async load => ({
  ...await load(),
  prepareEidoverseRender: vi.fn(async project => {
    if (!project.composition.eidoverseScene) throw Object.assign(new Error('Save a scene'), { code: 'EIDOVERSE_SCENE_REQUIRED' });
    return { width: 1280, height: 720, durationSec: project.audioAnalysis.durationSec, fps: 24 };
  }),
  encodeEidoverseComposition: vi.fn(async ({ plan, windowStart = 0, windowEnd = plan.durationSec }) => ({ ...plan, durationSec: windowEnd - windowStart, boundaryTimes: [0] })),
}));
const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projects.js');
const { renderMusicVideo } = await import('./render.js');
const { startExcerptRender } = await import('./excerptRender.js');
const { encodeEidoverseComposition } = await import('./eidoverseRender.js');
const { mutateVideoHistory } = await import('../videoGen/local.js');
afterAll(cleanupTempDataRoots);
async function create(scene = { inlineScript: 'example source' }) {
  await mkdir(PATHS.music, { recursive: true });
  await writeFile(join(PATHS.music, 'song.wav'), Buffer.alloc(64));
  const p = await projects.createProject({ name: 'Example Eidoverse Film', uploadedAudioFilename: 'song.wav', composition: { mode: 'eidoverse', eidoverseScene: scene } });
  await projects.mutateProjectRecord(p.id, current => ({ project: { ...current, audioAnalysis: { durationSec: 10, beats: [], downbeats: [], sections: [] } } }));
  return p.id;
}
it('routes both the final film and song-window proof through Eidoverse without requiring generated scene clips', async () => {
  const id = await create();
  const { jobId } = await renderMusicVideo(id);
  await vi.waitFor(async () => expect((await projects.getProject(id)).renderHistoryId).toBe(jobId));
  expect(mutateVideoHistory).toHaveBeenCalled();
  expect(encodeEidoverseComposition.mock.calls.at(-1)[0]).toMatchObject({ audioPath: join(PATHS.music, 'song.wav'), project: { composition: { mode: 'eidoverse' } } });
  const { excerptId } = await startExcerptRender(id, { startSec: 2, endSec: 5 });
  await vi.waitFor(async () => expect((await projects.getProject(id)).excerpts.find(e => e.id === excerptId).status).toBe('complete'));
  expect(encodeEidoverseComposition.mock.calls.at(-1)[0]).toMatchObject({ windowStart: 2, windowEnd: 5, audioPath: join(PATHS.music, 'song.wav') });
});
it('refuses a missing scene for both render paths and releases their reservations for retry', async () => {
  const id = await create(null);
  for (let i = 0; i < 2; i++) {
    await expect(renderMusicVideo(id)).rejects.toMatchObject({ code: 'EIDOVERSE_SCENE_REQUIRED' });
    await expect(startExcerptRender(id, { startSec: 0, endSec: 2 })).rejects.toMatchObject({ code: 'EIDOVERSE_SCENE_REQUIRED' });
  }
});
