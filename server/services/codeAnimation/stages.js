/**
 * Bounded Code Animation production stages (#9389):
 *
 *   style-frame → pilot → [review] → inspect → (repair → …) → final render
 *
 * A run starts only from an explicit user request, works on immutable stored
 * revisions, and measures real renders in the HTML-composition sandbox before
 * anything is judged. Every stage records the source hash it measured, a stage
 * run id and timestamps; evidence from another source never passes. Budgets
 * (iterations, time, tokens, render time, disk) stop the run with a resumable
 * status that keeps accepted artifacts. Nothing runs at boot and a restart
 * marks a stranded run interrupted without calling a provider.
 */
import { randomUUID } from 'crypto';
import { join } from 'path';
import { createCodeAnimationPackage } from '../../lib/codeAnimationPackage.js';
import { codeAnimationStageRunSchema } from '../../lib/codeAnimationProjects.js';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/paths.js';
import { htmlCompositionContractSchema, validateRequest } from '../../lib/validation.js';
import { emitCodeAnimationChanged } from '../socket.js';
import { analyzeEvidence, evaluateVerdict } from './evidence.js';
import { buildExportShim, injectExportShim } from './export.js';
import * as store from './projectStore.js';
import { ownedStorageRetained, readProjectFiles, sourceHashOf, stageProjectFiles, stageRenderSource, writeRunArtifact } from './projectFiles.js';
import { checkSoundConsent, produceSoundtrack, muxSoundtrack } from './sound.js';
import { renderViaMediaQueue, sampleFilm } from './stageRender.js';
import { resolveBlenderExecution } from './execution.js';
import { renderBlenderSequence, publishBlenderVideo } from './blenderRender.js';

export const STAGE_RUN_KIND = 'production-stages';
const STYLE_POINTS = [0.1, 0.5, 0.9];
const PILOT_MAX_FPS = 6;
const PILOT_MAX_SAMPLES = 240;
const RESUMABLE = new Set(['interrupted', 'canceled', 'exhausted', 'failed']);
const BUDGET_CODE = 'CODE_ANIMATION_BUDGET_EXHAUSTED';
const CANCEL_CODE = 'CODE_ANIMATION_RUN_CANCELED';

const activeRuns = new Map();
export const activeStageRunIds = () => [...activeRuns.keys()];

const exhausted = dimension => new ServerError(`Production budget exhausted: ${dimension}`, { status: 409, code: BUDGET_CODE, context: { dimension } });
const canceledError = () => new ServerError('Production run canceled', { status: 409, code: CANCEL_CODE });
const iso = () => new Date().toISOString();
const round3 = value => Math.round(value * 1000) / 1000;

const entryOf = manifest => manifest.entrypoints.find(item => item.role === 'preview')
  || manifest.entrypoints.find(item => item.role === 'render') || manifest.entrypoints[0];

/** The page gets the renderer's clock; a film that already defines portosComposition is left alone. */
function prepareEntry(manifest) {
  const { width, height, fps, durationSeconds } = manifest.format;
  const defaults = `window.ANIMATION_META = ${JSON.stringify({ title: manifest.title, duration: durationSeconds, fps, width, height }).replace(/</g, '\\u003c')};`;
  return html => /portosComposition/.test(html) ? html : injectExportShim(html, `${defaults}\n${buildExportShim({ maxDurationSec: durationSeconds })}`);
}

const sampleTimes = ({ durationSeconds, fps }, pilotFps) => {
  const step = 1 / pilotFps;
  const last = durationSeconds - 1 / fps;
  const times = [];
  for (let t = 0; t < durationSeconds && times.length < PILOT_MAX_SAMPLES; t += step) times.push(round3(Math.min(t, last)));
  return [...new Set(times)];
};
const styleTimes = ({ durationSeconds, fps }) => [...new Set(STYLE_POINTS.map(point => round3(Math.min(point * durationSeconds, durationSeconds - 1 / fps))))];

function snapshot(ctx) {
  const { state } = ctx;
  return { ...state, spent: { ...state.spent, elapsedMs: Date.now() - ctx.startedAt + state.spent.priorElapsedMs } };
}

