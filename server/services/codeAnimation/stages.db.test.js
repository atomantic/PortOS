/** Bounded production stages → PostgreSQL → managed files; synthetic renders, no provider. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { access, readFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';
vi.mock('../../lib/paths.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('code-animation-stages-') }));
// Inject faults only into render-source writes/removal; revision storage stays real.
const stagingFaults = vi.hoisted(() => ({ write: false, cleanup: false, afterReserve: null }));
vi.mock('fs/promises', async importOriginal => {
  const real = await importOriginal();
  return {
    ...real,
    open: async (path, flags, ...rest) => {
      const handle = await real.open(path, flags, ...rest);
      if (!stagingFaults.write || !String(path).replaceAll('\\', '/').includes('/render/')) return handle;
      stagingFaults.write = false;
      return {
        writeFile: async bytes => {
          await handle.writeFile(bytes);
          throw Object.assign(new Error('Synthetic staging write failure'), { code: 'ENOSPC' });
        },
        sync: () => handle.sync(), close: () => handle.close(),
      };
    },
    rm: async (path, ...rest) => {
      if (stagingFaults.cleanup && String(path).replaceAll('\\', '/').includes('/render/')) {
        stagingFaults.cleanup = false;
        throw Object.assign(new Error('Synthetic cleanup refusal'), { code: 'EACCES' });
      }
      return real.rm(path, ...rest);
    },
  };
});
vi.mock('./projectStore.js', async importOriginal => {
  const real = await importOriginal();
  return {
    ...real,
    reserveRunBytes: async (...args) => {
      const reserved = await real.reserveRunBytes(...args);
      stagingFaults.afterReserve?.();
      return reserved;
    },
  };
});
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
// Default adapters and real preflight, with only external provider boundaries doubled.
vi.mock('../providers.js', () => {
  const provider = { id: 'example-provider', type: 'api', enabled: true, models: ['example-model'], defaultModel: 'example-model' };
  return { getProviderById: vi.fn(async () => provider), getSelectableProviders: vi.fn(async () => ({ providers: [provider] })) };
});
vi.mock('../promptRunner.js', () => ({
  runPromptThroughProvider: vi.fn(), resolveEffectiveModel: (provider, model) => model || provider.defaultModel,
}));
vi.mock('../runner.js', () => ({ stopRun: vi.fn() }));
import { runPromptThroughProvider } from '../promptRunner.js';
import { stopRun } from '../runner.js';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { createCodeAnimationPackage } from '../../lib/codeAnimationPackage.js';
import { PATHS } from '../../lib/paths.js';
import {
  acceptProductionSource, createProductionProject, exportProductionPackage, getProductionHistory, getProductionProject, importProductionPackage,
  patchProductionProject,
} from './projects.js';
import { activeStageRunIds, cancelProductionStageRun, startProductionStageRun } from './stages.js';

const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('codeAnimation/stages.db.test', health.connected, health.error);
if (ready) await ensureSchema();
const ids = [];
afterEach(() => { vi.useRealTimers(); stopRun.mockReset(); runPromptThroughProvider.mockReset(); stagingFaults.afterReserve = null; });
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
  const created = await createProductionProject({ manifest: manifest(audio), budgets, localSettings: { providerId: 'example-provider', model: 'example-model' } });
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
  // These pin the real default repair adapter at its provider boundary: a
  // canceled/deadline response must not create a candidate or reserve bytes.
  it.each(['cancel', 'late-ack', 'deadline', 'failed-stop'])('stops default repair without publishing a late result (%s)', async mode => {
    const { id, revision } = await project({ timeSeconds: 60 });
    await acceptProductionSource(id, revision.id);
    const started = Promise.withResolvers();
    const response = Promise.withResolvers();
    const stopped = Promise.withResolvers();
    let providerArgs;
    runPromptThroughProvider.mockClear();
    runPromptThroughProvider.mockImplementation(async args => {
      providerArgs = args;
      if (mode !== 'late-ack') {
        args.onRunCreated('owned-repair');
        await args.beforeExecute();
      }
      started.resolve();
      const result = await response.promise;
      args.onRunSettled('owned-repair');
      return result;
    });
    stopRun.mockImplementation(async runId => {
      stopped.resolve(runId);
      if (mode === 'failed-stop') throw new Error('Synthetic stop failure');
      response.resolve({ text: '```html\n<html>MOVING</html>\n```' });
    });
    if (mode === 'deadline') vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const first = await startProductionStageRun(id, {}, { sample, render });
    await started.promise;
    const before = (await getProductionHistory(id, { limit: 1, offset: 0 })).items[0];
    expect(providerArgs).toMatchObject({
      source: 'code-animation-repair', timeout: expect.any(Number), absoluteTimeoutMs: providerArgs.timeout,
      onRunCreated: expect.any(Function), onRunSettled: expect.any(Function), beforeExecute: expect.any(Function),
    });
    expect(providerArgs.timeout).toBeGreaterThan(0);
    expect(providerArgs.timeout).toBeLessThanOrEqual(60000);
    if (mode === 'deadline') await vi.advanceTimersByTimeAsync(60000);
    else cancelProductionStageRun(id, first.run.id);
    if (mode === 'late-ack') {
      expect(stopRun).not.toHaveBeenCalled();
      providerArgs.onRunCreated('owned-repair');
      expect(() => providerArgs.beforeExecute()).toThrow();
    }
    expect(await stopped.promise).toBe('owned-repair');
    if (mode === 'failed-stop') response.resolve({ text: '```html\n<html>MOVING</html>\n```' });
    expect(await first.done).toBe(mode === 'deadline' ? 'exhausted' : 'canceled');
    vi.useRealTimers();
    expect(activeStageRunIds()).not.toContain(first.run.id);
    expect(stopRun).toHaveBeenCalledTimes(1);
    const saved = (await getProductionHistory(id, { limit: 1, offset: 0 })).items[0];
    expect(saved.data).toMatchObject({
      resumable: true, stopReason: mode === 'deadline' ? 'time' : 'canceled',
      repairs: [], output: null, currentRevisionId: revision.id, reservedBytes: before.data.reservedBytes,
      spent: { tokens: 0, iterations: 0, diskBytes: before.data.spent.diskBytes },
    });
    expect(saved.data.stages.find(stage => stage.key === 'repair').status).toBe(mode === 'deadline' ? 'exhausted' : 'canceled');
    expect(await getProductionProject(id)).toMatchObject({ candidateRevisionId: null, acceptedRevisionId: revision.id });
    expect((await exportProductionPackage(id, revision.id)).files[0].content).toContain('FROZEN');
    // A stopped repair releases the project's live slot for another run.
    const retry = await startProductionStageRun(id, {}, { sample, repair: unfreeze, render });
    expect(await retry.done).toBe('completed');
  });

  it.each([false, true])('publishes a normal default repair with route substitution allowed=%s', async allowFallback => {
    const { id, revision } = await project();
    if (allowFallback) await patchProductionProject(id, { localSettings: { providerId: 'example-provider', model: 'example-model', substitution: 'allowed' } });
    runPromptThroughProvider.mockImplementation(async args => {
      args.onRunCreated('owned-repair');
      await args.beforeExecute();
      args.onRunSettled('owned-repair');
      return { text: '```html\n<html>MOVING</html>\n```', provider: { id: allowFallback ? 'fallback-provider' : 'example-provider' }, model: 'example-model', usedFallback: allowFallback };
    });
    const first = await startProductionStageRun(id, {}, { sample, render });
    expect(await first.done).toBe('completed');
    expect(stopRun).not.toHaveBeenCalled();
    expect((await getProductionProject(id)).candidateRevisionId).not.toBe(revision.id);
    const saved = (await getProductionHistory(id, { limit: 1, offset: 0 })).items[0];
    expect(saved.data.effective).toMatchObject({ substituted: allowFallback, effective: { providerId: allowFallback ? 'fallback-provider' : 'example-provider' } });
    expect(saved.data.stages.find(stage => stage.key === 'repair').status).toBe('completed');
  });

  it('releases a repair reservation when cancellation occurs before any source tree is staged', async () => {
    const { id, revision } = await project();
    const started = Promise.withResolvers();
    const response = Promise.withResolvers();
    runPromptThroughProvider.mockImplementation(async args => {
      args.onRunCreated('owned-repair');
      await args.beforeExecute();
      started.resolve();
      const result = await response.promise;
      args.onRunSettled('owned-repair');
      return result;
    });
    const first = await startProductionStageRun(id, {}, { sample, render });
    await started.promise;
    const before = (await getProductionHistory(id, { limit: 1, offset: 0 })).items[0];
    stagingFaults.afterReserve = () => {
      stagingFaults.afterReserve = null;
      cancelProductionStageRun(id, first.run.id);
    };
    response.resolve({ text: '```html\n<html>MOVING</html>\n```' });
    expect(await first.done).toBe('canceled');
    const saved = (await getProductionHistory(id, { limit: 1, offset: 0 })).items[0];
    expect(saved.data).toMatchObject({ reservedBytes: before.data.reservedBytes, repairs: [], currentRevisionId: revision.id });
    expect(saved.data.spent.diskBytes).toBe(before.data.spent.diskBytes);
    expect((await getProductionProject(id)).candidateRevisionId).toBe(revision.id);
    expect(stopRun).not.toHaveBeenCalled(); // Provider already settled before reservation.
  });

  it.each([true, false])('accounts for failed render-source staging when cleanup refusal is %s', async refuseCleanup => {
    const { id, revision } = await project();
    await patchProductionProject(id, { budgets: { diskBytes: revision.totalBytes * 2 } });
    const unusedSample = vi.fn();
    stagingFaults.write = true;
    stagingFaults.cleanup = refuseCleanup;
    let first;
    try {
      first = await startProductionStageRun(id, {}, { sample: unusedSample });
      expect(await first.done).toBe('failed');
    } finally {
      stagingFaults.write = false;
      stagingFaults.cleanup = false;
    }
    const saved = (await getProductionHistory(id, { limit: 1, offset: 0 })).items[0];
    expect(saved).toMatchObject({
      id: first.run.id, status: 'failed',
      data: {
        reservedBytes: refuseCleanup ? revision.totalBytes : 0,
        spent: { diskBytes: refuseCleanup ? revision.totalBytes : 0 },
        error: { code: 'ENOSPC', message: 'Synthetic staging write failure' },
      },
    });
    const directory = join(PATHS.data, 'code-animations', 'projects', id, 'runs', first.run.id, 'render', revision.id);
    expect(await exists(directory)).toBe(refuseCleanup);
    if (refuseCleanup) expect(await readFile(join(directory, 'index.html'), 'utf8')).toContain('FROZEN');
    expect(unusedSample).not.toHaveBeenCalled();
    expect((await getProductionProject(id)).candidateRevisionId).toBe(revision.id);
    // Budget admission distinguishes retained bytes from confirmed cleanup.
    const retrySample = vi.fn().mockRejectedValue(Object.assign(new Error('Synthetic sample failure'), { code: 'SAMPLE_FAILED' }));
    const retryRepair = vi.fn().mockRejectedValue(new Error('Synthetic repair failure'));
    const retry = await startProductionStageRun(id, {}, { sample: retrySample, repair: retryRepair });
    expect(await retry.done).toBe(refuseCleanup ? 'exhausted' : 'failed');
    expect(retrySample).toHaveBeenCalledTimes(refuseCleanup ? 0 : 1);
  });


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
      .toEqual(['style-frame:v1', 'pilot:v1', 'inspect:v1', 'repair:v1', 'style-frame:v2', 'pilot:v2', 'inspect:v2', 'soundtrack:v2', 'final:v2']);
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
    expect(data.output).toMatchObject({ jobId: 'media-job', revisionId: current.candidateRevisionId, verifiedDimensions: expect.arrayContaining(['visual-motion', 'intentional-silence']) });
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

  it.each([false, true])('extracts default-adapter review evidence after metadata and repeated prompt echoes (empty=%s)', async empty => {
    const { id } = await project();
    const detail = `  Brighter [background] {please}: ${'x'.repeat(510)}  `;
    const findings = empty ? [] : [{ detail, atSeconds: 1 }, { detail: 'Keep ```json {"shape":[]} ``` in frame.', atSeconds: 'unknown' }];
    runPromptThroughProvider.mockImplementation(async ({ prompt }) => ({
      text: `${prompt}\nExample: {"schema":"findings"}\n${prompt}\nActual: \`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``,
      provider: { id: 'example-provider' }, model: 'example-model',
    }));
    const { run, done } = await startProductionStageRun(id, { visualReview: true }, { sample, repair: unfreeze, render });
    expect(await done).toBe('completed');
    const saved = (await getProductionHistory(id, { limit: 1, offset: 0 })).items.find(item => item.id === run.id);
    const review = saved.data.stages.find(stage => stage.key === 'review');
    expect(review.status).toBe('completed');
    expect(review.reviewFindings).toEqual(empty ? [] : [
      { detail: detail.trim().slice(0, 500), atSeconds: 1 },
      { detail: findings[1].detail, atSeconds: null },
    ]);
    expect(saved.data.verdict.unverified.map(item => item.dimension)).not.toContain('semantic-visual');
    expect(runPromptThroughProvider.mock.calls.at(-1)[0]).toMatchObject({ toolFree: true, source: 'code-animation-review', screenshots: expect.any(Array) });
  });

  it.each(['{"schema":"findings"}', '{"findings":[{"detail":42}]}', 'not JSON', 'prompt only'])('fails default-adapter review without successful evidence for %s', async text => {
    const { id } = await project();
    runPromptThroughProvider.mockImplementation(async ({ prompt }) => ({ text: text === 'prompt only' ? `${prompt}\n${prompt}` : text }));
    render.mockClear();
    const { done } = await startProductionStageRun(id, { visualReview: true }, { sample, repair: unfreeze, render });
    expect(await done).toBe('failed');
    const [saved] = (await getProductionHistory(id, { limit: 1, offset: 0 })).items;
    expect(saved.data.stages.find(stage => stage.key === 'review')).toMatchObject({ status: 'failed', error: 'CODE_ANIMATION_REVIEW_INVALID' });
    expect(saved.data.stages.some(stage => stage.key === 'inspect')).toBe(false);
    expect(render).not.toHaveBeenCalled();
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

  it('runs Blender stages from immutable Python and rerenders resumed evidence after runtime authority changes', async () => {
    const blenderManifest = { ...manifest(), renderer: { kind: 'blender', version: '4.2.0', engine: 'CYCLES' }, entrypoints: [{ role: 'scene', path: 'scene.py' }] };
    const created = await createProductionProject({ manifest: blenderManifest });
    ids.push(created.id);
    const imported = createCodeAnimationPackage(blenderManifest, [{ path: 'scene.py', content: 'def build_scene(config): pass' }]);
    const { revision } = await importProductionPackage(created.id, imported);
    let binding = 'first-check';
    const resolveBlender = vi.fn(async () => ({ provenance: { binding, version: '4.2.0', engine: 'CYCLES', device: 'CPU', executionMode: 'trusted-local', contained: false } }));
    const blender = vi.fn(async options => {
      expect(options.runtime.binding).toBe(binding);
      expect(options.revision.entryPath).toBe('scene.py');
      expect(options.revision.files[0].content).toBe(imported.files[0].content);
      expect(options.revision.staged).toContain('/revisions/');
      return { contract: { durationSec: 4, fps: 12, width: 1280, height: 720 },
        frames: (options.captureTimes || []).map(t => ({ t, bytes: Buffer.from(`synthetic-${t}`) })),
        samples: Array.from({ length: 48 }, (_, i) => ({ t: i / 12, renderHash: String(i), mean: 80, deviation: 20 })),
        renderer: options.runtime, artifacts: [] };
    });
    const browser = vi.fn();
    const commit = vi.fn().mockRejectedValueOnce(new Error('Synthetic history failure')).mockResolvedValue(undefined);
    const cleanup = vi.fn();
    const publishBlender = vi.fn().mockResolvedValue({ id: 'synthetic-video', filename: 'synthetic.mp4', commit, cleanup });
    const deps = { resolveBlender, blender, publishBlender, sample: browser, render: browser };
    await expect(startProductionStageRun(created.id, { executionMode: 'trusted-local' }, deps)).rejects.toThrow();
    const first = await startProductionStageRun(created.id, {}, deps);
    expect(await first.done).toBe('failed');
    binding = 'second-check';
    const second = await startProductionStageRun(created.id, { resumeFromRunId: first.run.id }, deps);
    expect(await second.done).toBe('completed');
    expect(blender.mock.calls.map(([options]) => options.phase)).toEqual(['style', 'pilot', 'final', 'style', 'pilot', 'final']);
    expect(browser).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
    const saved = (await getProductionHistory(created.id, { limit: 5, offset: 0 })).items.find(item => item.id === second.run.id);
    expect(saved.data.renderer).toMatchObject({ binding: 'second-check', contained: false });
    expect(saved.data.stages.every(stage => !stage.reusedFrom && stage.rendererBinding === 'second-check')).toBe(true);
    expect((await exportProductionPackage(created.id, revision.id)).revisionHash).toBe(imported.revisionHash);
  });

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
