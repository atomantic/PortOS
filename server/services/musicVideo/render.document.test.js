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
  encodeDocumentComposition: vi.fn(async ({ plan }) => ({ width: 1920, height: 1080, fps: 24, durationSec: plan.durationSec, startSec: 0, boundaryTimes: [0] })),
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
});