async function persist(ctx, status = 'running', { completed = false, revisionId = null } = {}) {
  ctx.state.spent.elapsedMs = Date.now() - ctx.startedAt + ctx.state.spent.priorElapsedMs;
  await store.saveStageRun(ctx.runId, status, snapshot(ctx), { completed, revisionId });
  emitCodeAnimationChanged(ctx.projectId);
}

function remainingMs(ctx) {
  const { budgets, spent } = ctx.state;
  const time = budgets.timeSeconds * 1000 - (Date.now() - ctx.startedAt + spent.priorElapsedMs);
  const render = budgets.renderSeconds * 1000 - spent.renderMs;
  return render <= time ? { ms: render, dimension: 'render' } : { ms: time, dimension: 'time' };
}

function checkBudget(ctx) {
  ctx.controller.signal.throwIfAborted();
  const { ms, dimension } = remainingMs(ctx);
  if (ms <= 0) throw exhausted(dimension);
  if (ctx.state.spent.tokens >= ctx.state.budgets.tokens) throw exhausted('tokens');
}

async function reserve(ctx, bytes) {
  if (!await store.reserveRunBytes(ctx.runId, ctx.projectId, bytes)) throw exhausted('disk');
  ctx.state.spent.diskBytes += bytes;
  ctx.state.reservedBytes += bytes;
}

/**
 * Run one stage body under the run's cancel signal and the tighter of the time
 * and render budgets. The stage's own record carries the evidence either way.
 */
async function runStage(ctx, key, revision, body, { renders = false } = {}) {
  checkBudget(ctx);
  const entry = { key, rendererBinding: ctx.state.renderer?.binding ?? null, stageRunId: randomUUID(), revisionId: revision.id, sourceHash: revision.sourceHash, packageHash: revision.packageHash, status: 'running', startedAt: iso() };
  ctx.state.stages.push(entry);
  await persist(ctx);
  const { ms, dimension } = remainingMs(ctx);
  const signal = AbortSignal.any([ctx.controller.signal, AbortSignal.timeout(ms)]);
  const began = Date.now();
  try {
    Object.assign(entry, await body({ signal, entry }), { status: 'completed', completedAt: iso() });
  } catch (error) {
    const canceled = ctx.controller.signal.aborted;
    const outOfBudget = !canceled && signal.aborted;
    Object.assign(entry, { status: canceled ? 'canceled' : outOfBudget ? 'exhausted' : 'failed', completedAt: iso(), error: error.code || error.message });
    if (canceled) throw canceledError();
    if (outOfBudget) throw exhausted(dimension);
    throw error;
  } finally {
    if (renders) ctx.state.spent.renderMs += Date.now() - began;
    await persist(ctx).catch(error => console.error(`❌ Code Animation stage ${key} status could not be saved: ${error.message}`));
  }
  return entry;
}

const reusable = (ctx, key, revision) => ctx.prior.find(stage => stage.key === key && stage.revisionId === revision.id
  && stage.sourceHash === revision.sourceHash && stage.packageHash === revision.packageHash && stage.status === 'completed'
  && (stage.rendererBinding ?? null) === (ctx.state.renderer?.binding ?? null));

/** Read verified revision bytes; only browser source needs an HTML staging shim. */
async function stageRevision(ctx, revision) {
  const files = await readProjectFiles(ctx.projectId, revision.id, revision.files);
  await reserve(ctx, revision.totalBytes);
  const entryPath = (revision.manifest.renderer.kind === 'blender'
    ? revision.manifest.entrypoints.find(item => item.role === 'scene') || entryOf(revision.manifest) : entryOf(revision.manifest)).path;
  if (ctx.state.renderer) return { ...revision, files, staged: revision.storage.relativePath, entryPath };
  try {
    const staged = await stageRenderSource(ctx.projectId, ctx.runId, revision.id, files, entryPath, prepareEntry(revision.manifest));
    return { ...revision, files, staged: staged.directory, entryPath };
  } catch (error) {
    // Finish persists this release only when staging left no owned storage.
    // A refused cleanup keeps its bytes reserved and preserves the root cause.
    if (!ownedStorageRetained(error)) {
      ctx.state.reservedBytes -= revision.totalBytes;
      ctx.state.spent.diskBytes -= revision.totalBytes;
    }
    throw error;
  }
}

