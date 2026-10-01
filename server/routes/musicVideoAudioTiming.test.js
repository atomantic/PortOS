import { describe, it, expect, vi, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-audio-timing-');
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../services/tracks/index.js', () => ({ getTrack: vi.fn(async (id) => ({ id, audioFilename: `${id}.wav` })) }));
// Deterministic offline decoder double; route/store/mapping and performance
// fingerprint checks stay real. Different durations model inserted/deleted audio.
vi.mock('../services/musicVideo/audioAnalysis.js', () => ({
  analyzeAudioFile: vi.fn(async (path) => ({ durationSec: basename(path) === 'insert.wav' ? 14 : basename(path) === 'delete.wav' ? 8 : 10, bpm: 120, beats: [], downbeats: [], sections: [] })),
}));
vi.mock('../lib/audioFingerprint.js', async (original) => ({
  ...await original(), computeRmsEnvelope: vi.fn(async () => new Int8Array(1400).fill(-20)),
}));
const { default: routes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { windowFingerprint } = await import('../lib/audioFingerprint.js');
const { compareSchemaVersions, PORTOS_SCHEMA_VERSIONS } = await import('../lib/schemaVersions.js');
const app = express(); app.use(express.json()); app.use('/api/music-video', routes); app.use(errorMiddleware);
const post = (id, action, body) => request(app).post(`/api/music-video/${id}/audio-timing/${action}`).send(body);

async function fixture({ legacy = false } = {}) {
  mkdirSync(join(ROOT(), 'music'), { recursive: true });
  for (const name of ['old', 'insert', 'delete']) writeFileSync(join(ROOT(), 'music', `${name}.wav`), `${name}-synthetic-audio`);
  const project = await projects.createProject({ name: 'Example timing project', trackId: 'old' });
  await projects.mutateProjectRecord(project.id, (p) => ({ project: { ...p,
    lyricCues: [{ id: 'cue', text: 'Example lyric', startSec: 6, endSec: 8, words: [{ w: 'Example', startSec: 6, endSec: 7, conf: 'matched' }, { w: 'lyric', startSec: 7, endSec: 8, conf: 'matched' }] }],
    composition: { mode: 'composed', textCues: [{ id: 'title', text: 'Example', startSec: 6, endSec: 8 }], posterSec: 7 },
    scenes: [
      { sceneId: 'first', label: 'Opening', startSec: 0, endSec: 2, shotMode: 'performance', videoHistoryId: 'clip-a' },
      { sceneId: 'second', label: 'Chorus', startSec: 6, endSec: 8, shotMode: 'performance', videoHistoryId: 'clip-b' },
    ].map((scene) => legacy ? scene : { ...scene, takes: [{ takeId: `take-${scene.sceneId}`, kind: 'video', assetId: scene.videoHistoryId,
      shotInstruction: { shotMode: 'performance', edit: { inSec: 0, outSec: 2 }, songInterval: { startSec: scene.startSec, endSec: scene.endSec },
        audio: { sha256: createHash('sha256').update('old-synthetic-audio').digest('hex'), windowFingerprint: windowFingerprint(new Int8Array(1000).fill(-20), { startSec: scene.startSec, endSec: scene.endSec }) } } }] }),
  } }));
  return projects.getProject(project.id);
}
const insertion = { targetTrackId: 'insert', intervals: [{ oldStartSec: 0, oldEndSec: 4, newStartSec: 0 }, { oldStartSec: 4, oldEndSec: 10, newStartSec: 8 }] };
afterAll(cleanupTempDataRoots);

describe('audio timing preview and Apply', () => {
  it('previews insertion without mutation, preserves unchanged takes and applies once across restart/retry', async () => {
    const before = await fixture();
    const response = await post(before.id, 'preview', insertion);
    expect(response.status).toBe(200);
    expect(response.body.gaps).toEqual([{ status: 'inserted', newStartSec: 4, newEndSec: 8 }]);
    expect(response.body.affectedShots).toMatchObject([
      { sceneId: 'first', status: 'unchanged', repairRequired: false },
      { sceneId: 'second', status: 'moved', newStartSec: 10, newEndSec: 12, repairRequired: true },
    ]);
    expect(await projects.getProject(before.id)).toEqual(before); // dismiss/cancel has no write
    const body = { ...insertion, basis: response.body.basis };
    const [applied, concurrent] = await Promise.all([post(before.id, 'apply', body), post(before.id, 'apply', body)]);
    expect(applied.status).toBe(200);
    expect(concurrent.status).toBe(200);
    expect(applied.body.project.scenes[1]).toMatchObject({ startSec: 10, endSec: 12, takes: before.scenes[1].takes });
    expect(applied.body.project.lyricCues[0]).toMatchObject({ startSec: 10, endSec: 12, words: [{ startSec: 10, endSec: 11 }, { startSec: 11, endSec: 12 }] });
    expect(applied.body.project.composition.textCues[0]).toMatchObject({ startSec: 10, endSec: 12 });
    expect(applied.body.project.composition.posterSec).toBeNull();
    expect(applied.body.revision.before.scenes[1]).toMatchObject({ startSec: 6, endSec: 8 });
    // A fresh public call reads the persisted receipt, with no in-memory token.
    const replay = await post(before.id, 'apply', body);
    expect(replay.body.alreadyApplied).toBe(true);
    expect(replay.body.project.audioTimingRevisions).toHaveLength(1);
    expect(replay.body.project.scenes[1].startSec).toBe(10);
    expect((await post(before.id, 'apply', { ...body, targetTrackId: 'delete' })).status).toBe(409);
    const clone = await projects.cloneProject(before.id, {});
    expect(clone.audioTimingRevisions).toEqual([]);
    expect(clone.scenes[1].startSec).toBe(10);
  });

  it('maps deletions and marks legacy performance evidence for repair', async () => {
    const before = await fixture({ legacy: true });
    const input = { targetTrackId: 'delete', intervals: [{ oldStartSec: 0, oldEndSec: 2, newStartSec: 0 }, { oldStartSec: 4, oldEndSec: 10, newStartSec: 2 }] };
    const preview = await post(before.id, 'preview', input);
    expect(preview.body.gaps).toEqual([{ status: 'deleted', oldStartSec: 2, oldEndSec: 4 }]);
    expect(preview.body.affectedShots[0].repairRequired).toBe(true);
    const applied = await post(before.id, 'apply', { ...input, basis: preview.body.basis });
    expect(applied.status).toBe(200);
    expect(applied.body.project.scenes[1]).toMatchObject({ startSec: 4, endSec: 6, videoHistoryId: 'clip-b' });
  });

  it('refuses overlapping/out-of-bounds maps, ambiguous shots and stale previews without writes', async () => {
    const before = await fixture();
    for (const intervals of [
      [{ oldStartSec: 0, oldEndSec: 11, newStartSec: 0 }],
      [{ oldStartSec: 0, oldEndSec: 4, newStartSec: 0 }, { oldStartSec: 3, oldEndSec: 10, newStartSec: 4 }],
      [{ oldStartSec: 0, oldEndSec: 10, newStartSec: 9 }],
    ]) expect((await post(before.id, 'preview', { targetTrackId: 'insert', intervals })).status).toBe(400);
    const ambiguous = { targetTrackId: 'insert', intervals: [{ oldStartSec: 0, oldEndSec: 7, newStartSec: 0 }, { oldStartSec: 7, oldEndSec: 10, newStartSec: 11 }] };
    const preview = await post(before.id, 'preview', ambiguous);
    expect(preview.body.canApply).toBe(false);
    expect(preview.body.affectedShots[1].status).toBe('ambiguous');
    expect((await post(before.id, 'apply', { ...ambiguous, basis: preview.body.basis })).status).toBe(409);
    const valid = await post(before.id, 'preview', insertion);
    await projects.updateProject(before.id, { name: 'Changed after preview' });
    expect((await post(before.id, 'apply', { ...insertion, basis: valid.body.basis })).status).toBe(409);
    expect((await projects.getProject(before.id)).scenes).toEqual(before.scenes);
    const fresh = await post(before.id, 'preview', insertion);
    writeFileSync(join(ROOT(), 'music', 'insert.wav'), 'changed-after-preview');
    expect((await post(before.id, 'apply', { ...insertion, basis: fresh.body.basis })).status).toBe(409);
  });

  it('keeps receipt-bearing records off older peers', () => {
    expect(compareSchemaVersions(PORTOS_SCHEMA_VERSIONS, { ...PORTOS_SCHEMA_VERSIONS, musicVideoProjects: 16 }).ahead)
      .toContainEqual({ category: 'musicVideoProjects', senderV: PORTOS_SCHEMA_VERSIONS.musicVideoProjects, receiverV: 16 });
  });
});
