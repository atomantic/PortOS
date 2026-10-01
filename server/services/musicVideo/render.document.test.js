/**
 * Render planning for the composition-document render style: a `document`
 * project takes the seeked path with its document folder, a full render and a
 * draft excerpt both refuse (and release their slot) while no document is
 * attached, and the finished render is filed like any other.
 */

import { describe, expect, it, vi, afterAll } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-document-plan-'),
}));
vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({ ...(await importOriginal()), generateThumbnail: vi.fn(async () => 'thumb.jpg') }));
vi.mock('../instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'instance-test') }));
vi.mock('../videoGen/local.js', () => ({ loadHistory: vi.fn(async () => []), mutateVideoHistory: vi.fn(async () => {}) }));
vi.mock('./codeRender.js', async (importOriginal) => ({ ...(await importOriginal()), writeCodeProofSheet: vi.fn(async () => null) }));
vi.mock('./documentRender.js', async (importOriginal) => ({
  ...(await importOriginal()),
  encodeDocumentComposition: vi.fn(async ({ plan }) => ({ width: plan.width, height: plan.height, fps: 24, durationSec: plan.durationSec, startSec: 0, boundaryTimes: [0] })),
}));

const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projects.js');
const { renderMusicVideo } = await import('./render.js');
const { startExcerptRender } = await import('./excerptRender.js');
const { importDocumentTemplate } = await import('./compositionDocument.js');
const { encodeDocumentComposition } = await import('./documentRender.js');
const { mutateVideoHistory } = await import('../videoGen/local.js');

afterAll(() => cleanupTempDataRoots());

async function documentProject() {
  await mkdir(PATHS.music, { recursive: true });
  await writeFile(join(PATHS.music, 'song.wav'), Buffer.alloc(64));
  const created = await projects.createProject({ name: 'Doc', uploadedAudioFilename: 'song.wav', composition: { mode: 'document' } });
  await projects.mutateProjectRecord(created.id, (current) => ({ project: { ...current, audioAnalysis: { durationSec: 12.5, beats: [], downbeats: [], sections: [] } } }));
  return created.id;
}

describe('composition-document render plan', () => {
  it('checks owning production after preparation and again before encoding, releasing refused render slots', async () => {
    const id = await documentProject();
    await importDocumentTemplate(id);
    encodeDocumentComposition.mockClear();
    const refused = () => { throw Object.assign(new Error('Production stopped'), { code: 'PRODUCTION_NOT_RUNNING' }); };
    await expect(renderMusicVideo(id, { verifyCurrent: refused })).rejects.toMatchObject({ code: 'PRODUCTION_NOT_RUNNING' });
    expect(encodeDocumentComposition).not.toHaveBeenCalled();
    let checks = 0;
    await renderMusicVideo(id, { verifyCurrent: () => { if (++checks === 2) refused(); } });
    await vi.waitFor(async () => expect((await projects.getProject(id)).status).toBe('failed'));
    expect(checks).toBe(2);
    expect(encodeDocumentComposition).not.toHaveBeenCalled();
    // Both preparation and asynchronous encode refusal release the per-project slot.
    await renderMusicVideo(id);
    await vi.waitFor(() => expect(encodeDocumentComposition).toHaveBeenCalledOnce());
  });

  it('refuses a full render and an excerpt while no document is attached, and releases both slots', async () => {
    const id = await documentProject();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(renderMusicVideo(id)).rejects.toMatchObject({ status: 409, code: 'COMPOSITION_DOCUMENT_MISSING' });
      await expect(startExcerptRender(id, { startSec: 1, endSec: 3 })).rejects.toMatchObject({ status: 409, code: 'COMPOSITION_DOCUMENT_MISSING' });
    }
    expect(encodeDocumentComposition).not.toHaveBeenCalled();
  });

  it('renders the attached document over the song and files the result', async () => {
    const id = await documentProject();
    const { document } = await importDocumentTemplate(id);
    const { jobId } = await renderMusicVideo(id);
    await vi.waitFor(() => expect(mutateVideoHistory).toHaveBeenCalled());
    const call = encodeDocumentComposition.mock.calls.at(-1)[0];
    expect(call).toMatchObject({
      jobId,
      audioPath: join(PATHS.music, 'song.wav'),
      soundBed: null,
      plan: { directory: document.directory, songDurationSec: 12.5, durationSec: 12.5, fps: 24, width: 1920, height: 1080 },
    });
    expect(call).not.toHaveProperty('windowStart');
    await vi.waitFor(async () => expect((await projects.getProject(id)).renderHistoryId).toBe(jobId));
  });

  it('renders a faded 9:16 social cut of a 16:9 document project without re-framing the project (#9280)', async () => {
    const id = await documentProject();
    await importDocumentTemplate(id);
    encodeDocumentComposition.mockClear();
    const { excerptId } = await startExcerptRender(id, { startSec: 1, endSec: 4, aspect: '9:16', fade: true });
    await vi.waitFor(async () => expect((await projects.getProject(id)).excerpts.find((e) => e.id === excerptId).status).toBe('complete'));
    const call = encodeDocumentComposition.mock.calls.at(-1)[0];
    expect(call).toMatchObject({ fade: true, windowStart: 1, windowEnd: 4, plan: { width: 1080, height: 1920 } });
    expect(call.project.treatment.brief.aspectRatio).toBe('9:16');
    const stored = await projects.getProject(id);
    expect(stored.treatment?.brief?.aspectRatio ?? '16:9').toBe('16:9');
    expect(stored.excerpts.find((e) => e.id === excerptId)).toMatchObject({ aspect: '9:16', fade: true, width: 1080, height: 1920 });
  });

  it('refuses a social cut of a footage project, which has no frame of its own to re-lay-out (#9280)', async () => {
    await mkdir(PATHS.music, { recursive: true });
    await writeFile(join(PATHS.music, 'song.wav'), Buffer.alloc(64));
    const { id } = await projects.createProject({ name: 'Footage', uploadedAudioFilename: 'song.wav' });
    for (const body of [{ aspect: '9:16' }, { fade: true }]) {
      await expect(startExcerptRender(id, { startSec: 1, endSec: 3, ...body })).rejects.toMatchObject({ status: 422, code: 'EXCERPT_ASPECT_UNSUPPORTED' });
    }
  });

  it('refuses a full render and an excerpt over a stale performance take, like a footage render (#9266)', async () => {
    const id = await documentProject();
    await importDocumentTemplate(id);
    await projects.mutateProjectRecord(id, (current) => ({ project: {
      ...current,
      scenes: [{ sceneId: 'mvs-1', order: 0, shotMode: 'performance', startSec: 1, endSec: 3, videoHistoryId: 'clip-1', takes: [] }],
    } }));
    encodeDocumentComposition.mockClear();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(renderMusicVideo(id)).rejects.toMatchObject({
        status: 422, code: 'STALE_PERFORMANCE_TAKES', context: { stale: [{ sceneId: 'mvs-1', reason: 'not-lip-synced' }] },
      });
      await expect(startExcerptRender(id, { startSec: 1, endSec: 3 })).rejects.toMatchObject({ status: 422, code: 'STALE_PERFORMANCE_TAKES' });
    }
    expect(encodeDocumentComposition).not.toHaveBeenCalled();
  });
});
