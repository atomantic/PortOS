/**
 * Music Video Cast & Sets check-in — the whole stage through the real router,
 * castAndSetsService.js and the real file-backed project store, with only the
 * provider call, the image queue and the mood-board store doubled: direction →
 * character sheet first → dependent images conditioned on it → the sheet saved
 * as a `cast-sets` development artifact → the check-in (review or auto) →
 * approval writing references and subjects → a regeneration re-rendering only
 * what a note touched.
 */

import { describe, it, expect, vi, beforeEach, afterAll, onTestFinished } from 'vitest';
import express from 'express';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-cast-sets-test-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('../../routes/musicVideo.js');
const projects = await import('./projects.js');
const service = await import('./castAndSetsService.js');
const production = await import('./production.js');
const { musicVideoEvents } = await import('./events.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

const IMAGES = () => join(ROOT(), 'images');
// 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const DIRECTION = {
  logline: 'A lighthouse keeper signals a ship only she can see.',
  interpretation: 'The lyrics read as a vigil kept for someone lost at sea.',
  protagonist: {
    name: 'Keeper', description: 'the voice of the song', face: 'weathered, dark eyes', hair: 'long grey braid',
    signature: 'a brass lantern', gesture: 'raising the lantern on "light the way"', rules: ['No hats'],
  },
  looks: [{ name: 'Watch', description: 'oilskin coat, wool sweater', chapters: 'verses' }, { name: 'Storm', description: 'soaked dark sweater', chapters: 'chorus' }],
  sets: [
    { id: 'lab', name: 'Lamp room', description: 'a glass lantern room atop the tower', lighting: 'warm amber', sections: ['Verse'] },
    { id: 'harbor', name: 'Harbor', description: 'a wet stone quay', lighting: 'sodium orange', sections: [0] },
    { id: 'roof', name: 'Cliff', description: 'a rainy cliff edge', lighting: 'cold blue', sections: ['Outro'] },
  ],
  songMap: [{ section: 0, setId: 'harbor' }, { section: 1, setId: 'lab' }, { section: 2, setId: 'roof' }],
  tests: [{ setId: 'lab', look: 'Storm', action: 'trimming the wick', caption: 'the long night' }, { setId: 'harbor', look: 'Watch', action: 'walking the quay', caption: 'opener' }],
  overlayConcept: { summary: 'A tide clock.', elements: [{ name: 'Clock', description: 'turns every chorus' }] },
  moodRefs: [1],
  questions: ['Is she right?'],
};

let jobs;
const queueJob = async ({ params }) => {
  const id = `job-${jobs.length + 1}`;
  jobs.push({ id, params });
  return { jobId: id };
};
const enqueue = vi.fn(queueJob);
let imageParamsOverrides;
const runPrompt = vi.fn();
const board = {
  id: 'mb-1',
  style: { prompt: 'wet skin, raw flash, green light' },
  items: [
    { type: 'image', file: 'board-a.jpg', caption: 'a steamy kitchen', analysis: { prompt: 'flash photo, brass and steam' } },
    { type: 'image', file: 'board-b.jpg', caption: 'neon portrait' },
    { type: 'text', text: 'note' },
  ],
};

const keyOf = (job) => job.params.musicVideo.castAndSets.key;
const current = async (id) => projects.getProject(id);

