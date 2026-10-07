import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const author = vi.hoisted(() => ({ sections: [], calls: 0, prompts: [] }));
vi.mock('../services/promptRunner.js', () => ({
  assertProvider: () => {},
  resolveProviderAndModel: async () => ({ provider: { id: 'fixture-author', type: 'api', enabled: true }, selectedModel: 'fixture-model' }),
  runPromptThroughProvider: async ({ beforeExecute, prompt }) => {
    await beforeExecute?.({ provider: { id: 'fixture-author', type: 'api' }, model: 'fixture-model' });
    author.calls += 1;
    author.prompts.push(prompt);
    return { text: JSON.stringify({ sections: author.sections }) };
  },
}));

const prepareExternalDraft = vi.hoisted(() => vi.fn(async () => ({ draftId: 'synthetic-external-draft' })));
vi.mock('../services/musicVideo/publish/index.js', async original => ({ ...await original(), preparePublishDraft: prepareExternalDraft }));

const ROOT = () => lazyTempDataRoot('mv-production-review-');
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
const planner = vi.hoisted(() => vi.fn());
const shotReviser = vi.hoisted(() => vi.fn());
vi.mock('../services/musicVideo/planner.js', () => ({ planProject: planner, proposeShotRevisions: shotReviser }));
const auth = vi.hoisted(() => ({ enabled: true, authenticated: true }));
vi.mock('../services/auth.js', () => ({ isAuthEnabled: async () => auth.enabled, verifyPassword: async password => password === 'synthetic-operator-password',
  verifyRequestSessionIdentity: async req => auth.authenticated && req.headers.authorization !== 'Bearer expired'
    ? { kind: 'session', sessionId: req.headers.authorization ? 'shared-agent-session' : 'browser-session', label: req.headers.authorization ? 'agent' : null } : null }));
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
const { assertProductionApproval, approveProductionStage, productionReviewBasis } = await import('../services/musicVideo/productionReview.js');
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
    basis: status.body.readiness.basis[stage], ...extra });
}