async function blenderSequence(ctx, revision, signal, phase, options = {}) {
  return ctx.deps.blender({ revision, runtime: ctx.state.renderer, projectId: ctx.projectId, runId: ctx.runId, signal, phase,
    reserve: bytes => reserve(ctx, bytes), wallSeconds: remainingMs(ctx).ms / 1000,
    diskBytes: Math.max(1024, ctx.state.budgets.diskBytes - ctx.state.spent.diskBytes), ...options });
}

async function styleFrameStage(ctx, revision) {
  const prior = reusable(ctx, 'style-frame', revision);
  if (prior) { ctx.state.stages.push({ ...prior, reusedFrom: ctx.resumedFrom }); return prior; }
  return runStage(ctx, 'style-frame', revision, async ({ signal }) => {
    const times = styleTimes(revision.manifest.format);
    try {
      const measured = ctx.state.renderer ? await blenderSequence(ctx, revision, signal, 'style', { captureTimes: times })
        : await ctx.deps.sample(revision.staged, { times: [], captureTimes: times, signal });
      const { frames, contract } = measured;
      const artifacts = [];
      for (const frame of frames) {
        await reserve(ctx, frame.bytes.length);
        const written = await writeRunArtifact(ctx.projectId, ctx.runId, `style-${revision.id.slice(0, 8)}-${String(frame.t).replace('.', '_')}.png`, frame.bytes);
        artifacts.push({ atSeconds: frame.t, ...written });
      }
      return { contract, artifacts, ...(measured.renderer ? { renderer: measured.renderer, sceneArtifacts: measured.artifacts } : {}) };
    } catch (error) {
      if (signal.aborted || error.code === 'CODE_ANIMATION_UNSAFE_STORAGE' || error.code === BUDGET_CODE || ['CODE_ANIMATION_BLENDER_NOT_READY', 'CODE_ANIMATION_BLENDER_READINESS_CHANGED', 'CODE_ANIMATION_BLENDER_RUNTIME_MISMATCH'].includes(error.code)) throw error;
      return { artifacts: [], filmError: String(error.message).slice(0, 500) };
    }
  }, { renders: true });
}

async function pilotStage(ctx, revision, style) {
  const prior = reusable(ctx, 'pilot', revision);
  if (prior) { ctx.state.stages.push({ ...prior, reusedFrom: ctx.resumedFrom }); return prior; }
  if (style.filmError) {
    return runStage(ctx, 'pilot', revision, async () => ({ samples: [], skipped: 'The film did not run, so no pilot was measured.' }));
  }
  const { fps } = revision.manifest.format;
  const pilotFps = ctx.state.renderer ? fps : Math.min(PILOT_MAX_FPS, fps);
  return runStage(ctx, 'pilot', revision, async ({ signal }) => {
    const measured = ctx.state.renderer ? await blenderSequence(ctx, revision, signal, 'pilot')
      : await ctx.deps.sample(revision.staged, { times: sampleTimes(revision.manifest.format, pilotFps), signal });
    const { samples, contract } = measured;
    return { pilotFps, contract, samples, capturedAt: iso(), ...(measured.renderer ? { renderer: measured.renderer, artifacts: measured.artifacts, sequence: measured.sequence } : {}) };
  }, { renders: true });
}

const reviewPrompt = ({ manifest, artifacts }) => [
  'You review still frames of a generated animation against its brief. Judge style fit and composition only; do not suggest code.',
  `Brief: ${manifest.brief.concept}`,
  `Style guide: ${manifest.styleGuide || 'unspecified'}`,
  `Frames, in order, are at seconds: ${artifacts.map(item => item.atSeconds).join(', ')}.`,
  'Reply with JSON only: {"findings":[{"detail":"<one sentence>","atSeconds":<number|null>}]}. An empty list means the frames fit the brief.',
].join('\n');