// Deadline-based, not an iteration count: each check reads from disk, so a slow
// runner (Windows CI) stretches an iteration far past its 5ms sleep and a fixed
// 200 passes can expire in about a second.
async function until(check, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Land every queued job whose key is in `keys` (all when omitted), as the image hook does. */
async function land(projectId, keys = null) {
  const pending = jobs.filter((j) => !j.landed && (!keys || keys.includes(keyOf(j))));
  for (const job of pending) {
    job.landed = true;
    const filename = `${job.id}.png`;
    writeFileSync(join(IMAGES(), filename), PNG);
    await service.onCastAndSetsImageSettled({ projectId, key: keyOf(job), revision: job.params.musicVideo.castAndSets.revision, jobId: job.id, filename, productionRunId: job.params.musicVideo.productionRunId, productionStepKey: job.params.musicVideo.productionStepKey });
  }
}

/** Land every image as it is queued until the stage reaches `status`. */
async function runTo(projectId, status) {
  let changes = 0;
  let wake;
  const changed = (event) => {
    if (event.projectId !== projectId) return;
    changes += 1;
    wake?.();
  };
  const cleanup = () => musicVideoEvents.off('cast-and-sets', changed);
  musicVideoEvents.on('cast-and-sets', changed);
  onTestFinished(cleanup);
  try {
    // Subscribe before reading so a persisted transition between the read and
    // the wait is retained. The test's existing timeout bounds a stuck stage.
    for (;;) {
      const observed = changes;
      await land(projectId);
      const stage = (await current(projectId)).castAndSets;
      if (stage?.status === status) return;
      if (stage?.status === 'failed') throw new Error(stage.stopReason || stage.error || 'The stage failed');
      if (changes !== observed) continue;
      await new Promise((resolve) => { wake = resolve; });
      wake = null;
    }
  } finally {
    cleanup();
  }
}

async function seed(overrides = {}) {
  return projects.createProject({
    name: 'Example Song',
    lyricCues: [{ text: 'light the way for me' }, { text: 'the tide is coming in' }],
    visualSpec: { moodBoardId: 'mb-1', references: [{ imageId: 'user-ref.png', role: 'mood', condition: true }] },
    concept: { prompt: 'an escape', subjects: [{ id: 's-band', kind: 'character', name: 'The Band' }] },
    ...overrides,
  }).then(async (p) => projects.setProjectAnalysis(p.id, {
    bpm: 120, beats: [], downbeats: [], durationSec: 30,
    sections: [{ label: 'Intro', startSec: 0, endSec: 8 }, { label: 'Verse', startSec: 8, endSec: 20 }, { label: 'Outro', startSec: 20, endSec: 30 }],
  }));
}

beforeEach(() => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  rmSync(join(ROOT(), 'music-video'), { recursive: true, force: true });
  mkdirSync(IMAGES(), { recursive: true });
  jobs = [];
  imageParamsOverrides = {};
  vi.clearAllMocks();
  runPrompt.mockResolvedValue({ text: `Here you go:\n\`\`\`json\n${JSON.stringify(DIRECTION)}\n\`\`\`` });
  service.__setCastAndSetsDepsForTests(testDeps());
});

const testDeps = (overrides = {}) => ({
  resolveProvider: async () => ({ provider: { id: 'example-provider', enabled: true }, selectedModel: 'example-model' }),
  runPrompt,
  getSettings: async () => ({}),
  enqueue,
  imageParams: async (_settings, route, common) => ({ mode: route.mode, ...common, ...imageParamsOverrides }),
  resolveRoute: async () => ({ mode: 'codex', model: null }),
  loadBoard: async () => board,
  boardItemImage: async () => (item) => (item.type === 'image' ? { kind: 'image', filename: item.file } : null),
  loadTrack: async () => null,
  ...overrides,
});
afterAll(cleanupTempDataRoots);

async function productionCheckin(limits, price = 0.25) {
  const project = await seed();
  const { run } = await projects.mutateProjectRecord(project.id, (current) => production.startProductionOnProject(current, {
    pool: [{ kind: 'image', mode: 'codex', model: null }],
    processId: 'example-process', limits: { maxReviewAttempts: 2, ...limits }, pricing: { 'image:codex:': price },
  }));
  await service.startCastAndSets(project.id, { productionRunId: run.id });
  return { project, run };
}

