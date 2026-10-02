import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('mv-song-revision-test-') }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
const { default: routes } = await import('./musicVideo.js');
const store = await import('../services/musicVideo/projects.js');
const service = await import('../services/musicVideo/songRevision.js');
const { captureMusicVideoEvidence } = await import('../lib/musicVideoDependencies.js');
const { stripMusicVideoLocalRenderPins } = await import('../lib/syncWire.js');
const app = express();
app.use(express.json()); app.use('/api/music-video', routes); app.use(errorMiddleware);
const fields = { title: 'Example song', style: 'Bright synth pop', lyrics: '[Verse]\nA new morning', instrumental: false };
const post = (id, action = '', body = {}) => request(app).post(`/api/music-video/${id}/song-revision${action ? `/${action}` : ''}`).send(body);
async function fixture() {
  const source = await store.createProject({ name: 'Example video', uploadedAudioFilename: 'original.m4a', composition: { mode: 'code' } });
  await store.mutateProjectRecord(source.id, (p) => {
    const project = { ...p, status: 'complete', lyricCues: [{ id: 'cue-a', text: 'Old morning', startSec: 1, endSec: 2 }],
      scenes: [{ sceneId: 'scene-a', referenceImageId: 'art.png', visualLayer: 'still', startSec: 0, endSec: 20, beatAligned: true }],
      renderHistoryId: 'old-render', audioAnalysis: { durationSec: 20 },
    };
    project.excerpts = [{ id: 'proof-a', status: 'complete', startSec: 0, endSec: 10, dependencies: captureMusicVideoEvidence(project) }];
    return { project };
  });
  const before = await store.getProject(source.id);
  const fork = await store.cloneProject(source.id);
  const draft = await post(fork.id, '', fields);
  expect(draft.status).toBe(200);
  return { before, fork, revisionId: draft.body.project.songRevision.id };
}
afterEach(async () => { await service.__testing.settle(); service.__setSongRevisionDepsForTests(); });
afterAll(cleanupTempDataRoots);

describe('fork song revision through HTTP', () => {
  it('keeps source and shared art intact, selects only explicit candidates and marks old proof evidence stale', async () => {
    const { before, fork, revisionId } = await fixture();
    const generate = vi.fn(async (_fields, opts) => {
      if (!opts.songIds) await opts.onSubmitted(['take-a', 'take-b']);
      const songId = opts.songIds?.[0] || 'take-b';
      return { songId, filename: `${songId}.m4a` };
    });
    service.__setSongRevisionDepsForTests({ generate });
    expect((await post(before.id, '', fields)).status).toBe(409);
    expect((await post(fork.id, '', { ...fields, unknown: true })).status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
    expect((await post(fork.id, 'generate', { revisionId })).status).toBe(202);
    await service.__testing.settle();
    const pending = await store.getProject(fork.id);
    expect(pending.uploadedAudioFilename).toBe('original.m4a');
    expect(pending.songRevision.status).toBe('review');
    expect(pending.songRevision.candidates).toHaveLength(2);
    expect((await post(fork.id, 'select', { revisionId, songId: 'unknown' })).status).toBe(409);
    const selected = await post(fork.id, 'select', { revisionId, songId: 'take-a' });
    expect(selected.status).toBe(200);
    expect(selected.body.project).toMatchObject({ uploadedAudioFilename: 'take-a.m4a', trackId: null, audioAnalysis: null, status: 'draft' });
    expect(selected.body.project.lyricCues[0]).toMatchObject({ text: 'A new morning', startSec: null });
    expect(selected.body.project.scenes[0]).toMatchObject({ referenceImageId: 'art.png', beatAligned: false });
    expect(selected.body.project.excerpts[0].dependencyState.status).toBe('stale');
    expect(await store.getProject(before.id)).toEqual(before);
    expect((await post(fork.id, 'select', { revisionId, songId: 'take-b' })).status).toBe(409);
    const next = await store.cloneProject(fork.id);
    expect(next.songRevision).toBeNull();
    expect(next.songRevisionHistory.at(-1).selectedSongId).toBe('take-a');
    expect(stripMusicVideoLocalRenderPins(pending)).not.toHaveProperty('songRevision');
  });

  it('retries downloads without repeating Create and cancels without changing master', async () => {
    const { fork, revisionId } = await fixture();
    let fail = true;
    let submissions = 0;
    service.__setSongRevisionDepsForTests({ generate: async (_fields, opts) => {
      if (!opts.songIds) { submissions++; await opts.onSubmitted(['take-a', 'take-b']); }
      if (fail) throw new Error('download failed');
      return { songId: opts.songIds[0], filename: `${opts.songIds[0]}.m4a` };
    } });
    await post(fork.id, 'generate', { revisionId }); await service.__testing.settle();
    expect((await store.getProject(fork.id)).songRevision.status).toBe('failed');
    fail = false;
    await post(fork.id, 'generate', { revisionId }); await service.__testing.settle();
    expect(submissions).toBe(1);
    expect((await post(fork.id, 'cancel', { revisionId })).status).toBe(200);
    expect((await store.getProject(fork.id)).uploadedAudioFilename).toBe('original.m4a');
    const next = await post(fork.id, '', { ...fields, lyrics: 'Another morning' });
    expect(next.status).toBe(200);
    expect(next.body.project.songRevisionHistory.at(-1).status).toBe('canceled');
    expect((await post(fork.id, 'generate', { revisionId })).status).toBe(409);
  });

  it('refuses concurrent generation, stops a late completion after cancel and refuses ambiguous resubmission', async () => {
    const { fork, revisionId } = await fixture();
    const held = Promise.withResolvers();
    const entered = Promise.withResolvers();
    service.__setSongRevisionDepsForTests({ generate: async (_fields, opts) => {
      await opts.onSubmitted(['take-a']); entered.resolve(); await held.promise;
      return { songId: 'take-a', filename: 'take-a.m4a' };
    } });
    await post(fork.id, 'generate', { revisionId }); await entered.promise;
    expect((await post(fork.id, 'generate', { revisionId })).status).toBe(409);
    await post(fork.id, 'cancel', { revisionId }); held.resolve(); await service.__testing.settle();
    expect((await store.getProject(fork.id)).songRevision).toMatchObject({ status: 'canceled', candidates: [] });
    const next = await post(fork.id, '', fields);
    const newId = next.body.project.songRevision.id;
    service.__setSongRevisionDepsForTests({ generate: async () => { throw new Error('unknown submission'); } });
    await post(fork.id, 'generate', { revisionId: newId }); await service.__testing.settle();
    const refused = await post(fork.id, 'generate', { revisionId: newId });
    expect(refused.status).toBe(409); expect(refused.body.code || refused.body.error?.code).toBe('SONG_SUBMISSION_UNKNOWN');
  });
});