beforeEach(async () => {
  auth.enabled = true; auth.authenticated = true;
  author.calls = 0; author.sections = []; author.prompts = [];
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
  it('drafts storyboard shots for planned scenes, taking camera and transition from the Cast & Sets world', async () => {
    await save({ ...draft, storyboard: [] });
    await store.mutateProjectRecord(project.id, current => ({ project: { ...current,
      castAndSets: { status: 'approved', direction: { world: { camera: 'Chase cam behind the plane', transitions: 'Warp streaks' } } } } }));
    expect((await approve('art')).status).toBe(200);
    const prepared = await request(app).post(`${base}/production-review/prepare`).send({});
    expect(prepared.status).toBe(200);
    expect(prepared.body.project.productionReview.draft.storyboard).toEqual([expect.objectContaining({
      lyricCueIds: ['line-a'], action: 'A paper figure opens a painted doorway.', camera: 'Chase cam behind the plane', transition: 'Warp streaks' })]);
  });

  it('ignores the world of a skipped Cast & Sets sheet when drafting storyboard shots', async () => {
    await save({ ...draft, storyboard: [] });
    await store.mutateProjectRecord(project.id, current => ({ project: { ...current,
      castAndSets: { status: 'skipped', direction: { world: { camera: 'Stale chase cam', transitions: 'Stale streaks' } } } } }));
    expect((await approve('art')).status).toBe(200);
    const prepared = await request(app).post(`${base}/production-review/prepare`).send({});
    expect(prepared.body.project.productionReview.draft.storyboard).toEqual([expect.objectContaining({ camera: '', transition: '' })]);
  });

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

  it('accepts authenticated browser and agent sessions, denies missing/expired/auth-off authority and stale revisions', async () => {
    const status = await read();
    const body = { stage: 'art', basis: status.body.readiness.basis.art };
    auth.authenticated = false;
    expect((await approve('art', { password: 'synthetic-operator-password' })).status).toBe(401);
    auth.authenticated = true;
    expect((await request(app).post(`${base}/production-review/approve`).set('authorization', 'Bearer expired').send(body)).status).toBe(401);
    auth.enabled = false;
    expect((await approve('art')).body.code).toBe('AUTH_REQUIRED');
    auth.enabled = true;
    expect((await approve('art')).status).toBe(200);
    expect((await request(app).post(`${base}/production-review/approve`).set('authorization', 'Bearer synthetic-agent').send(body)).status).toBe(200);
    const reviewed = await store.getProject(project.id);
    expect(reviewed.productionReview.approvalHistory.map(a => a.reviewer.sessionId)).toEqual(['browser-session', 'shared-agent-session']);
    expect(reviewed.productionReview.approvals.art.reviewer).toMatchObject({ kind: 'session', label: 'agent' });
    expect((await approve('art', { reviewer: { kind: 'human' } })).status).toBe(400);
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
    // Notes are optional: a review without them clears validation and fails only on the stale excerpt.
    expect((await approve('proof', { proofReview: { ...evidence, energyComparison: undefined, timecodedNotes: undefined } })).body.code).toBe('MUSIC_VIDEO_REVIEW_STALE');
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

  it('records substantive machine proof evidence without claiming human playback and refuses automatic waivers', async () => {
    await approve('art'); await approve('storyboard');
    await request(app).post(`${base}/production-review/proof`).send({ startSec: 0, endSec: 20 });
    const machine = { method: 'machine', watchedWithAudio: false, excerptId: 'proof-fixture', filename: 'synthetic-proof.mp4',
      energyComparison: 'The doorway expansion matches the rising chorus energy.', timecodedNotes: '0:04 doorway opens on the accent; 0:12 the second gesture grows.',
      machineEvidence: { visualReview: 'Continuous synthetic sequence review: the doorway expands and the figure travels without jumps.',
        audioReview: 'Synthetic master comparison: the doorway opening coincides with the chorus accent at 0:04.',
        limitations: 'Synthetic test observations; not a review of any user video.' } };
    expect((await approve('proof', { proofReview: { ...machine, machineEvidence: undefined } })).body.code).toBe('MUSIC_VIDEO_PROOF_REVIEW_REQUIRED');
    expect((await approve('proof', { proofReview: { ...machine, watchedWithAudio: true } })).status).toBe(409);
    expect((await approve('proof', { proofReview: { ...machine, filename: 'older.mp4' } })).body.code).toBe('MUSIC_VIDEO_REVIEW_STALE');
    const current = await store.getProject(project.id);
    expect(() => approveProductionStage(current, { stage: 'proof', basis: productionReviewBasis(current).proof,
      proofReview: { ...machine, autoApproved: true } })).toThrow(expect.objectContaining({ code: 'MUSIC_VIDEO_PROOF_REVIEW_REQUIRED' }));
    expect((await request(app).post(`${base}/production-review/approve`).set('authorization', 'Bearer synthetic-agent')
      .send({ stage: 'proof', basis: productionReviewBasis(current).proof, proofReview: machine })).status).toBe(200);
    const accepted = await store.getProject(project.id);
    expect(accepted.productionReview.approvals.proof).toMatchObject({ reviewer: { sessionId: 'shared-agent-session', label: 'agent' }, proofReview: machine });
    expect(() => assertProductionApproval(accepted)).not.toThrow();
    const legacy = structuredClone(accepted);
    legacy.productionReview.approvals.proof.proofReview = { ...machine, autoApproved: true, machineEvidence: undefined };
    expect(() => assertProductionApproval(legacy)).toThrow(expect.objectContaining({ code: 'MUSIC_VIDEO_APPROVAL_REQUIRED' }));
    expect(legacy.productionReview.approvals.art).toEqual(accepted.productionReview.approvals.art);
  });

  it('keeps changed word timings stale across draft saves and reverifies only the authenticated current basis', async () => {
    await approve('art');
    const prior = await read();
    expect(prior.body.readiness.alignment.status).toBe('verified');
    await store.updateProject(project.id, { lyricCues: [{ id: 'line-a', text: 'Example chorus', startSec: 1, endSec: 3,
      words: [{ w: 'Example', startSec: 1, endSec: 1.5, conf: 'matched' }, { w: 'chorus', startSec: 1.5, endSec: 3, conf: 'matched' }] }] });
    const saved = await save({ ...draft, timingNotes: 'Checked the updated fixture word onsets.', implementationPlan: 'Keep the existing renderer.' });
    expect(saved.body.readiness.alignment.status).toBe('stale');
    expect(saved.body.readiness.storyboard.problems.join(' ')).toContain('Lyric alignment is provisional or changed');
    const reverify = (basis = saved.body.readiness.alignment.basis, notes = saved.body.project.productionReview.draft.timingNotes) =>
      request(app).post(`${base}/production-review/alignment`).set('authorization', 'Bearer synthetic-agent').send({ basis, notes });
    auth.authenticated = false;
    expect((await reverify()).status).toBe(401);
    auth.authenticated = true; auth.enabled = false;
    expect((await reverify()).status).toBe(401);
    auth.enabled = true;
    expect((await request(app).post(`${base}/production-review/alignment`).set('authorization', 'Bearer expired')
      .send({ basis: saved.body.readiness.alignment.basis, notes: draft.timingNotes })).status).toBe(401);
    expect((await reverify(prior.body.readiness.alignment.basis)).body.code).toBe('MUSIC_VIDEO_REVIEW_STALE');
    expect((await read()).body.readiness.alignment.status).toBe('stale');
    const reviewed = await reverify();
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.readiness.alignment.status).toBe('verified');
    expect(reviewed.body.readiness.storyboard.approved).toBe(false);
    expect(reviewed.body.project.productionReview.draft.timingNotes).toBe('Checked the updated fixture word onsets.');
    expect(reviewed.body.project.productionReview.alignmentReview.reviewer).toMatchObject({ kind: 'session', sessionId: 'shared-agent-session' });
    expect((await approve('art')).status).toBe(200);
    expect((await approve('storyboard')).status).toBe(200);
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
    // Notes are optional: a review without them clears validation and fails only on the stale excerpt.
    expect((await approve('proof', { proofReview: { ...evidence, energyComparison: undefined, timecodedNotes: undefined } })).body.code).toBe('MUSIC_VIDEO_REVIEW_STALE');
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
    const resolution = { feedbackId: entry.id, resolution: 'Reviewed the revised staging.' };
    expect((await request(app).post(`${base}/production-review/feedback/resolve`).set('authorization', 'Bearer expired').send(resolution)).status).toBe(401);
    expect((await request(app).post(`${base}/production-review/feedback/resolve`).send(resolution)).status).toBe(200);
    expect((await read()).body.readiness.readyForProduction).toBe(false);
    await request(app).post(`${base}/production-review/import`).send({ source: JSON.stringify({ cast: 'Another proposal', storyboard: [] }) });
    const imported = await read();
    expect(imported.body.project.productionReview.feedback).toHaveLength(2);
    expect(imported.body.project.productionReview.feedback.at(-1).resolution).toBe(resolution.resolution);
    expect(imported.body.project.productionReview.reviewedRevisions[entry.basis]).toBeTruthy();
  });

  it('exposes no submit route for an external post, including forged approval and agent credentials', async () => {
    const result = await request(app).post(`${base}/publish/drafts/any-draft/submit`).set('authorization', 'Bearer synthetic-agent').send({ approved: true, password: 'synthetic-operator-password' });
    expect(result.status).toBe(404);
    auth.authenticated = false;
    expect((await request(app).post(`${base}/publish/youtube/prepare`).send({})).status).toBe(401);
    auth.authenticated = true;
    expect((await request(app).post(`${base}/publish/youtube/prepare`).set('authorization', 'Bearer synthetic-agent').send({})).status).toBe(200);
    expect(prepareExternalDraft).toHaveBeenCalledWith(project.id, 'youtube', expect.any(Object));
    // The "post again" confirmation reaches the service; a non-boolean is refused.
    expect((await request(app).post(`${base}/publish/youtube/prepare`).set('authorization', 'Bearer synthetic-agent').send({ again: true })).status).toBe(200);
    expect(prepareExternalDraft).toHaveBeenLastCalledWith(project.id, 'youtube', { again: true });
    expect((await request(app).post(`${base}/publish/youtube/prepare`).set('authorization', 'Bearer synthetic-agent').send({ again: 'yes' })).status).toBe(400);
  });
});

describe('document-bound storyboard revision', () => {
  it('preserves a document manifest imported while Board preparation is in flight', async () => {
    const { importDocumentTemplate } = await import('../services/musicVideo/compositionDocument.js');
    const imported = await importDocumentTemplate(project.id, 'layered');
    await store.mutateProjectRecord(project.id, current => ({ project: { ...current, scenes: [] } }));
    await approve('art');
    const entered = Promise.withResolvers();
    const held = Promise.withResolvers();
    planner.mockImplementationOnce(async () => {
      await store.addProjectScene(project.id, { label: 'Board row', startSec: 0, endSec: 20 });
      entered.resolve(); await held.promise;
    });
    const preparing = Promise.resolve(request(app).post(`${base}/production-review/prepare`).send({}));
    await entered.promise;
    const shots = [{ id: 'authored-shot', sceneId: null, startSec: 0, endSec: 20, lyricCueIds: ['line-a'],
      action: 'Open door', staging: 'Left', camera: 'Track', transition: 'Cut' }];
    const audioBasis = (await read()).body.readiness.documentShotImport.audioBasis;
    expect((await request(app).post(`${base}/production-review/document-shots`).send({
      documentDirectory: imported.document.directory, audioBasis, sourceFile: 'engine.js', shots,
    })).status).toBe(200);
    held.resolve();
    expect((await preparing).body.project.productionReview.draft.storyboard).toEqual(shots);
  });
  it('requires real source shots, preserves Board rows, and invalidates document, shot and master changes', async () => {
    const { importDocumentTemplate } = await import('../services/musicVideo/compositionDocument.js');
    const imported = await importDocumentTemplate(project.id, 'layered');
    const documentDirectory = imported.document.directory;
    const shots = [
      { id: 'authored-intro', sceneId: null, startSec: 0, endSec: 10, lyricCueIds: ['line-a'], action: 'Open doorway', staging: 'Figure left', camera: 'Dolly', transition: 'Cut' },
      { id: 'authored-outro', sceneId: null, startSec: 10, endSec: 20, lyricCueIds: [], action: 'Cross doorway', staging: 'Figure center', camera: 'Track', transition: 'Fade' },
    ];
    const audioBasis = (await read()).body.readiness.documentShotImport.audioBasis;
    const bind = body => request(app).post(`${base}/production-review/document-shots`).send({ audioBasis, ...body });
    await save({ ...draft, storyboardSource: 'document', storyboard: [] });
    await approve('art');
    expect((await approve('storyboard')).status).toBe(409);
    expect((await bind({ documentDirectory, sourceFile: 'missing.js', shots })).status).toBe(404);
    expect((await bind({ documentDirectory, sourceFile: 'engine.js', shots: [shots[0], shots[0]] })).status).toBe(400);
    const bound = await bind({ documentDirectory, sourceFile: 'engine.js', shots });
    expect(bound.status).toBe(200);
    expect(bound.body.project.scenes).toHaveLength(1);
    expect(bound.body.project.productionReview.draft.storyboard).toHaveLength(2);
    const prepared = await request(app).post(`${base}/production-review/prepare`).send({});
    expect(prepared.body.project.productionReview.draft.storyboard).toEqual(shots);
    expect((await request(app).post(`${base}/production-review/shots/authored-intro/bind`).send({})).status).toBe(409);
    expect((await approve('storyboard')).status).toBe(200);
    const accepted = await read();
    const oldBasis = accepted.body.readiness.basis.storyboard;
    await save({ ...bound.body.project.productionReview.draft, storyboard: shots.map((s, i) => i ? s : { ...s, camera: 'New track' }) });
    expect((await approve('storyboard')).status).toBe(409);
    await bind({ documentDirectory, sourceFile: 'engine.js', shots });
    expect((await approve('storyboard')).status).toBe(200);
    await importDocumentTemplate(project.id, 'layered');
    expect((await approve('storyboard')).status).toBe(409);
    expect((await bind({ documentDirectory, sourceFile: 'engine.js', shots })).status).toBe(409);
    const latest = await store.getProject(project.id);
    await bind({ documentDirectory: latest.composition.document.directory, sourceFile: 'engine.js', shots });
    await store.updateProject(project.id, { uploadedAudioFilename: 'new-master.wav' });
    expect((await approve('storyboard', { basis: oldBasis })).status).toBe(409);
    expect((await bind({ documentDirectory: latest.composition.document.directory, sourceFile: 'engine.js', shots })).status).toBe(409);
    expect((await read()).body.readiness.storyboard.problems.join(' ')).toContain('current authored document');
    expect((await request(app).post(`${base}/render`).send({})).status).toBe(409);
  });
});

describe('revising from review feedback', () => {
  const revise = stage => request(app).post(`${base}/production-review/revise`).send({ stage });
  const requestChanges = async (stage, target, text, decision = 'request-changes') => {
    const status = await read();
    return request(app).post(`${base}/production-review/feedback`).send({ stage, target, text, decision, basis: status.body.readiness.basis[stage] });
  };

  it('re-plans the named storyboard shots in place on a new basis and keeps the request open', async () => {
    expect((await revise('storyboard')).body.code).toBe('MUSIC_VIDEO_NO_FEEDBACK');
    expect((await requestChanges('storyboard', 'shot: Chorus', 'Open the doorway on the downbeat, not before')).status).toBe(200);
    const before = await read();
    const [scene] = before.body.project.scenes;
    shotReviser.mockImplementationOnce(async (_project, requests) => {
      expect(requests.map(r => r.text)).toEqual(['Open the doorway on the downbeat, not before']);
      return new Map([[scene.sceneId, { framePrompt: 'Figure waits at the closed doorway', prompt: 'Doorway swings open on the first downbeat' }]]);
    });

    const revised = await revise('storyboard');

    expect(revised.status).toBe(200);
    expect(revised.body.revision).toMatchObject({ stage: 'storyboard', sceneIds: [scene.sceneId] });
    const after = revised.body.project;
    expect(after.scenes[0]).toMatchObject({ sceneId: scene.sceneId, prompt: 'Doorway swings open on the first downbeat', framePrompt: 'Figure waits at the closed doorway' });
    expect(after.productionReview.draft.storyboard[0]).toMatchObject({ action: 'Doorway swings open on the first downbeat',
      staging: 'Figure waits at the closed doorway', camera: 'Dolly through doorway', transition: 'Match doorway to next frame' });
    expect(revised.body.readiness.basis.storyboard).not.toBe(before.body.readiness.basis.storyboard);
    expect(after.productionReview.feedback[0].resolvedAt).toBeUndefined();
    expect(revised.body.readiness.storyboard.problems).toContain('Resolve storyboard feedback for shot: Chorus: Open the doorway on the downbeat, not before');
  });

  it('authors a revised document candidate with storyboard and proof feedback in its prompt', async () => {
    await store.updateProject(project.id, { mediaMode: 'code-only', composition: { mode: 'document', authoringRenderer: 'canvas' },
      productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } });
    expect((await approve('art')).status).toBe(200);
    expect((await request(app).post(`${base}/production-review/prepare`).send({})).status).toBe(200);
    expect((await approve('storyboard')).status).toBe(200);
    expect((await requestChanges('storyboard', 'shot: Chorus', 'Keep the doorway silhouette readable', 'comment')).status).toBe(200);
    expect((await requestChanges('proof', 'frame: 0:04', 'The prop lands a beat late')).status).toBe(200);
    const { buildCodeTimeline } = await import('../services/musicVideo/codeTimeline.js');
    author.sections = buildCodeTimeline(await store.getProject(project.id)).sections.map(section => ({ id: section.id,
      source: "function render(ctx, env) { ctx.fillStyle = '#203040'; ctx.fillRect(0, 0, env.width, env.height); }" }));

    const revised = await revise('proof');

    expect(revised.status).toBe(200);
    expect(author.calls).toBe(1);
    expect(author.prompts[0]).toContain('UNRESOLVED REVIEW FEEDBACK');
    expect(author.prompts[0]).toContain('proof / frame: 0:04 / request-changes: The prop lands a beat late');
    expect(author.prompts[0]).toContain('storyboard / shot: Chorus / comment: Keep the doorway silhouette readable');
    expect(revised.body.project.composition.documentDraft.source.kind).toBe('generated');
    expect(revised.body.project.productionReview.feedback.every(item => !item.resolvedAt)).toBe(true);
  });

  it('explains instead of revising a footage-assembled proof', async () => {
    await store.updateProject(project.id, { composition: { mode: 'composed' } });
    expect((await requestChanges('proof', 'frame: 0:04', 'The prop lands a beat late')).status).toBe(200);
    const refused = await revise('proof');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('MUSIC_VIDEO_REVISION_UNSUPPORTED');
    expect(author.calls).toBe(0);
  });
});