describe('Cast & Sets production accounting', () => {
  it.each([
    { maxGenerations: 2 },
    { maxGenerations: 20, spendCapUsd: 0.5 },
  ])('rejects the entire plan before queueing when its limit is insufficient: %j', async (limits) => {
    const { project } = await productionCheckin(limits);
    await until(async () => (await current(project.id)).productionRuns[0].status === 'limit-reached', 'the budget halt');
    const saved = await current(project.id);
    expect(jobs).toHaveLength(0);
    expect(saved.productionRuns[0].usage).toEqual({ generations: 0, spentUsd: 0 });
    expect(saved.productionRuns[0].steps).toHaveLength(0);
    expect(saved.castAndSets.status).toBe('failed');
  });

  it('charges every image once, links its job, and settles completion idempotently', async () => {
    const { project, run } = await productionCheckin({ maxGenerations: 20, spendCapUsd: 5 });
    await runTo(project.id, 'review');
    const saved = await current(project.id);
    const count = Object.keys(saved.castAndSets.plan).length;
    expect(jobs).toHaveLength(count);
    expect(saved.productionRuns[0].usage).toEqual({ generations: count, spentUsd: count * 0.25 });
    expect(saved.productionRuns[0].steps).toHaveLength(count);
    for (const job of jobs) {
      expect(job.params.musicVideo.productionRunId).toBe(run.id);
      expect(saved.productionRuns[0].steps.find((s) => s.key === job.params.musicVideo.productionStepKey))
        .toMatchObject({ status: 'completed', jobId: job.id, kind: 'checkin' });
    }
    const job = jobs[0];
    await service.onCastAndSetsImageSettled({
      projectId: project.id, key: keyOf(job), jobId: job.id, filename: job.id + '.png',
      productionRunId: run.id, productionStepKey: job.params.musicVideo.productionStepKey,
    });
    expect((await current(project.id)).productionRuns[0].usage).toEqual(saved.productionRuns[0].usage);
  });

  it('refunds a refused submission and charges a new attempt when resumed', async () => {
    enqueue.mockRejectedValueOnce(new Error('Example queue refusal'));
    const { project } = await productionCheckin({ maxGenerations: 20 });
    await until(async () => jobs.length === 3, 'the other initial images');
    const before = await current(project.id);
    const count = Object.keys(before.castAndSets.plan).length;
    expect(before.productionRuns[0].usage.generations).toBe(count - 1);
    expect(before.productionRuns[0].steps.find((s) => s.sceneId === 'character')).toMatchObject({ status: 'refused' });
    await land(project.id);
    await runTo(project.id, 'review');
    const after = await current(project.id);
    expect(after.productionRuns[0].usage.generations).toBe(count);
    expect(after.productionRuns[0].steps.filter((s) => s.sceneId === 'character').map((s) => s.status))
      .toEqual(['refused', 'completed']);
  });

  it('charges failed queued jobs and their retry, and refunds images skipped before submission', async () => {
    const { project, run } = await productionCheckin({ maxGenerations: 20 });
    await until(async () => jobs.length === 4, 'the initial images');
    const job = jobs.find((j) => keyOf(j) === 'character');
    job.landed = true;
    await service.onCastAndSetsImageSettled({
      projectId: project.id, key: keyOf(job), jobId: job.id, error: 'Example render failure',
      productionRunId: run.id, productionStepKey: job.params.musicVideo.productionStepKey,
    });
    await until(async () => jobs.length === 5, 'the retry');
    const saved = await current(project.id);
    const count = Object.keys(saved.castAndSets.plan).length;
    expect(saved.productionRuns[0].usage.generations).toBe(count + 1);
    await service.skipCastAndSets(project.id);
    const skipped = await current(project.id);
    expect(skipped.productionRuns[0].usage.generations).toBe(5);
    expect(skipped.productionRuns[0].steps.filter((s) => s.status === 'reserved')).toHaveLength(0);
  });
});