/** The explicit vision route: the project's own saved authoring settings, images attached, no fallback unless the user allowed it. */
async function reviewViaAuthoringRoute({ project, manifest, artifacts, signal, timeoutMs }) {
  const [{ preflightProductionProject, _recordEffectiveRoute }, { runPromptThroughProvider }, { getProviderById }] = await Promise.all([
    import('./preflight.js'), import('../promptRunner.js'), import('../providers.js'),
  ]);
  const preflight = await preflightProductionProject(project.id);
  if (!preflight.resolved || preflight.problems.length) {
    throw new ServerError(`The authoring route is not ready: ${preflight.problems.join(' ') || 'select a provider'}`, { status: 409, code: 'CODE_ANIMATION_AUTHORING_UNAVAILABLE' });
  }
  if (!preflight.capabilities.imageInputAccepted) {
    throw new ServerError('The authoring route cannot receive images, so it cannot review frames.', { status: 409, code: 'CODE_ANIMATION_REVIEW_UNSUPPORTED' });
  }
  const provider = await getProviderById(preflight.resolved.providerId);
  const prompt = reviewPrompt({ manifest, artifacts });
  const { stopRun } = await import('../runner.js');
  let providerRunId = null;
  const stopProvider = () => { if (providerRunId) stopRun(providerRunId).catch(() => { /* best-effort cancel */ }); };
  signal?.addEventListener('abort', stopProvider, { once: true });
  const result = await runPromptThroughProvider({
    provider, model: preflight.resolved.model, effort: preflight.resolved.effort || undefined, prompt,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
    onRunCreated: id => { providerRunId = id; if (signal?.aborted) stopProvider(); },
    screenshots: artifacts.map(item => join(PATHS.data, item.relativePath)),
    source: 'code-animation-review', cwd: PATHS.data, allowFallback: preflight.allowFallback, toolFree: true,
  }).finally(() => signal?.removeEventListener('abort', stopProvider));
  const route = _recordEffectiveRoute(preflight.resolved, project.localSettings, result);
  const parsed = parseReviewFindings(result.text);
  if (!parsed) throw new ServerError('The reviewer response was not valid JSON findings', { status: 422, code: 'CODE_ANIMATION_REVIEW_INVALID' });
  return { findings: parsed, tokens: Math.ceil((prompt.length + result.text.length) / 4), reviewer: { providerId: route.effective.providerId, model: route.effective.model }, effective: route };
}

/** Pull `{findings:[…]}` out of a reply that may be fenced or wrapped in prose; null when it carries none. */
function parseReviewFindings(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let value;
  try { value = JSON.parse(match[0]); } catch { return null; }
  if (!Array.isArray(value?.findings)) return null;
  return value.findings.filter(item => typeof item?.detail === 'string' && item.detail.trim()).slice(0, 10)
    .map(item => ({ detail: item.detail.trim().slice(0, 500), atSeconds: Number.isFinite(item.atSeconds) ? item.atSeconds : null }));
}

async function reviewStage(ctx, revision, style) {
  const prior = reusable(ctx, 'review', revision);
  if (prior) { ctx.state.stages.push({ ...prior, reusedFrom: ctx.resumedFrom }); return prior; }
  if (!style.artifacts?.length) return null;
  return runStage(ctx, 'review', revision, async ({ signal }) => {
    const out = await ctx.deps.review({ project: ctx.project, manifest: revision.manifest, artifacts: style.artifacts, signal, timeoutMs: remainingMs(ctx).ms });
    ctx.state.spent.tokens += out.tokens || 0;
    if (out.effective) ctx.state.effective = out.effective;
    return { reviewer: out.reviewer, reviewFindings: out.findings, evaluatedStageRunId: style.stageRunId };
  });
}

