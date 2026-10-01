/** Bounded production stages → PostgreSQL → managed files; synthetic renders, no provider. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { access, readFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';
vi.mock('../../lib/paths.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('code-animation-stages-') }));
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { createCodeAnimationPackage } from '../../lib/codeAnimationPackage.js';
import { PATHS } from '../../lib/paths.js';
import {
  createProductionProject, exportProductionPackage, getProductionHistory, getProductionProject, importProductionPackage,
  patchProductionProject,
} from './projects.js';
import { cancelProductionStageRun, startProductionStageRun } from './stages.js';

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('codeAnimation/stages.db.test', health.connected, health.error);
if (ready) await ensureSchema();
const ids = [];
afterAll(async () => {
  if (ready && ids.length) await query('DELETE FROM code_animation_projects WHERE id = ANY($1::text[])', [ids]);
  await close(); cleanupTempDataRoots('code-animation-stages-');
});

const manifest = (audio = { kind: 'silence' }) => ({
  title: 'Synthetic film', brief: { concept: 'A cube hops over a cone.', cast: '', onScreenText: '' },
  styleGuide: 'Graphic shapes', renderer: { kind: 'browser', version: 'synthetic-v1', engine: null },
  format: { width: 1280, height: 720, fps: 12, durationSeconds: 4 }, seed: 1,
  entrypoints: [{ role: 'preview', path: 'src/index.html' }], assets: [], shots: [], events: [],
  audio, execution: { requested: null, effective: null },
});
const pkg = (source, audio) => createCodeAnimationPackage(manifest(audio), [{ path: 'src/index.html', content: source }]);
const project = async (budgets = {}, audio) => {
  const created = await createProductionProject({ manifest: manifest(audio), budgets });
  ids.push(created.id);
  const { revision } = await importProductionPackage(created.id, pkg('<html><canvas></canvas>FROZEN</html>', audio));
  return { id: created.id, revision };
};

// A deterministic stand-in for the browser: a FROZEN source never changes, any
// other source differs at every time. It reads the staged copy the renderer would.
const sample = async (directory, { times, captureTimes = [], signal }) => {
  signal.throwIfAborted();
  const html = await readFile(join(PATHS.data, directory, 'index.html'), 'utf8');
  expect(html).toContain('portosComposition');
  const hash = t => createHash('sha256').update(html.includes('FROZEN') ? 'same' : `t${t}`).digest('hex');
  return {
    contract: { durationSec: 4, fps: 12, width: 1280, height: 720 },
    samples: times.map(t => ({ t, renderHash: hash(t), mean: 80, deviation: 20 })),
    frames: captureTimes.map(t => ({ t, bytes: Buffer.from(`png-${t}`) })),
  };
};
const unfreeze = vi.fn(async ({ files, entryPath }) => ({
  files: [{ path: entryPath, content: files.find(file => file.path === entryPath).content.replace('FROZEN', 'MOVING') }], tokens: 100,
}));
const render = vi.fn(async () => ({ jobId: 'media-job', id: 'video-1', filename: 'composition-media-job.mp4', path: '/data/videos/composition-media-job.mp4' }));
const exists = path => access(path).then(() => true, () => false);

describe.skipIf(!ready)('Production stage runs', () => {
  it('measures a real render, repairs it into a new immutable revision, and renders final only from passing evidence', async () => {
    const { id, revision } = await project();
    unfreeze.mockClear(); render.mockClear();
    const { run, done } = await startProductionStageRun(id, {}, { sample, repair: unfreeze, render });
    expect(run).toMatchObject({ status: 'running', sourceRevisionId: revision.id });
    expect(await done).toBe('completed');

    const [saved] = (await getProductionHistory(id, { limit: 5, offset: 0 })).items;
    expect(saved).toMatchObject({ id: run.id, status: 'completed' });
    const data = saved.data;
    expect(data.stages.map(stage => `${stage.key}:${stage.revisionId === revision.id ? 'v1' : 'v2'}`))
      .toEqual(['style-frame:v1', 'pilot:v1', 'inspect:v1', 'repair:v1', 'style-frame:v2', 'pilot:v2', 'inspect:v2', 'final:v2']);
    expect(new Set(data.stages.map(stage => stage.stageRunId)).size).toBe(data.stages.length);
    const [first, second] = data.stages.filter(stage => stage.key === 'inspect');
    expect(first.findings.some(finding => finding.kind === 'frozen-film' && finding.sourceHash === revision.sourceHash && finding.capturedAt)).toBe(true);
    expect(first.verdict.status).toBe('fail');
    expect(second.verdict.status).toBe('pass');
    expect(second.findings).toEqual([]);

    // The repair is a new candidate lineage entry; the original bytes and the accepted pointer are untouched.
    const current = await getProductionProject(id);
    expect(current.candidateRevisionId).toBe(data.currentRevisionId);
    expect(current.candidateRevisionId).not.toBe(revision.id);
    expect(current.acceptedRevisionId).toBeNull();
    expect((await exportProductionPackage(id, revision.id)).files[0].content).toContain('FROZEN');
    expect((await exportProductionPackage(id, current.candidateRevisionId)).files[0].content).toContain('MOVING');
    expect(data.repairs).toEqual([expect.objectContaining({ fromRevisionId: revision.id, revisionId: current.candidateRevisionId, findingKinds: ['frozen-film'] })]);

    // Render only after passing evidence, from this run's own copy of the repaired revision.
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0].directory).toContain(`/runs/${run.id}/render/${current.candidateRevisionId}`);
    expect(data.output).toMatchObject({ jobId: 'media-job', revisionId: current.candidateRevisionId, verifiedDimensions: expect.arrayContaining(['visual-motion', 'audio']) });
    expect(data.spent).toMatchObject({ iterations: 1, tokens: 100 });
    for (const artifact of data.stages.find(stage => stage.key === 'style-frame').artifacts) {
      expect(await exists(join(PATHS.data, artifact.relativePath))).toBe(true);
    }
  });

  it('records an opt-in visual review as advisory evidence and only then reports semantic-visual verified', async () => {
    const { id } = await project();
    const review = vi.fn(async ({ artifacts }) => ({ findings: [{ detail: 'Palette ignores the style guide.', atSeconds: 1 }], tokens: 10, reviewer: { providerId: 'example-provider', model: 'example-model' }, seen: artifacts.length }));
    const moving = vi.fn(async ({ files, entryPath }) => ({ files: [{ path: entryPath, content: files.find(file => file.path === entryPath).content.replace('FROZEN', 'MOVING') }], tokens: 1 }));
    const off = await startProductionStageRun(id, {}, { sample, repair: moving, render, review });
    expect(await off.done).toBe('completed');
    expect(review).not.toHaveBeenCalled();

    const second = await project();
    const on = await startProductionStageRun(second.id, { visualReview: true }, { sample, repair: moving, render, review });
    expect(await on.done).toBe('completed');
    expect(review).toHaveBeenCalled();
    const [saved] = (await getProductionHistory(second.id, { limit: 1, offset: 0 })).items;
    expect(saved.data.stages.find(stage => stage.key === 'review').reviewer).toEqual({ providerId: 'example-provider', model: 'example-model' });
    expect(saved.data.findings.some(finding => finding.kind === 'visual-review' && finding.severity === 'warning')).toBe(true);
    expect(saved.data.verdict.unverified.map(item => item.dimension)).not.toContain('semantic-visual');
  });

  it('cancels a pending visual review through its signal and resumes with the opt-in inherited', async () => {
    const { id } = await project();
    let reviewStarted;
    const started = new Promise(resolve => { reviewStarted = resolve; });
    let seen;
    const hanging = vi.fn(async ({ signal, timeoutMs }) => {
      seen = { timeoutMs };
      reviewStarted();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const first = await startProductionStageRun(id, { visualReview: true }, { sample, repair: unfreeze, render, review: hanging });
    await started;
    expect(seen.timeoutMs).toBeGreaterThan(0);
    cancelProductionStageRun(id, first.run.id);
    expect(await first.done).toBe('canceled');

    const review = vi.fn(async () => ({ findings: [], tokens: 1, reviewer: { providerId: 'example-provider', model: 'example-model' } }));
    const resumed = await startProductionStageRun(id, { resumeFromRunId: first.run.id }, { sample, repair: unfreeze, render, review });
    expect(await resumed.done).toBe('completed');
    expect(review).toHaveBeenCalled();
  });

  it('never passes unmeasured or unrepairable evidence: exhausted iterations keep artifacts, skip the render, and report audio as unverified', async () => {
    const { id } = await project({ iterations: 1 }, { kind: 'external', notes: 'Separate track' });
    render.mockClear();
    const stillFrozen = vi.fn(async ({ files, entryPath }) => ({
      files: [{ path: entryPath, content: `${files.find(file => file.path === entryPath).content}<!-- FROZEN again -->` }],
    }));
    const { done, run } = await startProductionStageRun(id, {}, { sample, repair: stillFrozen, render });
    expect(await done).toBe('exhausted');
    expect(render).not.toHaveBeenCalled();
    const [saved] = (await getProductionHistory(id, { limit: 1, offset: 0 })).items;
    expect(saved.data).toMatchObject({ stopReason: 'iterations', resumable: true, output: null, verdict: { status: 'fail' } });
    expect(saved.data.verdict.unverified.map(item => item.dimension)).toEqual(expect.arrayContaining(['audio', 'semantic-visual']));
    expect(saved.data.verdict.unverified.map(item => item.dimension)).not.toContain('visual-motion');
    expect(saved.id).toBe(run.id);
  });

  it('keeps one live run per project, cancels owned work, retains accepted artifacts, and resumes without re-measuring the style frame', async () => {
    const { id } = await project();
    let pilotStarted;
    const started = new Promise(resolve => { pilotStarted = resolve; });
    const blocking = vi.fn(async (directory, options) => {
      if (!options.times.length) return sample(directory, options);
      pilotStarted();
      await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    });
    const first = await startProductionStageRun(id, {}, { sample: blocking, repair: unfreeze, render });
    await started;
    await expect(startProductionStageRun(id, {}, { sample, repair: unfreeze, render })).rejects.toMatchObject({ code: 'CODE_ANIMATION_RUN_ACTIVE' });
    cancelProductionStageRun(id, first.run.id);
    expect(await first.done).toBe('canceled');

    const [canceled] = (await getProductionHistory(id, { limit: 1, offset: 0 })).items;
    expect(canceled).toMatchObject({ status: 'canceled', data: { resumable: true, stopReason: 'canceled' } });
    const style = canceled.data.stages.find(stage => stage.key === 'style-frame');
    expect(style.status).toBe('completed');
    expect(canceled.data.stages.find(stage => stage.key === 'pilot').status).toBe('canceled');
    expect(await exists(join(PATHS.data, style.artifacts[0].relativePath))).toBe(true);

    const counting = vi.fn(sample);
    render.mockClear();
    const resumed = await startProductionStageRun(id, { resumeFromRunId: first.run.id }, { sample: counting, repair: unfreeze, render });
    expect(await resumed.done).toBe('completed');
    // The first revision's style frame was reused (only its pilot re-ran); the repaired revision is measured in full.
    expect(counting.mock.calls.map(([, options]) => [options.times.length > 0, (options.captureTimes ?? []).length])).toEqual([[true, 0], [false, 3], [true, 0]]);
    const [after] = (await getProductionHistory(id, { limit: 1, offset: 0 })).items;
    expect(after.data.stages.find(stage => stage.key === 'style-frame')).toMatchObject({ reusedFrom: first.run.id });
    // The two runs wrote to separate directories; the canceled run's frames are still there.
    expect(await exists(join(PATHS.data, style.artifacts[0].relativePath))).toBe(true);
    expect(render.mock.calls[0][0].directory).toContain(`/runs/${resumed.run.id}/`);
  });

  it('stops on the disk budget and on the render budget, preserving what was accepted', async () => {
    const small = await project({ diskBytes: 1500 });
    const bigFrames = async (directory, options) => ({ ...(await sample(directory, options)), frames: options.captureTimes.map(t => ({ t, bytes: Buffer.alloc(800) })) });
    const diskRun = await startProductionStageRun(small.id, {}, { sample: bigFrames, repair: unfreeze, render });
    expect(await diskRun.done).toBe('exhausted');
    expect((await getProductionHistory(small.id, { limit: 1, offset: 0 })).items[0].data.stopReason).toBe('disk');

    const slow = await project({ renderSeconds: 1 });
    const hang = vi.fn(async (directory, options) => {
      if (!options.times.length) return sample(directory, options);
      await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    });
    const renderRun = await startProductionStageRun(slow.id, {}, { sample: hang, repair: unfreeze, render });
    expect(await renderRun.done).toBe('exhausted');
    const [saved] = (await getProductionHistory(slow.id, { limit: 1, offset: 0 })).items;
    expect(saved.data).toMatchObject({ stopReason: 'render', resumable: true });
    expect((await patchProductionProject(slow.id, { budgets: { renderSeconds: 60 } })).budgets.renderSeconds).toBe(60);
  }, 20000);

  it('marks a stranded run interrupted on restart and never calls a provider or render for it', async () => {
    const { id, revision } = await project();
    await query("INSERT INTO code_animation_project_runs (id, project_id, revision_id, status, data) VALUES ($1, $2, $3, 'running', $4)",
      ['00000000-0000-4000-8000-000000000001', id, revision.id, { kind: 'production-stages', currentRevisionId: revision.id, stages: [] }]);
    unfreeze.mockClear(); render.mockClear();
    const history = await getProductionHistory(id, { limit: 5, offset: 0 });
    expect(history.items.find(item => item.id === '00000000-0000-4000-8000-000000000001')).toMatchObject({ status: 'interrupted', data: { resumable: true } });
    expect(unfreeze).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });
});