describe('Cast & Sets check-in', () => {
  it('directs, renders the character sheet first, builds the sheet, waits for review, and applies the approval', async () => {
    const project = await seed();
    const started = await request(app).post(`/api/music-video/${project.id}/cast-and-sets`).send({});
    expect(started.status).toBe(202);
    expect(started.body.stage).toMatchObject({ status: 'directing', revision: 1 });

    // The direction prompt interprets the song and treats the board as look only.
    await until(async () => jobs.length >= 4, 'the first images');
    const prompt = runPrompt.mock.calls[0][0].prompt;
    expect(prompt).toContain('light the way for me');
    expect(prompt).toMatch(/LOOK, LIGHTING, COLOR and TEXTURE only/);
    expect(prompt).toContain('0. a steamy kitchen — flash photo, brass and steam');
    expect(runPrompt.mock.calls[0][0].source).toBe('music-video-cast-sets');

    // First pass: the character sheet (conditioned on the mood image the
    // direction picked) and the empty plates, which depend on nothing.
    expect(jobs.map(keyOf).sort()).toEqual(['character', 'set:harbor', 'set:lab', 'set:roof']);
    const character = jobs.find((j) => keyOf(j) === 'character');
    expect(character.params.referenceImagePaths.map((p) => p.split(/[\\/]/).pop())).toEqual(['board-b.jpg']);
    expect(character.params).toMatchObject({ width: 1536, height: 1024, mode: 'codex', musicVideo: { projectId: project.id } });
    expect(character.params.prompt).toMatch(/FRONT, 3\/4, PROFILE, BACK/);

    await land(project.id, ['character']);
    await until(async () => jobs.some((j) => keyOf(j) === 'looks'), 'the looks sheet');
    const looks = jobs.find((j) => keyOf(j) === 'looks');
    expect(looks.params.referenceImagePaths.map((p) => p.split(/[\\/]/).pop())).toEqual([`${character.id}.png`]);
    expect(jobs.some((j) => keyOf(j).startsWith('test:'))).toBe(false);

    await land(project.id);
    await until(async () => jobs.filter((j) => keyOf(j).startsWith('test:')).length === 2, 'the in-set tests');
    const test1 = jobs.find((j) => keyOf(j) === 'test:1');
    const plateLab = jobs.find((j) => keyOf(j) === 'set:lab');
    expect(test1.params.referenceImagePaths.map((p) => p.split(/[\\/]/).pop())).toEqual([`${plateLab.id}.png`, `${character.id}.png`, `${looks.id}.png`]);

    await land(project.id);
    await until(async () => (await current(project.id)).castAndSets?.status === 'review', 'the check-in');
    const reviewing = await current(project.id);
    const artifact = reviewing.devArtifacts.find((a) => a.id === reviewing.castAndSets.artifactId);
    expect(artifact).toMatchObject({ kind: 'cast-sets', status: 'pending', version: 1 });
    const html = readFileSync(join(ROOT(), artifact.file), 'utf8');
    expect(html).toContain('Keeper');
    expect(html).toContain('data:image/png;base64,');
    // Nothing is applied before the director approves.
    expect(reviewing.visualSpec.references.map((r) => r.imageId)).toEqual(['user-ref.png']);

    // Approving the sheet from the artifact viewer is the stage's approval.
    const approved = await request(app).post(`/api/music-video/${project.id}/dev-artifacts/${artifact.id}/review`).send({ status: 'approved' });
    expect(approved.status).toBe(200);
    const done = await current(project.id);
    expect(done.castAndSets.status).toBe('approved');
    expect(done.devArtifacts[0].status).toBe('approved');
    const refs = done.visualSpec.references;
    expect(refs[0]).toMatchObject({ imageId: 'user-ref.png', condition: true });
    expect(refs.find((r) => r.id === 'mvr-cs-character')).toMatchObject({ role: 'character', condition: true });
    // Four conditioning slots: the director's own, the character sheet, then plates by song coverage.
    expect(refs.filter((r) => r.condition).map((r) => r.id)).toEqual([refs[0].id, 'mvr-cs-character', 'mvr-cs-set-lab', 'mvr-cs-set-roof']);
    expect(refs.find((r) => r.id === 'mvr-cs-set-harbor')).toMatchObject({ role: 'set', condition: false });
    expect(refs.find((r) => r.id === 'mvr-cs-looks')).toMatchObject({ role: 'wardrobe', condition: false });
    expect(done.concept.subjects.map((s) => [s.id, s.kind])).toEqual([
      ['s-band', 'character'], ['cs-protagonist', 'character'], ['cs-set-lab', 'place'], ['cs-set-harbor', 'place'], ['cs-set-roof', 'place'],
    ]);
  });

  it('regenerates only the images a note touches (and what depends on them) as a new sheet version', async () => {
    const project = await seed();
    await request(app).post(`/api/music-video/${project.id}/cast-and-sets`).send({});
    await runTo(project.id, 'review');
    const artifactId = (await current(project.id)).castAndSets.artifactId;
    await request(app).post(`/api/music-video/${project.id}/dev-artifacts/${artifactId}/notes`).send({ text: 'Make the braid shorter', target: 'character' });
    const before = jobs.length;

    const regen = await request(app).post(`/api/music-video/${project.id}/cast-and-sets/regenerate`).send({});
    expect(regen.status).toBe(202);
    await until(async () => jobs.length > before, 'the regenerated character');
    // No new direction call: the note names an image.
    expect(runPrompt).toHaveBeenCalledTimes(1);
    expect(jobs.slice(before).map(keyOf)).toEqual(['character']);
    expect(jobs.at(-1).params.prompt).toMatch(/Revision: Make the braid shorter/);
    await runTo(project.id, 'review');
    // Plates were not conditioned on the character, so they kept their images.
    expect(jobs.slice(before).map(keyOf).sort()).toEqual(['character', 'expressions', 'looks', 'test:1', 'test:2']);
    const after = await current(project.id);
    expect(after.castAndSets.revision).toBe(2);
    expect(after.devArtifacts[0]).toMatchObject({ version: 2, status: 'pending' });
    expect(after.devArtifacts[0].notes[0].resolvedAt).toBeTruthy();
    expect(after.castAndSets.images.character.history).toHaveLength(1);
  });

  it('approves itself in auto mode, and fails with a reason when no provider can direct', async () => {
    const auto = await seed({ automation: { tools: ['image:codex'], checkins: { castAndSets: 'auto' } } });
    await request(app).post(`/api/music-video/${auto.id}/cast-and-sets`).send({});
    await runTo(auto.id, 'approved');
    const approved = await current(auto.id);
    expect(approved.devArtifacts[0].status).toBe('approved');
    expect(approved.visualSpec.references.some((r) => r.id === 'mvr-cs-character')).toBe(true);

    service.__setCastAndSetsDepsForTests({ resolveProvider: async () => ({ provider: null }), loadBoard: async () => null, loadTrack: async () => null });
    const bare = await seed();
    await request(app).post(`/api/music-video/${bare.id}/cast-and-sets`).send({});
    await until(async () => (await current(bare.id)).castAndSets?.status === 'failed', 'the failure');
    expect((await current(bare.id)).castAndSets.stopReason).toMatch(/No AI provider/);
    // Skipping releases the autopilot without a sheet.
    const skipped = await request(app).post(`/api/music-video/${bare.id}/cast-and-sets/skip`).send({});
    expect(skipped.body.stage.status).toBe('skipped');
  });
});