function inspectStage(ctx, revision, style, pilot, review = null) {
  return runStage(ctx, 'inspect', revision, async () => {
    // Each piece of evidence names the source it measured; a mismatch is stale.
    const evidence = { packageHash: revision.packageHash, sourceHash: style.sourceHash === pilot.sourceHash ? style.sourceHash : null, styleStageRunId: style.stageRunId, pilotStageRunId: pilot.stageRunId };
    let analysis;
    if (style.filmError) {
      analysis = { findings: [{ kind: 'film-error', severity: 'error', detail: `The film did not run: ${style.filmError}`, measured: { error: style.filmError } }], verified: [], unverified: [{ dimension: 'visual-motion', reason: 'The film did not render.' }] };
    } else {
      analysis = analyzeEvidence({ manifest: revision.manifest, pilot, contract: pilot.contract, review });
      if (ctx.state.renderer && pilot.renderer?.baked && pilot.renderer.cameraSmooth && pilot.renderer.cadence?.length) {
        analysis.verified.push('renderer-runtime', 'stepped-transform-cadence', 'continuous-camera', 'baked-scene');
      }
      // The final render must be accepted by the same contract the renderer enforces; find that now, not at the end.
      const accepted = htmlCompositionContractSchema.safeParse(pilot.contract);
      if (!accepted.success) {
        const detail = accepted.error.issues.map(issue => issue.message).join('; ');
        analysis.findings.push({ kind: 'renderer-contract', severity: 'error', detail: `The renderer would refuse this film: ${detail}`, measured: { contract: pilot.contract } });
      }
    }
    const capturedAt = iso();
    const advisory = (review?.reviewFindings || []).map(item => ({ kind: 'visual-review', severity: 'warning', detail: item.detail, atSeconds: item.atSeconds, measured: { reviewer: review.reviewer } }));
    const findings = [...analysis.findings, ...advisory].map(finding => ({ ...finding, sourceHash: revision.sourceHash, revisionId: revision.id, evidenceStageRunIds: [style.stageRunId, pilot.stageRunId], capturedAt }));
    const verdict = evaluateVerdict({ evidence, packageHash: revision.packageHash, sourceHash: revision.sourceHash, findings, unverified: analysis.unverified });
    return { evidence, findings, verified: analysis.verified, verdict };
  });
}

const repairPrompt = ({ manifest, files, entryPath, findings }) => [
  manifest.renderer.kind === 'blender'
    ? 'Repair a Blender scene. Return the complete Python source in one ```python fence. Keep build_scene(config), deterministic baked constant subject/FX keys with portos_cadence 2 or 3, and smooth keyed camera. No live physics, external downloads or installers.'
    : 'Repair a browser animation. Return complete HTML in one ```html fence. Keep window.ANIMATION_META and window.renderFrame(t), pure time-based canvas rendering, no network or animation timers.',
  `Brief: ${manifest.brief.concept}`,
  `Format: ${manifest.format.width}x${manifest.format.height}, ${manifest.format.fps}fps, ${manifest.format.durationSeconds}s.`,
  'Measured findings to fix:',
  ...findings.map(finding => `- [${finding.severity}] ${finding.kind}: ${finding.detail} ${finding.atSeconds != null ? `(at ${finding.atSeconds}s)` : ''}`),
  `Current source (${entryPath}):`, files.find(file => file.path === entryPath).content,
].join('\n');

/**
 * The explicit authoring route: preflight the project's saved provider
 * settings, run one prompt, and reject a substituted route unless the user
 * allowed it. Only reached from a user-started run.
 */
async function repairViaAuthoringRoute({ project, manifest, files, entryPath, findings }) {
  const [{ preflightProductionProject, _recordEffectiveRoute }, { runPromptThroughProvider }, { getProviderById }, { extractAnimationHtml }] = await Promise.all([
    import('./preflight.js'), import('../promptRunner.js'), import('../providers.js'), import('./prompt.js'),
  ]);
  const preflight = await preflightProductionProject(project.id);
  if (!preflight.resolved || preflight.problems.length) {
    throw new ServerError(`The authoring route is not ready: ${preflight.problems.join(' ') || 'select a provider'}`, { status: 409, code: 'CODE_ANIMATION_AUTHORING_UNAVAILABLE' });
  }
  const provider = await getProviderById(preflight.resolved.providerId);
  const prompt = repairPrompt({ manifest, files, entryPath, findings });
  const result = await runPromptThroughProvider({
    provider, model: preflight.resolved.model, effort: preflight.resolved.effort || undefined, prompt,
    source: 'code-animation-repair', cwd: PATHS.data, allowFallback: preflight.allowFallback,
  });
  const route = _recordEffectiveRoute(preflight.resolved, project.localSettings, result);
  const source = manifest.renderer.kind === 'blender' ? result.text.match(/```(?:python|py)\s*\n([\s\S]*?)```/)?.[1] : extractAnimationHtml(result.text);
  if (!source) throw new ServerError('The model response did not contain the required source document', { status: 422, code: 'CODE_ANIMATION_REPAIR_INVALID' });
  return { files: [{ path: entryPath, content: source, encoding: 'utf8' }], tokens: Math.ceil((prompt.length + result.text.length) / 4), effective: route };
}

