import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const author = vi.hoisted(() => ({ sections: [], calls: 0 }));
vi.mock('../services/promptRunner.js', () => ({
  assertProvider: () => {},
  resolveProviderAndModel: async () => ({ provider: { id: 'fixture-author', type: 'api', enabled: true }, selectedModel: 'fixture-model' }),
  runPromptThroughProvider: async ({ beforeExecute }) => {
    await beforeExecute?.({ provider: { id: 'fixture-author', type: 'api' }, model: 'fixture-model' });
    author.calls += 1;
    return { text: JSON.stringify({ sections: author.sections }) };
  },
}));

const ROOT = () => lazyTempDataRoot('mv-production-review-');
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
const auth = vi.hoisted(() => ({ enabled: true }));
vi.mock('../services/auth.js', () => ({ isAuthEnabled: async () => auth.enabled, verifyPassword: async password => password === 'synthetic-operator-password' }));
vi.mock('../services/musicVideo/excerptRender.js', async original => ({ ...await original(),
  startExcerptRender: vi.fn(async (id, window, options) => {
    const store = await import('../services/musicVideo/projects.js');
    const project = await store.getProject(id);
    options.verifyCurrent(project);
    await store.mutateProjectRecord(id, current => ({ project: { ...current,
      excerpts: [...(current.excerpts || []), { id: 'proof-fixture', ...window, status: 'complete', filename: 'synthetic-proof.mp4' }] } }));
    return { jobId: 'proof-job', excerptId: 'proof-fixture' };
  }),
}));

const { default: router } = await import('./musicVideo.js');
const store = await import('../services/musicVideo/projects.js');
const { saveGeneratedDevArtifact } = await import('../services/musicVideo/devArtifactService.js');
const { assertProductionApproval } = await import('../services/musicVideo/productionReview.js');
const app = express();
app.use(express.json()); app.use('/api/music-video', router); app.use(errorMiddleware);
let project, base, draft;
const read = () => request(app).get(`${base}/production-review`);
const save = body => request(app).put(`${base}/production-review`).send(body);
async function approve(stage, extra = {}) {
  const status = await read();
  const excerpt = status.body.project.excerpts?.find(e => e.id === status.body.project.productionReview?.proof?.excerptId);
  const proofReview = stage === 'proof' && excerpt ? { watchedWithAudio: true, excerptId: excerpt.id, filename: excerpt.filename,
    energyComparison: 'The playful energy target reads clearly in the subject and camera action.',
    timecodedNotes: '0:04 doorway opens on the accent; 0:12 the second gesture grows in scale.' } : undefined;
  return request(app).post(`${base}/production-review/approve`).send({ stage, proofReview,
    basis: status.body.readiness.basis[stage], password: 'synthetic-operator-password', ...extra });
}

beforeEach(async () => {
  auth.enabled = true;
  author.calls = 0; author.sections = [];
  project = await store.createProject({ name: 'Example animation', uploadedAudioFilename: 'synthetic-song.wav', composition: { mode: 'code' } });
  base = `/api/music-video/${project.id}`;
  await store.setProjectAnalysis(project.id, { durationSec: 20, bpm: 120, beats: [0, 1], downbeats: [0], sections: [{ startSec: 0, endSec: 20, label: 'Chorus' }] });
  await store.updateProject(project.id, { lyricCues: [{ id: 'line-a', text: 'Example chorus', startSec: 1, endSec: 3,
    words: [{ w: 'Example', startSec: 1, endSec: 2, conf: 'matched' }, { w: 'chorus', startSec: 2, endSec: 3, conf: 'matched' }] }] });
  const scene = await store.addProjectScene(project.id, { label: 'Chorus', startSec: 0, endSec: 20, prompt: 'A paper figure opens a painted doorway.' });
  const { artifact } = await saveGeneratedDevArtifact(project.id, { kind: 'cast-sets', title: 'Example visual sheet', html: '<html><body><svg><circle r="30" cx="40" cy="40"/></svg></body></html>' });
  draft = { cast: 'Paper figure with an angular silhouette.', environments: 'Layered painted doorway.',
    visualLanguage: 'Indigo and cream; bold readable type with open lyric space.', motionLanguage: 'The camera follows the opening doorway; the chorus expands the room.',
    guideArtifactId: artifact.id, lyricsMode: 'vocal', timingStatus: 'verified', timingNotes: 'Synthetic word onsets were checked against the fixture master.',
    storyboard: [{ sceneId: scene.sceneId, lyricCueIds: ['line-a'], action: 'Open the doorway', staging: 'Figure foreground, doorway behind', camera: 'Dolly through doorway', transition: 'Match doorway to next frame' }] };
  expect((await save(draft)).status).toBe(200);
});
afterAll(cleanupTempDataRoots);