it('directs on the resolved LLM route: the brief and request pins reach the resolver, effort reaches the run, and the route is recorded (#9545)', async () => {
  const route = { providerId: 'claude-tui', model: 'opus', effort: 'high', transport: 'tui', source: 'brief' };
  const resolveProvider = vi.fn(async () => ({ provider: { id: 'claude-tui', enabled: true }, selectedModel: 'opus', route }));
  service.__setCastAndSetsDepsForTests(testDeps({ resolveProvider }));
  const llm = { providerId: 'claude-tui', model: 'opus', effort: 'high' };
  const project = await seed({ automation: { tools: ['image:codex'], llm } });

  const started = await request(app).post(`/api/music-video/${project.id}/cast-and-sets`).send({ effort: 'low' });
  expect(started.status).toBe(202);
  await runTo(project.id, 'review');

  expect(resolveProvider).toHaveBeenCalledWith(expect.objectContaining({ effort: 'low', automation: expect.objectContaining({ llm }) }));
  expect(runPrompt).toHaveBeenCalledWith(expect.objectContaining({ source: 'music-video-cast-sets', model: 'opus', effort: 'high' }));
  expect((await current(project.id)).automation.routes.castAndSets).toMatchObject({ providerId: 'claude-tui', transport: 'tui', effort: 'high' });
});

it('uses project moodboard style images for Cast & Sets without a linked board', async () => {
  const project = await seed({ visualSpec: null, styleReferences: [{ imageId: 'style.png', caption: 'silver grain' }] });
  const snapshots = [];
  const onStage = (event) => { if (event.projectId === project.id) snapshots.push(event.project.castAndSets); };
  musicVideoEvents.on('cast-and-sets', onStage);
  onTestFinished(() => musicVideoEvents.off('cast-and-sets', onStage));
  await service.startCastAndSets(project.id);
  await runTo(project.id, 'review');
  expect(jobs[0].params.referenceImagePaths.some((p) => p.endsWith('style.png'))).toBe(true);
  expect(jobs[0].params.prompt).toContain('silver grain');
  const dependent = jobs.find((j) => j.params.referenceImagePaths?.length > 1);
  expect(dependent.params.referenceImagePaths.at(-1)).toMatch(/style.png$/);
  const firstDispatch = snapshots.find((stage) => Object.values(stage.images).filter((image) => image.jobId).length === 1);
  expect(firstDispatch.images.character).toMatchObject({
    status: 'queued', submittedPrompt: jobs[0].params.prompt, submittedPromptTruncated: false,
    submittedReferences: [{ kind: 'image', filename: 'style.png' }], submittedRevision: 1,
  });
  const saved = (await current(project.id)).castAndSets.images.character;
  expect(saved.submittedPrompt).toBe(jobs[0].params.prompt);
  expect(saved.submittedPrompt).toContain('silver grain');
});

it('bounds submitted diagnostics and records only references served from approved image roots', async () => {
  const { PATHS } = await import('../../lib/paths.js');
  imageParamsOverrides = {
    prompt: 'x'.repeat(20_010),
    referenceImagePaths: [join(ROOT(), 'private', 'unserved.png'), join(PATHS.imageRefs, 'uploaded.png'),
      ...Array.from({ length: 17 }, (_, i) => join(IMAGES(), `example-${i}.png`))],
  };
  const project = await seed({ visualSpec: null });
  await service.startCastAndSets(project.id);
  await runTo(project.id, 'review');
  const saved = (await current(project.id)).castAndSets.images.character;
  expect(saved.submittedPrompt).toHaveLength(20_000);
  expect(saved.submittedPromptTruncated).toBe(true);
  expect(saved.submittedReferences).toHaveLength(16);
  expect(saved.submittedReferences[0]).toEqual({ kind: 'image-ref', filename: 'uploaded.png' });
  expect(saved.submittedReferencesTruncated).toBe(true);
  expect(JSON.stringify(saved)).not.toContain(ROOT());
  expect(JSON.stringify(saved)).not.toContain('unserved.png');
});