async function repairStage(ctx, revision, findings) {
  const { spent, budgets } = ctx.state;
  if (spent.iterations >= budgets.iterations) throw exhausted('iterations');
  const errors = findings.filter(finding => finding.severity === 'error');
  let created = null;
  await runStage(ctx, 'repair', revision, async ({ signal, entry }) => {
    const intent = { findingKinds: [...new Set(errors.map(finding => finding.kind))], fromRevisionId: revision.id };
    const out = await ctx.deps.repair({ project: ctx.project, manifest: revision.manifest, files: revision.files, entryPath: revision.entryPath, findings: errors, signal });
    spent.tokens += out.tokens || 0;
    spent.iterations += 1;
    if (out.effective) ctx.state.effective = out.effective;
    const merged = new Map(revision.files.map(file => [file.path, file]));
    for (const file of out.files || []) merged.set(file.path, { path: file.path, content: file.content, encoding: file.encoding || 'utf8' });
    let pkg;
    try {
      pkg = createCodeAnimationPackage(revision.manifest, [...merged.values()]);
    } catch (error) {
      throw new ServerError(`The repaired source is not a valid package: ${error.issues?.[0]?.message || error.message}`, { status: 422, code: 'CODE_ANIMATION_REPAIR_INVALID' });
    }
    const sourceHash = sourceHashOf(pkg.files);
    if (sourceHash === revision.sourceHash) throw new ServerError('The repair did not change the source', { status: 422, code: 'CODE_ANIMATION_REPAIR_NOOP' });
    const totalBytes = pkg.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'), 0);
    await reserve(ctx, totalBytes);
    const id = randomUUID();
    const storage = await stageProjectFiles(ctx.projectId, id, pkg.files);
    created = {
      id, packageHash: pkg.revisionHash, sourceHash, totalBytes, schemaVersion: pkg.schemaVersion, manifest: pkg.manifest,
      files: pkg.files.map(({ content: _content, ...file }) => file), storage, createdAt: iso(),
      parentRevisionId: revision.id, repair: { runId: ctx.runId, stageRunId: entry.stageRunId, intent },
    };
    await store.commitRepairRevision(ctx.projectId, created);
    ctx.state.repairs.push({ revisionId: id, fromRevisionId: revision.id, sourceHash, findingKinds: intent.findingKinds, tokens: out.tokens || 0 });
    ctx.state.currentRevisionId = id;
    return { intent, toRevisionId: id, toSourceHash: sourceHash };
  });
  return created;
}

