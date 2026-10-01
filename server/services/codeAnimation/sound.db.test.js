/** Public workflows pin revision/audio binding, restart/cancel and provider consent. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';
vi.mock('../../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('animation-sound-') }));
vi.mock('../../lib/fileUtils.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('animation-sound-') }));
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
vi.mock('./stageRender.js', () => ({
  sampleFilm: vi.fn(async (_, { times, captureTimes = [], signal }) => {
    signal.throwIfAborted();
    return { contract: { durationSec: 2, fps: 12, width: 1280, height: 720 },
      samples: times.map(t => ({ t, renderHash: String(t), mean: 80, deviation: 20 })),
      frames: captureTimes.map(t => ({ t, bytes: Buffer.from('png') })) };
  }),
  renderViaMediaQueue: vi.fn(async ({ signal }) => { signal.throwIfAborted(); throw new Error('Synthetic render failure'); }),
}));
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { request } from '../../lib/testHelper.js';
import { PATHS } from '../../lib/paths.js';
import { createCodeAnimationPackage } from '../../lib/codeAnimationPackage.js';
import { soundTimeline, synthesizeSoundtrack } from '../../lib/codeAnimationSound.js';
import { evaluateVerdict } from './evidence.js';
import { sampleFilm, renderViaMediaQueue } from './stageRender.js';
import { activeStageRunIds } from './stages.js';
import { muxSoundtrack } from './sound.js';
import { emitCodeAnimationChanged } from '../socket.js';
import routes from '../../routes/codeAnimation.js';

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('codeAnimation/sound.db.test', health.connected, health.error);
if (ready) await ensureSchema();
const ids = [];
afterAll(async () => {
  if (ready && ids.length) await query('DELETE FROM code_animation_projects WHERE id = ANY($1::text[])', [ids]);
  await close(); cleanupTempDataRoots();
});
const app = express(); app.use(express.json({ limit: '55mb' })); app.use('/animation', routes); app.use(errorMiddleware);
const post = (path, body) => request(app).post(`/animation${path}`).send(body);
const get = path => request(app).get(`/animation${path}`);
const audio = { kind: 'procedural', version: 1, events: [
  { label: 'Impact', atSeconds: 0.5, effect: 'impact', durationSeconds: 0.2, gain: 0.8 },
  { label: 'Reveal', atSeconds: 1.25, effect: 'reveal', durationSeconds: 0.4, gain: 0.6 },
] };
const manifest = (sound = audio) => ({
  title: 'Example short', brief: { concept: 'An original reveal', cast: '', onScreenText: '' }, styleGuide: 'Flat shapes',
  renderer: { kind: 'browser', version: 'example-v1', engine: null }, format: { width: 1280, height: 720, fps: 12, durationSeconds: 2 }, seed: 1,
  entrypoints: [{ role: 'preview', path: 'index.html' }], assets: [], shots: [], events: [], audio: sound,
  execution: { requested: null, effective: null },
});
const packageOf = (sound = audio) => createCodeAnimationPackage(manifest(sound), [{ path: 'index.html', content: '<html><canvas></canvas></html>' }]);
async function create(sound = audio, budgets = {}) {
  const response = await post('/projects', { manifest: manifest(sound), budgets });
  expect(response.status).toBe(201); ids.push(response.body.id);
  const imported = await post(`/projects/${response.body.id}/import`, packageOf(sound));
  expect(imported.status).toBe(201);
  return { project: response.body, revision: imported.body.revision };
}
// Wait for the persisted terminal event, never a fixed-duration polling retry.
async function terminal(id, start) {
  let resolve;
  const done = new Promise(r => { resolve = r; });
  emitCodeAnimationChanged.mockImplementation(projectId => {
    if (projectId === id && !activeStageRunIds().length) resolve();
  });
  const response = await start();
  expect(response.status).toBe(202);
  await done;
  emitCodeAnimationChanged.mockReset();
  return (await get(`/projects/${id}/history`)).body.items.find(run => run.id === response.body.id);
}

describe.skipIf(!ready)('Revision-bound sound public workflows', () => {
  it('keeps v1 packages compatible and validates versioned sound timelines at the public import boundary', async () => {
    expect((await post('/packages/validate', packageOf({ kind: 'silence' }))).body.schemaVersion).toBe(1);
    const versioned = packageOf();
    expect((await post('/packages/validate', versioned)).body.schemaVersion).toBe(2);
    expect((await post('/packages/validate', { ...versioned, schemaVersion: 1 })).status).toBe(400);
    const outside = structuredClone(versioned);
    outside.manifest.audio.events[0].atSeconds = 2;
    expect((await post('/packages/validate', outside)).status).toBe(400);
  });

  it('persists deterministic audio despite render failure, and rejects stale event/revision evidence with identical source bytes', async () => {
    const { project, revision } = await create();
    await post(`/projects/${project.id}/accept`, { revisionId: revision.id });
    const run = await terminal(project.id, () => post(`/projects/${project.id}/stage-runs`, {}));
    expect(run.status).toBe('failed');
    expect(run.data.output).toBeNull();
    const sound = run.data.soundtrack;
    const wav = await readFile(join(PATHS.data, sound.artifact.relativePath));
    expect(wav.equals(synthesizeSoundtrack(soundTimeline(revision.manifest)))).toBe(true);
    expect(run.data.reservedBytes).toBeGreaterThan(wav.length);
    const changed = { ...audio, events: audio.events.map(event => ({ ...event, atSeconds: event.atSeconds + 0.1 })) };
    const imported = await post(`/projects/${project.id}/import`, packageOf(changed));
    const next = imported.body.revision;
    expect(next.sourceHash).toBe(revision.sourceHash);
    expect(next.packageHash).not.toBe(revision.packageHash);
    expect(soundTimeline(next.manifest).hash).not.toBe(sound.timelineHash);
    expect(evaluateVerdict({ evidence: run.data.stages.find(stage => stage.key === 'inspect').evidence,
      sourceHash: next.sourceHash, packageHash: next.packageHash, findings: [], unverified: [] }).status).toBe('stale');
    await expect(muxSoundtrack({ projectId: project.id, revision: next, soundtrack: sound, result: {}, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'CODE_ANIMATION_SOUND_STALE' });
    expect((await get(`/projects/${project.id}`)).body.acceptedRevisionId).toBe(revision.id);
    expect(await readFile(join(PATHS.data, sound.artifact.relativePath))).toEqual(wav);
  });

  it('stages upload/library bytes through portable candidates, then normalizes both without live path references', async () => {
    const { project, revision } = await create();
    const wav = synthesizeSoundtrack(soundTimeline(revision.manifest));
    for (const source of ['upload', 'library']) {
      const root = source === 'upload' ? PATHS.uploads : PATHS.music;
      await mkdir(root, { recursive: true }); await writeFile(join(root, 'example.wav'), wav);
      const response = await post(`/projects/${project.id}/sound-assets`, { revisionId: revision.id, source, filename: 'example.wav' });
      expect(response.status).toBe(201);
      const exported = (await get(`/projects/${project.id}/revisions/${response.body.revision.id}/package`)).body;
      expect(exported.manifest.audio).toEqual({ kind: 'file', path: 'audio/soundtrack.wav' });
      // Once staged, the original is irrelevant to offline production.
      await writeFile(join(root, 'example.wav'), 'replaced');
      const run = await terminal(project.id, () => post(`/projects/${project.id}/stage-runs`, {}));
      expect(run.data.soundtrack).toMatchObject({ kind: 'file', measured: { durationMs: 2000, frames: 96000 } });
    }
    expect((await post(`/projects/${project.id}/sound-assets`, { revisionId: revision.id, source: 'upload', filename: '/private/example.wav' })).status).toBe(400);
  });

  it('requires new explicit consent and an independent audio budget; refuses unsupported declarations before any provider call', async () => {
    const { project } = await create({ kind: 'generated', version: 1, prompt: 'Original reveal score' });
    expect((await post(`/projects/${project.id}/stage-runs`, {})).body.code).toBe('CODE_ANIMATION_AUDIO_CONSENT_REQUIRED');
    expect((await post(`/projects/${project.id}/stage-runs`, { audioConsent: true, audioProviderId: 'example', audioModel: 'example-model', audioBudgetUsd: 1 })).body.code).toBe('CODE_ANIMATION_AUDIO_PROVIDER_UNSUPPORTED');
    expect((await get(`/projects/${project.id}/history`)).body.items.filter(run => run.data.kind === 'production-stages')).toEqual([]);
    const legacy = await create({ kind: 'procedural', notes: 'Web Audio' });
    const run = await terminal(legacy.project.id, () => post(`/projects/${legacy.project.id}/stage-runs`, {}));
    expect(run).toMatchObject({ status: 'failed', data: { soundtrack: null, output: null, error: { code: 'CODE_ANIMATION_SOUND_UNSUPPORTED' } } });
  });

  it('keeps accepted work on audio budget exhaustion and cancellation, and restart never resumes sound automatically', async () => {
    const { project, revision } = await create(audio, { diskBytes: 10000 });
    await post(`/projects/${project.id}/accept`, { revisionId: revision.id });
    const exhausted = await terminal(project.id, () => post(`/projects/${project.id}/stage-runs`, {}));
    expect(exhausted).toMatchObject({ status: 'exhausted', data: { stopReason: 'disk', output: null } });
    expect((await get(`/projects/${project.id}`)).body.acceptedRevisionId).toBe(revision.id);
    const normal = await create();
    let rendering;
    const renderingStarted = new Promise(resolve => { rendering = resolve; });
    renderViaMediaQueue.mockImplementationOnce(async ({ signal }) => {
      rendering(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const done = terminal(normal.project.id, () => post(`/projects/${normal.project.id}/stage-runs`, {}));
    await renderingStarted;
    const live = (await get(`/projects/${normal.project.id}/history`)).body.items.find(run => run.status === 'running');
    expect((await post(`/projects/${normal.project.id}/stage-runs/${live.id}/cancel`, {})).status).toBe(200);
    const canceled = await done;
    expect(canceled.status).toBe('canceled');
    const persisted = await readFile(join(PATHS.data, canceled.data.soundtrack.artifact.relativePath));
    const strandedId = randomUUID();
    await query("INSERT INTO code_animation_project_runs (id, project_id, revision_id, status, data) VALUES ($1,$2,$3,'running',$4)",
      [strandedId, normal.project.id, normal.revision.id, { kind: 'production-stages', soundtrack: canceled.data.soundtrack }]);
    sampleFilm.mockClear(); renderViaMediaQueue.mockClear();
    const history = (await get(`/projects/${normal.project.id}/history`)).body.items;
    expect(history.find(run => run.id === strandedId).status).toBe('interrupted');
    expect(sampleFilm).not.toHaveBeenCalled(); expect(renderViaMediaQueue).not.toHaveBeenCalled();
    expect(await readFile(join(PATHS.data, canceled.data.soundtrack.artifact.relativePath))).toEqual(persisted);
  }, 30000);
});