describe('reverting a changed input to its approved value (#10241)', () => {
  const revert = body => request(app).post(`${base}/production-review/revert`).send(body);

  it('restores the concept and a scene prompt, making the approvals current again without re-approval', async () => {
    await store.updateProject(project.id, { concept: { prompt: 'Approved idea' } });
    expect((await approve('art')).status).toBe(200);
    expect((await approve('storyboard')).status).toBe(200);
    const sceneId = (await store.getProject(project.id)).scenes[0].sceneId;
    await store.updateProject(project.id, { concept: { prompt: 'Drifted idea' } });
    await store.mutateProjectRecord(project.id, current => ({ project: { ...current,
      scenes: current.scenes.map(s => ({ ...s, prompt: 'A different prompt' })) } }));
    const stale = (await read()).body.readiness;
    expect(stale.art.approved).toBe(false);
    expect(stale.storyboard.stale).toMatchObject({ changedFields: ['concept', 'scene 1 prompt'], revertible: ['concept', 'scene 1 prompt'] });

    expect((await revert({ stage: 'storyboard', field: 'scene 1 prompt' })).status).toBe(200);
    const done = await revert({ stage: 'art', field: 'concept' });
    expect(done.status).toBe(200);
    expect(done.body.project.concept).toEqual({ prompt: 'Approved idea' });
    expect(done.body.project.scenes.find(s => s.sceneId === sceneId).prompt).toBe('A paper figure opens a painted doorway.');
    expect(done.body.readiness.art.approved).toBe(true);
    expect(done.body.readiness.storyboard.approved).toBe(true);
  });

  it('refuses with 409 when there is no stored value, nothing changed, or the field is invalid', async () => {
    expect((await approve('art')).status).toBe(200);
    expect((await revert({ stage: 'art', field: 'concept' })).body.code).toBe('MUSIC_VIDEO_REVERT_UNAVAILABLE');
    await store.updateProject(project.id, { concept: { prompt: 'Drifted idea' } });
    const noSnapshot = await store.mutateProjectRecord(project.id, current => ({ project: { ...current, productionReview: { ...current.productionReview,
      approvals: { art: { ...current.productionReview.approvals.art, values: undefined } } } } }));
    expect(noSnapshot.project.productionReview.approvals.art.values).toBeUndefined();
    const legacy = await revert({ stage: 'art', field: 'concept' });
    expect(legacy.status).toBe(409);
    expect(legacy.body.code).toBe('MUSIC_VIDEO_REVERT_UNAVAILABLE');
    expect((await store.getProject(project.id)).concept).toEqual({ prompt: 'Drifted idea' });
    expect((await revert({ stage: 'art', field: '' })).status).toBe(400);
    expect((await revert({ stage: 'takes', field: 'concept' })).status).toBe(400);
  });

  it('keeps no value for an input over the 8 KB cap', async () => {
    const big = 'x'.repeat(9000);
    await store.updateProject(project.id, { concept: { prompt: big } });
    expect((await approve('art')).status).toBe(200);
    expect((await store.getProject(project.id)).productionReview.approvals.art.values).not.toHaveProperty('concept');
  });
});