async function finalStage(ctx, revision, verdictStage, soundtrack) {
  // Re-evaluate against the revision about to render: stale or failed evidence never reaches the renderer.
  const verdict = evaluateVerdict({ evidence: verdictStage.evidence, packageHash: revision.packageHash, sourceHash: revision.sourceHash, findings: verdictStage.findings, unverified: verdictStage.verdict.unverified });
  if (verdict.status !== 'pass') throw new ServerError(`The final render needs passing evidence (${verdict.status})`, { status: 409, code: 'CODE_ANIMATION_EVIDENCE_NOT_PASSING' });
  const stage = await runStage(ctx, 'final', revision, async ({ signal }) => {
    const result = ctx.state.renderer
      ? await ctx.deps.publishBlender(await blenderSequence(ctx, revision, signal, 'final'), { revision, signal, reserve: bytes => reserve(ctx, bytes) })
      : await ctx.deps.render({ directory: revision.staged, signal });
    let published = false;
    try {
      signal.throwIfAborted();
      const audioEvidence = await ctx.deps.mux({ projectId: ctx.projectId, revision, soundtrack, result, signal, reserve: bytes => reserve(ctx, bytes) });
      signal.throwIfAborted();
      if (result.commit) {
        // Publishing is the commit point: don't accept a cancellation halfway
        // through a shared history write after the soundtrack passed.
        activeRuns.get(ctx.runId).committing = true;
        await result.commit();
      }
      published = true;
      return { audioEvidence, ...(result.renderer ? { renderer: result.renderer, artifacts: result.artifacts } : {}), output: { packageHash: revision.packageHash, audioHash: soundtrack.artifact?.sha256 ?? null, jobId: result.jobId ?? null, videoId: result.id ?? null, filename: result.filename ?? null, path: result.path ?? null, revisionId: revision.id, sourceHash: revision.sourceHash } };
    } finally { if (!published) await result.cleanup?.(); }
  }, { renders: true });
  ctx.state.output = { ...stage.output, stageRunId: stage.stageRunId, audioEvidence: stage.audioEvidence, soundtrack, verifiedDimensions: [...verdictStage.verified.filter(key => key !== 'audio'), ...stage.audioEvidence.verified], unverified: [...verdict.unverified.filter(item => item.dimension !== 'audio'), ...soundtrack.unverified] };
}

async function execute(ctx, start) {
  let revision = start;
  for (;;) {
    revision = await stageRevision(ctx, revision);
    const style = await styleFrameStage(ctx, revision);
    const pilot = await pilotStage(ctx, revision, style);
    const review = ctx.state.visualReview ? await reviewStage(ctx, revision, style) : null;
    const inspected = await inspectStage(ctx, revision, style, pilot, review);
    ctx.state.findings = inspected.findings;
    ctx.state.verdict = { ...inspected.verdict, revisionId: revision.id, sourceHash: revision.sourceHash };
    if (inspected.verdict.status === 'pass') {
      const soundtrack = await runStage(ctx, 'soundtrack', revision, ({ signal }) => ctx.deps.sound({
        projectId: ctx.projectId, runId: ctx.runId, revision, signal, reserve: bytes => reserve(ctx, bytes),
      }), { renders: true });
      ctx.state.soundtrack = soundtrack;
      ctx.state.verdict = { ...ctx.state.verdict, unverified: [...ctx.state.verdict.unverified.filter(item => item.dimension !== 'audio'), ...soundtrack.unverified] };
      return finalStage(ctx, revision, inspected, soundtrack);
    }
    revision = await repairStage(ctx, revision, inspected.findings);
  }
}

async function finish(ctx, run) {
  let status = 'completed';
  let outcome = null;
  try {
    await run();
  } catch (error) {
    if (error.code === CANCEL_CODE) { status = 'canceled'; outcome = { stopReason: 'canceled' }; }
    else if (error.code === BUDGET_CODE) { status = 'exhausted'; outcome = { stopReason: error.context?.dimension || 'budget' }; }
    else {
      status = 'failed';
      outcome = { stopReason: 'failed', error: { code: error.code || 'RUN_FAILED', message: String(error.message).slice(0, 500) } };
      console.error(`❌ Code Animation production run ${ctx.runId.slice(0, 8)} failed: ${error.message}`);
    }
  }
  Object.assign(ctx.state, outcome || { stopReason: null }, { resumable: status !== 'completed' });
  activeRuns.delete(ctx.runId);
  await persist(ctx, status, { completed: true, revisionId: ctx.state.currentRevisionId }).catch(error => {
    console.error(`❌ Code Animation production run ${ctx.runId.slice(0, 8)} final status could not be saved: ${error.message}`);
  });
  console.log(`🎞️ Code Animation production run ${ctx.runId.slice(0, 8)} ${status}${ctx.state.stopReason ? ` (${ctx.state.stopReason})` : ''}`);
  return status;
}

const defaultDeps = { resolveBlender: resolveBlenderExecution, blender: renderBlenderSequence, publishBlender: publishBlenderVideo, sound: produceSoundtrack, mux: muxSoundtrack, sample: sampleFilm, render: renderViaMediaQueue, repair: repairViaAuthoringRoute, review: reviewViaAuthoringRoute };