it('ignores a previous revision completion while regeneration has reserved a key but has no job id yet', async () => {
  const project = await seed();
  await service.startCastAndSets(project.id);
  await runTo(project.id, 'review');
  const previous = jobs.find((job) => keyOf(job) === 'character');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  enqueue.mockImplementationOnce(async (job) => { await held; return queueJob(job); });
  onTestFinished(release);
  await service.regenerateCastAndSets(project.id, { notes: [{ target: 'character', text: 'Shorter braid' }] });
  await until(async () => (await current(project.id)).castAndSets.images.character.status === 'queued', 'the reserved regeneration');
  const before = (await current(project.id)).castAndSets;
  expect(before.images.character).toMatchObject({ status: 'queued', jobId: null, imageId: `${previous.id}.png` });
  expect(await service.onCastAndSetsImageSettled({
    projectId: project.id, key: 'character', revision: previous.params.musicVideo.castAndSets.revision,
    jobId: previous.id, filename: 'obsolete.png',
  })).toBe(false);
  expect((await current(project.id)).castAndSets).toEqual(before);
  release();
  await runTo(project.id, 'review');
  expect((await current(project.id)).castAndSets.images.character.imageId).not.toBe(`${previous.id}.png`);
});

describe('Cast & Sets procedural check-in', () => {
  const PROCEDURAL = {
    logline: 'A paper boat crosses a neon city.',
    interpretation: 'The song reads as a small thing carried by a big current.',
    protagonist: {
      name: 'Boat', description: 'a folded paper boat', construction: 'three triangles hinged at the keel', shapeLanguage: 'sharp, folded',
      materials: 'flat fills with a soft glow', palette: '#f5f0e6, #ff5a1f', expressions: ['proud: bow lifts'], movement: 'bobs on every beat',
    },
    world: { layout: 'a river through stacked streets', depth: 'three parallax planes', camera: 'slow dolly with a beat-synced push', transitions: 'wipe through reflections' },
    looks: [],
    sets: [
      { id: 'river', name: 'River', description: 'a neon river', lighting: 'magenta', imageRole: 'background', sections: [0] },
      { id: 'bridge', name: 'Bridge', description: 'an iron span', lighting: 'cyan', imageRole: 'decoration', sections: [1] },
      { id: 'quay', name: 'Quay', description: 'wet stone', lighting: 'amber', imageRole: 'texture', sections: [2] },
    ],
    songMap: [{ section: 0, setId: 'river' }, { section: 1, setId: 'bridge' }, { section: 2, setId: 'quay' }],
    overlayConcept: { summary: 'A tide clock.', elements: [] },
    moodRefs: [],
    questions: [],
  };
  const seedProcedural = (tools) => seed({
    productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
    automation: { tools, checkins: { castAndSets: 'review' } },
  });

  beforeEach(() => {
    runPrompt.mockResolvedValue({ text: JSON.stringify(PROCEDURAL) });
  });

  it('directs an image+code project with role-planned plates and no photographic batch, then carries the rules into the planner context', async () => {
    const project = await seedProcedural(['image:codex', 'code:render']);
    await service.startCastAndSets(project.id);
    await runTo(project.id, 'review');

    const prompt = runPrompt.mock.calls[0][0].prompt;
    expect(prompt).toContain('PROCEDURAL music video');
    // Only role-prompted set plates: no character, looks, expression or test photography.
    expect(jobs.map(keyOf).sort()).toEqual(['set:bridge', 'set:quay', 'set:river']);
    const byKey = Object.fromEntries(jobs.map((j) => [keyOf(j), j.params.prompt]));
    expect(byKey['set:river']).toMatch(/background plate/);
    expect(byKey['set:bridge']).toMatch(/isolated decorative element/);
    expect(byKey['set:quay']).toMatch(/Seamless tileable/);
    expect(Object.values(byKey).join(' ')).not.toMatch(/photoreal|person|FRONT/i);

    const reviewing = await current(project.id);
    expect(reviewing.castAndSets.direction).toMatchObject({ medium: 'procedural', world: { camera: 'slow dolly with a beat-synced push' } });
    const artifact = reviewing.devArtifacts.find((a) => a.id === reviewing.castAndSets.artifactId);
    const html = readFileSync(join(ROOT(), artifact.file), 'utf8');
    expect(html).toContain('three triangles hinged at the keel');
    expect(html).toContain('Role: decoration');
    expect(html).not.toContain('Character reference sheet');

    await service.approveCastAndSets(project.id);
    const done = await current(project.id);
    // Only the background plate conditions frame generation; texture and decoration stay loose references.
    expect(done.visualSpec.references.filter((r) => r.id.startsWith('mvr-cs-')).map((r) => [r.id, r.condition]).sort()).toEqual([
      ['mvr-cs-set-bridge', false], ['mvr-cs-set-quay', false], ['mvr-cs-set-river', true],
    ]);
    expect(done.concept.subjects.find((s) => s.id === 'cs-protagonist').description).toContain('three triangles hinged at the keel');

    // The approved motion, camera and construction reach the planner request.
    const { buildScenePlanPrompt } = await import('./planner.js');
    const planPrompt = buildScenePlanPrompt(done, [{ startSec: 0, endSec: 8, sectionIndex: 0, shotIndex: 0, shotCount: 1, sectionLabel: 'Intro', lyricText: '', delivery: [] }]);
    expect(planPrompt).toContain('slow dolly with a beat-synced push');
    expect(planPrompt).toContain('bobs on every beat');
    expect(planPrompt).toContain('image role: decoration');
  });

  it('directs a code-only project without any image backend and still waits for the director', async () => {
    const resolveRoute = vi.fn(async () => null);
    service.__setCastAndSetsDepsForTests({
      resolveProvider: async () => ({ provider: { id: 'example-provider', enabled: true }, selectedModel: 'example-model' }),
      runPrompt, getSettings: async () => ({}), enqueue, resolveRoute,
      loadBoard: async () => null, loadTrack: async () => null,
    });
    const project = await seed({ visualSpec: null, productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 }, automation: { tools: ['code:render'], checkins: { castAndSets: 'review' } } });
    await service.startCastAndSets(project.id);
    await until(async () => (await current(project.id)).castAndSets?.status === 'review', 'the code-only check-in');
    const stage = (await current(project.id)).castAndSets;
    expect(jobs).toEqual([]);
    expect(resolveRoute).not.toHaveBeenCalled();
    expect(stage.plan).toEqual({});
    expect(stage.direction.protagonist.construction).toBe('three triangles hinged at the keel');
    const html = readFileSync(join(ROOT(), (await current(project.id)).devArtifacts[0].file), 'utf8');
    expect(html).toContain('No raster image: drawn in code');
  });

  it('keeps the medium of a saved direction when the project settings change before a revision', async () => {
    const project = await seedProcedural(['image:codex', 'code:render']);
    await service.startCastAndSets(project.id);
    await runTo(project.id, 'review');
    await projects.mutateProjectRecord(project.id, (p) => ({ project: { ...p, productionPolicy: { strategy: 'legacy', maxGeneratedVideoPercent: 100 }, automation: { ...p.automation, tools: ['image:codex'] } } }));
    await service.regenerateCastAndSets(project.id, { notes: [{ text: 'make the camera slower' }] });
    await until(async () => runPrompt.mock.calls.length === 2, 'the revision call');
    expect(runPrompt.mock.calls[1][0].prompt).toContain('PROCEDURAL music video');
    await runTo(project.id, 'review');
    expect((await current(project.id)).castAndSets.direction.medium).toBe('procedural');
  });

  it('previews the reusable definitions on the sheet, saves the director\'s direction edits through a revision, and persists them', async () => {
    const definitions = { characters: [{
      id: 'boat', name: 'Paper boat', renderer: 'svg', palette: [{ name: 'cream', hex: '#f5f0e6' }],
      parts: [{ id: 'hull', shape: 'rect', x: 40, y: 100, width: 120, height: 40, fill: 'cream' }],
      expressions: [{ name: 'proud', overrides: { hull: { rotate: -4 } } }],
    }] };
    runPrompt.mockResolvedValue({ text: JSON.stringify({ ...PROCEDURAL, definitions }) });
    const project = await seedProcedural(['image:codex', 'code:render']);
    await service.startCastAndSets(project.id);
    await runTo(project.id, 'review');
    const reviewing = await current(project.id);
    const sheet = () => readFileSync(join(ROOT(), (reviewing.devArtifacts.find((a) => a.id === reviewing.castAndSets.artifactId)).file), 'utf8');
    expect(reviewing.castAndSets.direction.definitions.characters[0]).toMatchObject({ id: 'boat', parts: [{ id: 'hull', shape: 'rect' }] });
    expect(sheet()).toContain('Reusable code definitions');
    const landed = jobs.length;

    // Edit palette, camera and a plate's role. No direction (text) call; only the plate whose prompt changed re-renders.
    const edit = await request(app).patch(`/api/music-video/${project.id}/cast-and-sets/direction`).send({
      protagonist: { palette: '#112233, #ddeeff', expressions: ['calm: bow level'] },
      world: { camera: 'locked off, no push' },
      sets: [{ id: 'river', imageRole: 'texture' }],
    });
    expect(edit.status).toBe(202);
    expect(edit.body.stage.revision).toBe(2);
    await until(async () => jobs.length > landed, 'the re-rendered plate');
    await runTo(project.id, 'review');
    expect(runPrompt).toHaveBeenCalledTimes(1);
    expect(jobs.slice(landed).map(keyOf)).toEqual(['set:river']);

    // The edit survives a reload and reaches the planner request and the sheet.
    const after = await current(project.id);
    expect(after.castAndSets.direction).toMatchObject({
      protagonist: { palette: '#112233, #ddeeff', expressions: ['calm: bow level'], construction: 'three triangles hinged at the keel' },
      world: { camera: 'locked off, no push', layout: 'a river through stacked streets' },
      definitions,
    });
    expect(after.castAndSets.direction.sets.find((x) => x.id === 'river').imageRole).toBe('texture');
    expect(after.castAndSets.notesApplied[0].text).toMatch(/^Edited by the director: palette, expressions, world camera, River image role/);
    const { buildScenePlanPrompt } = await import('./planner.js');
    const planPrompt = buildScenePlanPrompt(after, [{ startSec: 0, endSec: 8, sectionIndex: 0, shotIndex: 0, shotCount: 1, sectionLabel: 'Intro', lyricText: '', delivery: [] }]);
    expect(planPrompt).toContain('locked off, no push');
    expect(planPrompt).toContain('#112233, #ddeeff');

    // Nothing changed / unknown set / not in review are refused, leaving the direction as saved.
    const same = await request(app).patch(`/api/music-video/${project.id}/cast-and-sets/direction`).send({ world: { camera: 'locked off, no push' } });
    expect(same.status).toBe(422);
    const unknown = await request(app).patch(`/api/music-video/${project.id}/cast-and-sets/direction`).send({ sets: [{ id: 'nowhere', imageRole: 'cutout' }] });
    expect(unknown.status).toBe(422);
    const invalid = await request(app).patch(`/api/music-video/${project.id}/cast-and-sets/direction`).send({ sets: [{ id: 'river', imageRole: 'wallpaper' }] });
    expect(invalid.status).toBe(400);
    await service.approveCastAndSets(project.id);
    const approved = await request(app).patch(`/api/music-video/${project.id}/cast-and-sets/direction`).send({ world: { camera: 'x' } });
    expect(approved.status).toBe(409);
    expect((await current(project.id)).castAndSets.direction.world.camera).toBe('locked off, no push');
    expect(sheet()).toContain('Reusable code definitions');
  });

  it('refuses to edit a photographic direction', async () => {
    runPrompt.mockResolvedValue({ text: JSON.stringify(DIRECTION) });
    const project = await seed();
    await service.startCastAndSets(project.id);
    await runTo(project.id, 'review');
    const res = await request(app).patch(`/api/music-video/${project.id}/cast-and-sets/direction`).send({ world: { camera: 'x' } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CAST_SETS_NOT_PROCEDURAL');
  });
});


it('carries unresolved targeted production feedback into regeneration without resolving the human decision', async () => {
  const project = await seed();
  await service.startCastAndSets(project.id);
  await runTo(project.id, 'review');
  await projects.mutateProjectRecord(project.id, current => ({ project: { ...current,
    productionReview: { feedback: [
      { id: 'feedback-open', stage: 'art', target: 'cast:keeper', text: 'Use a wider composition and a stronger silhouette', decision: 'request-changes' },
      { id: 'feedback-closed', stage: 'art', target: 'environment:harbor', text: 'Obsolete resolved direction', decision: 'comment', resolvedAt: '2026-01-01T00:00:00.000Z' },
    ] },
  } }));
  await service.regenerateCastAndSets(project.id);
  await runTo(project.id, 'review');
  expect(runPrompt).toHaveBeenCalledTimes(2);
  const prompt = runPrompt.mock.calls[1][0].prompt;
  expect(prompt).toContain('cast:keeper');
  expect(prompt).toContain('Use a wider composition and a stronger silhouette');
  expect(prompt).not.toContain('Obsolete resolved direction');
  const revised = await current(project.id);
  expect(revised.productionReview.feedback[0].resolvedAt).toBeUndefined();
});