describe('human-reviewed Music Video workflow', () => {
  it('prepares an absent code-first medium plan before human storyboard approval and real authoring admission', async () => {
    await store.updateProject(project.id, { mediaMode: 'code-only', composition: { mode: 'document', authoringRenderer: 'canvas' },
      productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } });
    const originalDirection = { camera: 'Keep the authored slow push', medium: 'procedural', mediumPinned: true, mediumRationale: 'Exact code staging' };
    await store.mutateProjectRecord(project.id, current => ({ project: { ...current,
      scenes: current.scenes.map(scene => ({ ...scene, direction: originalDirection })) } }));
    expect((await approve('art')).status).toBe(200);
    const prepared = await request(app).post(`${base}/production-review/prepare`).send({});
    expect(prepared.status).toBe(200);
    expect(prepared.body.project.treatment).toMatchObject({ revision: 1, appliedRevision: 1,
      compiledWith: { source: 'deterministic' }, shotDirections: [{ medium: 'procedural' }] });
    expect(prepared.body.project.scenes[0]).toMatchObject({ direction: originalDirection, prompt: 'A paper figure opens a painted doorway.' });
    expect(prepared.body.readiness.art.approved).toBe(true);
    expect(prepared.body.readiness.storyboard.approved).toBe(false);
    expect(author.calls).toBe(0);
    const generate = () => request(app).post(`${base}/composition/document/generate`).send({ providerId: 'fixture-author', model: 'fixture-model' });
    expect((await generate()).body.code).toBe('MUSIC_VIDEO_APPROVAL_REQUIRED');
    expect((await approve('storyboard')).status).toBe(200);
    const { buildCodeTimeline } = await import('../services/musicVideo/codeTimeline.js');
    author.sections = buildCodeTimeline(await store.getProject(project.id)).sections.map(section => ({ id: section.id,
      source: "function render(ctx, env) { ctx.fillStyle = '#203040'; ctx.fillRect(0, 0, env.width, env.height); }" }));
    const generated = await generate();
    expect(generated.status).toBe(201);
    expect(generated.body.document.source.kind).toBe('generated');
    expect(author.calls).toBe(1);
    const beforeRepeat = await store.getProject(project.id);
    await request(app).post(`${base}/production-review/prepare`).send({});
    const repeated = await store.getProject(project.id);
    expect(repeated.treatment).toEqual(beforeRepeat.treatment);
    expect(repeated.scenes).toEqual(beforeRepeat.scenes);
  });

  it('refuses API credentials, password-free approval, stale revisions and final-render bypasses', async () => {
    const status = await read();
    const body = { stage: 'art', basis: status.body.readiness.basis.art, password: 'synthetic-operator-password' };
    expect((await request(app).post(`${base}/production-review/approve`).set('authorization', 'Bearer synthetic-agent').send(body)).status).toBe(403);
    expect((await approve('art', { password: 'wrong' })).status).toBe(403);
    auth.enabled = false;
    expect((await approve('art')).body.code).toBe('OPERATOR_PASSWORD_REQUIRED');
    auth.enabled = true;
    await save({ ...draft, motionLanguage: 'A different motion direction' });
    expect((await request(app).post(`${base}/production-review/approve`).send(body)).status).toBe(409);
    expect((await request(app).patch(base).send({ productionReview: { approvals: { proof: true } } })).status).toBe(400);
    expect((await request(app).post(`${base}/render`).send({ approved: true })).body.code).toBe('MUSIC_VIDEO_APPROVAL_REQUIRED');
    expect((await request(app).post(`${base}/production-review/proof`).send({ startSec: 0, endSec: 20 })).status).toBe(409);
  });

  it('allows explicitly unapproved feasibility renders before art without granting proof approval', async () => {
    const rendered = await request(app).post(`${base}/production-review/proof`).send({ kind: 'prototype', startSec: 0, endSec: 20 });
    expect(rendered.status).toBe(202);
    const status = await read();
    expect(status.body.project.productionReview.prototype.excerptId).toBeTruthy();
    expect(status.body.project.productionReview.proof).toBeUndefined();
    expect(status.body.readiness.readyForProduction).toBe(false);
    expect((await approve('proof')).status).toBe(409);
  });

  it('reviews art, aligned storyboard and rendered proof, then invalidates revisions and fork approvals', async () => {
    expect((await approve('art')).status).toBe(200);
    expect((await approve('storyboard')).status).toBe(200);
    expect((await request(app).post(`${base}/production-review/proof`).send({ startSec: 0, endSec: 20 })).status).toBe(202);
    expect((await approve('proof', { proofReview: undefined })).body.code).toBe('MUSIC_VIDEO_PROOF_REVIEW_REQUIRED');
    const evidence = { watchedWithAudio: true, excerptId: 'older-proof', filename: 'synthetic-proof.mp4',
      energyComparison: 'Matches the chosen playful target.', timecodedNotes: '0:04 the subject reaches the doorway.' };
    expect((await approve('proof', { proofReview: evidence })).body.code).toBe('MUSIC_VIDEO_REVIEW_STALE');
    expect((await approve('proof', { proofReview: { ...evidence, timecodedNotes: 'Looks good' } })).status).toBe(400);
    expect((await approve('proof')).status).toBe(200);
    const accepted = await store.getProject(project.id);
    expect(accepted.productionReview.approvals.proof.proofReview).toMatchObject({
      watchedWithAudio: true, excerptId: 'proof-fixture', filename: 'synthetic-proof.mp4',
      timecodedNotes: '0:04 doorway opens on the accent; 0:12 the second gesture grows in scale.',
    });
    expect(() => assertProductionApproval(accepted)).not.toThrow();
    const fork = await store.cloneProject(project.id, { variant: 'video-generation' });
    expect(fork.productionReview.approvals).toEqual({});
    expect(fork.productionReview.draft.cast).toBe('');
    expect(fork.productionReview.draft.storyboard[0].sceneId).toBe(fork.scenes[0].sceneId);
    expect(() => assertProductionApproval(fork)).toThrow();
    expect(() => assertProductionApproval(accepted)).not.toThrow();
    await save({ ...draft, visualLanguage: 'New orange direction' });
    expect((await read()).body.readiness.readyForProduction).toBe(false);
    expect((await request(app).post(`${base}/render`).send({})).status).toBe(409);
  });

  it('distinguishes provisional/zero-length/missing lyrics from an explicit instrumental', async () => {
    await approve('art');
    await save({ ...draft, timingStatus: 'provisional' });
    expect((await approve('storyboard')).status).toBe(409);
    await store.updateProject(project.id, { lyricCues: [{ id: 'line-a', text: 'Example', startSec: 1, endSec: 2, words: [{ w: 'Example', startSec: 1, endSec: 1, conf: 'interpolated' }] }] });
    await save(draft);
    expect((await approve('storyboard')).status).toBe(409);
    await save({ ...draft, lyricsMode: 'instrumental' });
    expect((await approve('storyboard')).status).toBe(409);
    await store.updateProject(project.id, { lyricCues: [] });
    await save({ ...draft, storyboard: draft.storyboard.map(s => ({ ...s, lyricCueIds: [] })) });
    expect((await approve('storyboard')).status).toBe(409);
    await save({ ...draft, lyricsMode: 'instrumental', timingNotes: 'This synthetic master contains only instruments.', storyboard: draft.storyboard.map(s => ({ ...s, lyricCueIds: [] })) });
    expect((await approve('storyboard')).status).toBe(200);
  });

  it('invalidates musical choreography evidence when analysis or the applied timing map changes, not receipt metadata', async () => {
    const current = await store.getProject(project.id);
    await store.setProjectAnalysis(project.id, { ...current.audioAnalysis, features: {
      envelopes: { fps: 1, rms: [0.2, 0.8], low: [0.1, 0.7], mid: [0.2, 0.4], high: [0.1, 0.3] },
      onsets: { low: [1], mid: [2], high: [3] },
    } });
    await store.mutateProjectRecord(project.id, p => ({ project: { ...p, audioTimingRevisions: [{
      version: 1, basis: 'synthetic-timing-revision', appliedAt: '2026-01-01T00:00:00.000Z',
      input: { targetTrackId: 'synthetic-track', intervals: [{ oldStartSec: 0, oldEndSec: 20, newStartSec: 0 }] },
    }] } }));
    // Explicitly reconfirm the alignment after the analysis change.
    await save({ ...draft, timingStatus: 'provisional' });
    await save(draft);
    await approve('art'); await approve('storyboard');
    await request(app).post(`${base}/production-review/proof`).send({ startSec: 0, endSec: 20 });
    expect((await approve('proof', { proofReview: undefined })).body.code).toBe('MUSIC_VIDEO_PROOF_REVIEW_REQUIRED');
    const evidence = { watchedWithAudio: true, excerptId: 'older-proof', filename: 'synthetic-proof.mp4',
      energyComparison: 'Matches the chosen playful target.', timecodedNotes: '0:04 the subject reaches the doorway.' };
    expect((await approve('proof', { proofReview: evidence })).body.code).toBe('MUSIC_VIDEO_REVIEW_STALE');
    expect((await approve('proof', { proofReview: { ...evidence, timecodedNotes: 'Looks good' } })).status).toBe(400);
    expect((await approve('proof')).status).toBe(200);
    const accepted = await store.getProject(project.id);
    const acceptedStatus = (await read()).body.readiness;
    expect(acceptedStatus.readyForProduction).toBe(true);

    const changes = {
      onset: p => { p.audioAnalysis.features.onsets.low = [4]; },
      envelope: p => { p.audioAnalysis.features.envelopes.rms = [0.8, 0.2]; },
      downbeat: p => { p.audioAnalysis.downbeats = [1]; },
      timingMap: p => { p.audioTimingRevisions[0].input.intervals[0].newStartSec = 1; },
    };
    for (const [label, change] of Object.entries(changes)) {
      const revised = structuredClone(accepted);
      change(revised);
      await store.mutateProjectRecord(project.id, () => ({ project: revised }));
      const readiness = (await read()).body.readiness;
      expect(readiness.art.approved, label).toBe(true);
      expect(readiness.storyboard.problems.join(' '), label).toContain('Lyric alignment is provisional or changed');
      expect(readiness.basis.storyboard, label).not.toBe(acceptedStatus.basis.storyboard);
      expect(readiness.basis.proof, label).not.toBe(acceptedStatus.basis.proof);
      expect(readiness.readyForProduction, label).toBe(false);
      expect((await approve('proof')).status, label).toBe(409);
    }

    const metadataOnly = structuredClone(accepted);
    metadataOnly.name = 'Renamed example animation';
    metadataOnly.audioTimingRevisions[0].appliedAt = '2026-01-02T00:00:00.000Z';
    metadataOnly.audioAnalysis.waveform = [0.1, 0.3]; // Timeline display, not authored motion input.
    await store.mutateProjectRecord(project.id, () => ({ project: metadataOnly }));
    const retained = (await read()).body.readiness;
    expect(retained.basis).toEqual(acceptedStatus.basis);
    expect(retained.readyForProduction).toBe(true);
  });

  it('imports unbound planning without authorizing it, preserves source and binds only on explicit request', async () => {
    const source = JSON.stringify({ cast: [{ id: 'paper-figure' }], environments: [{ id: 'doorway' }],
      visualLanguage: { palette: ['indigo'] }, motionLanguage: { camera: 'dolly' }, productionAuthorized: true,
      storyboard: [{ id: 'shot-a', sceneId: null, startSec: 0, endSec: 20, action: 'Open doorway', staging: 'Foreground', camera: 'Dolly', transition: 'Match cut' }] });
    const imported = await request(app).post(`${base}/production-review/import`).send({ source });
    expect(imported.status).toBe(200);
    expect(imported.body.project.productionReview.approvals).toEqual({});
    expect(imported.body.project.productionReview.draft.storyboard[0].sceneId).toBeNull();
    expect(imported.body.project.productionReview.draft.timingStatus).toBe('provisional');
    const preserved = await request(app).get(`${base}/dev-artifacts/${imported.body.project.productionReview.draft.sourceArtifactId}/file`);
    expect(preserved.status).toBe(200);
    const bound = await request(app).post(`${base}/production-review/shots/shot-a/bind`).send({});
    expect(bound.status).toBe(200);
    expect(bound.body.project.productionReview.draft.storyboard[0].sceneId).toBeTruthy();
    expect((await request(app).post(`${base}/production-review/shots/shot-a/bind`).send({})).status).toBe(409);
    expect(bound.body.readiness.readyForProduction).toBe(false);
  });

  it('retains targeted feedback across revisions and imports without granting production approval', async () => {
    const comment = async (stage, decision, text) => {
      const status = await read();
      return request(app).post(`${base}/production-review/feedback`).send({ stage, decision, text,
        target: 'cast: example-figure / frame: 2.5s', basis: status.body.readiness.basis[stage] });
    };
    await comment('art', 'structure-accepted', 'The sheet structure works; the silhouette needs revision.');
    expect((await read()).body.readiness.art.approved).toBe(false);
    await approve('art'); await approve('storyboard');
    const feedback = await comment('proof', 'request-changes', 'Keep the figure behind the doorway during the camera move.');
    const entry = feedback.body.project.productionReview.feedback.at(-1);
    expect(feedback.body.readiness.art.approved).toBe(true);
    expect(feedback.body.readiness.storyboard.approved).toBe(true);
    expect(feedback.body.readiness.proof.problems.join(' ')).toContain('Keep the figure');
    await save({ ...draft, storyboard: draft.storyboard.map(shot => ({ ...shot, staging: 'Figure behind doorway' })) });
    const revised = await read();
    expect(revised.body.project.productionReview.reviewedRevisions[entry.basis].draft.storyboard[0].staging).toBe('Figure foreground, doorway behind');
    expect(revised.body.project.productionReview.feedback.at(-1).resolvedAt).toBeUndefined();
    expect(revised.body.readiness.art.approved).toBe(true);
    expect(revised.body.readiness.storyboard.approved).toBe(false);
    const resolution = { feedbackId: entry.id, resolution: 'Reviewed the revised staging.', password: 'synthetic-operator-password' };
    expect((await request(app).post(`${base}/production-review/feedback/resolve`).set('authorization', 'Bearer synthetic-agent').send(resolution)).status).toBe(403);
    expect((await request(app).post(`${base}/production-review/feedback/resolve`).send(resolution)).status).toBe(200);
    expect((await read()).body.readiness.readyForProduction).toBe(false);
    await request(app).post(`${base}/production-review/import`).send({ source: JSON.stringify({ cast: 'Another proposal', storyboard: [] }) });
    const imported = await read();
    expect(imported.body.project.productionReview.feedback).toHaveLength(2);
    expect(imported.body.project.productionReview.feedback.at(-1).resolution).toBe(resolution.resolution);
    expect(imported.body.project.productionReview.reviewedRevisions[entry.basis]).toBeTruthy();
  });

  it('never submits an external post, including forged approval and agent credentials', async () => {
    const result = await request(app).post(`${base}/publish/drafts/any-draft/submit`).set('authorization', 'Bearer synthetic-agent').send({ approved: true, password: 'synthetic-operator-password' });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('PUBLISH_MANUAL_REQUIRED');
    expect((await request(app).post(`${base}/publish/youtube/prepare`).send({ approved: true })).status).toBe(403);
  });
});