/**
 * Start a user-requested production run. Resolves with the persisted run once
 * it is `running`; `done` settles with the terminal status (tests await it, the
 * route does not). The project may have only one live run.
 */
export async function startProductionStageRun(projectId, input, deps = {}) {
  const request = validateRequest(codeAnimationStageRunSchema, input ?? {});
  const project = await store.getProjectRecord(projectId);
  if (!project) throw new ServerError('Production project not found', { status: 404, code: 'NOT_FOUND' });
  let prior = null;
  if (request.resumeFromRunId) {
    prior = await store.getRunRecord(projectId, request.resumeFromRunId);
    if (!prior || prior.data.kind !== STAGE_RUN_KIND) throw new ServerError('Run not found', { status: 404, code: 'NOT_FOUND' });
    if (!RESUMABLE.has(prior.status) || !prior.data.resumable) throw new ServerError('Only a stopped run can be resumed', { status: 409, code: 'CODE_ANIMATION_RUN_NOT_RESUMABLE' });
  }
  const revisionId = prior ? prior.data.currentRevisionId : request.revisionId || project.candidateRevisionId || project.acceptedRevisionId;
  const record = revisionId ? await store.getRevisionRecord(projectId, revisionId) : null;
  if (!record) throw new ServerError('Import a source revision before running production stages', { status: 409, code: 'CODE_ANIMATION_NO_REVISION' });
  const resolvedBlender = record.manifest.renderer.kind === 'blender'
    ? await (deps.resolveBlender || resolveBlenderExecution)(record.manifest.renderer) : null;
  checkSoundConsent(record.manifest.audio, request);
  const revision = { ...record };
  const runId = randomUUID();
  const priorSpent = prior?.data.spent;
  const state = {
    kind: STAGE_RUN_KIND, renderer: resolvedBlender?.provenance ?? null, sourceRevisionId: revision.id, currentRevisionId: revision.id, sourceHash: revision.sourceHash,
    budgets: project.budgets, requested: project.localSettings, effective: null, reservedBytes: 0,
    spent: { iterations: priorSpent?.iterations ?? 0, tokens: priorSpent?.tokens ?? 0, renderMs: priorSpent?.renderMs ?? 0, diskBytes: 0, elapsedMs: 0, priorElapsedMs: priorSpent?.elapsedMs ?? 0 },
    visualReview: request.visualReview ?? prior?.data.visualReview ?? false,
    stages: [], findings: [], verdict: null, soundtrack: null, output: null, repairs: prior?.data.repairs ?? [],
    resumedFrom: prior?.id ?? null, stopReason: null, resumable: false, executed: true,
  };
  const ctx = {
    runId, projectId, project, state, deps: { ...defaultDeps, ...deps }, controller: new AbortController(),
    startedAt: Date.now(), prior: prior?.data.stages ?? [], resumedFrom: prior?.id ?? null,
  };
  await store.startStageRun(runId, projectId, snapshot(ctx), activeStageRunIds());
  activeRuns.set(runId, { controller: ctx.controller, projectId });
  emitCodeAnimationChanged(projectId);
  console.log(`🎞️ Code Animation production run ${runId.slice(0, 8)} started on revision ${revision.id.slice(0, 8)}`);
  // Process boundary: nothing may reject unhandled out of the background run.
  const done = finish(ctx, () => execute(ctx, revision)).catch(error => {
    console.error(`❌ Code Animation production run ${runId.slice(0, 8)} crashed: ${error.message}`);
    activeRuns.delete(runId);
    return 'failed';
  });
  return { run: { id: runId, status: 'running', ...snapshot(ctx) }, done };
}

/** Stop an active run: owned renders are cancelled and accepted artifacts stay. */
export function cancelProductionStageRun(projectId, runId) {
  const active = activeRuns.get(runId);
  if (!active || active.projectId !== projectId) throw new ServerError('That run is not active', { status: 409, code: 'CODE_ANIMATION_RUN_NOT_ACTIVE' });
  if (active.committing) throw new ServerError('The completed render is being published and can no longer be canceled', { status: 409, code: 'CODE_ANIMATION_RUN_COMMITTING' });
  active.controller.abort(canceledError());
  return { id: runId, canceling: true };
}
