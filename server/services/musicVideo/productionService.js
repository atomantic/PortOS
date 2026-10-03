import { prepareProductionReview, renderProductionProof, attachProductionPilotProof } from './productionReviewService.js';
import { productionReadiness, productionProofNeedsRender, productionProofWindow } from './productionReview.js';
import { currentPlateEvidence, plateRequirementBasis, selectedPlatePasses } from '../../lib/musicVideoPlateEvidence.js';
import { ensureSceneTakes, selectSceneTake } from './takes.js';
/**
 * Music Video — server-owned production run (#9066): the orchestrator over the
 * pure checkpoint in production.js, the pool rules in productionPool.js and
 * the browserless scene lanes in productionDispatch.js.
 *
 * `advanceProduction` derives the run's next step from the record and the
 * media queue and keeps taking steps until it has to wait — for generation
 * jobs, or for the auto-review run it handed the finished draft to. The
 * browser is never in the loop: frames, clips and the review's revised
 * sections are all dispatched from here, so closing the tab stalls nothing.
 *
 * What moves a run forward:
 *   - the director — Start, Resume;
 *   - completion events of work THIS run put in flight: a take landing on a
 *     scene (`scene-image` / `scene-video`), one of its jobs failing or being
 *     cancelled, and its review run handing out revised sections or ending.
 * Nothing at boot advances a run. A run is pinned to the process that started
 * or resumed it (`processId`), so after a restart its checkpoint loads and
 * late completion events still settle their steps, but nothing is dispatched
 * — and no provider is called — until the director resumes. Advances for one
 * run are coalesced in-process, and every dispatch reserves its step in a
 * serialized write first, so an event arriving mid-step cannot dispatch twice.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { musicVideoEvents } from './events.js';
import { isFreeProvider } from '../../lib/modelPricing.js';
import { isToolFreeOneShotProvider } from '../../lib/providerVendors.js';
import { codeFirstProductionAssets } from '../../lib/musicVideoMediumPlan.js';
import { beginNextAttempt } from './autoReview.js';
import { withAutopilotCutting } from './composition.js';
import { currentPilotPass, pilotClass, pilotRepair } from './productionPilot.js';
import {
  attachProductionReview,
  attachProductionPilotReview,
  planProductionPilots,
  reserveProductionReview,
  quoteProductionSpend,
  attachProductionDocument,
  assertProductionActive,
  recordProductionDocumentRevision,
  setProductionRender,
  assertProductionStepOpen,
  assertProductionPilotRoute,
  cancelProductionOnProject,
  findProductionRun,
  haltProduction,
  markProductionCastAndSets,
  markProductionPlanned,
  normalizeProductionPool,
  nextProductionStep,
  projectProductionRuns,
  reconcileProductionSteps,
  remainingProductionGenerations,
  reserveProductionStep,
  resumeProductionOnProject,
  settleProductionStep,
  startProductionOnProject,
  stepForJob,
  stopProductionOnProject,
} from './production.js';
import {
  assertPoolEligible,
  assertRouteAllowed,
  chooseProductionRoute,
  loadPoolEnv,
  poolPricing,
  stepPriceUsd,
  sceneRequirement,
} from './productionPool.js';

// One id per server process: a run records the process that may dispatch for it.
const PROCESS_ID = `proc-${randomUUID()}`;
const MAX_STEPS_PER_ADVANCE = 32;
// The review's revision budget is bounded by the auto-review run's own limit.
const AUTO_REVIEW_MAX_GENERATIONS = 100;
// Refusals that mean "this run cannot continue as configured" — never retried.
const LIMIT_CODES = new Set(['PRODUCTION_SPEND_LIMIT', 'PRODUCTION_BUDGET_EXHAUSTED', 'PRODUCTION_REVIEW_LIMIT']);

const advancing = new Map();
const short = (id) => String(id || '').slice(5, 13);

// Test seam: the heavy collaborators (live settings/catalogs, the queue, the
// generation lanes) are swappable so orchestration is testable with injected
// queue events. Production code never calls the setter.
const defaults = {
  loadEnv: loadPoolEnv,
  resolvePlateReviewer: async (reviewer) => (await import('./plateReview.js')).resolvePlateReviewer(reviewer),
  reviewPlate: async (args) => (await import('./plateReview.js')).reviewPlate(args),
  chooseRoute: chooseProductionRoute,
  dispatch: async (args) => (await import('./productionDispatch.js')).dispatchProductionStep(args),
  queue: async () => import('../mediaJobQueue/index.js'),
  planProject: async (...args) => (await import('./planner.js')).planProject(...args),
  startCastAndSets: async (...args) => (await import('./castAndSetsService.js')).startCastAndSets(...args),
  autoReview: async () => import('./autoReviewService.js'),
  documents: async () => import('./documentGeneration.js'),
  render: async () => import('./render.js'),
  resolveAuthoring: async (input) => {
    if (!input?.providerId || !input?.model) throw new ServerError('Select a code-authoring provider and model', { status: 422, code: 'PRODUCTION_AUTHORING_REQUIRED' });
    const { resolveProviderAndModel } = await import('../promptRunner.js');
    const { provider, selectedModel } = await resolveProviderAndModel(input);
    if (!provider || provider.id !== input?.providerId || provider.enabled === false || !selectedModel || selectedModel !== input?.model) throw new ServerError('The selected code-authoring provider/model is unavailable', { status: 409, code: 'PRODUCTION_AUTHORING_UNAVAILABLE' });
    if (!isToolFreeOneShotProvider(provider)) throw new ServerError('Choose an API or a tool-free headless CLI for code authoring', { status: 422, code: 'PRODUCTION_AUTHORING_UNAVAILABLE' });
    return { providerId: provider.id, model: selectedModel, ...(input.effort ? { effort: input.effort } : {}), costUsd: isFreeProvider(provider) ? 0 : null };
  },
  releaseRevisionSection: async (...args) => (await import('./revisionService.js')).releaseRevisionSection(...args),
};
let deps = { ...defaults };
export function __setProductionDepsForTests(overrides) { deps = { ...defaults, ...overrides }; }
export function __advanceProductionForTests(projectId, runId) { return advanceProduction(projectId, runId); }

async function requireProject(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}

/** Read the newest record at the queue boundary, after provider preparation. */
export async function assertProductionSubmission(projectId, runId, stepKey, input) {
  const project = await requireProject(projectId);
  assertProductionStepOpen(project, runId, stepKey, { ...input, processId: PROCESS_ID });
}

export async function assertProductionContinuation(projectId, runId) {
  const project = await requireProject(projectId);
  const run = assertProductionActive(project, runId, PROCESS_ID);
  if (run.documentCheckpoint && run.documentCheckpoint.directory !== project.composition?.document?.directory) throw new ServerError('The selected document changed since this review began', { status: 409, code: 'COMPOSITION_DRAFT_STALE' });
  return run;
}

export async function chargeProductionReview(projectId, runId, input) {
  await mutateProjectRecord(projectId, (current) => quoteProductionSpend(current, runId, { kind: 'review', costUsd: input.costUsd }));
  return mutateProjectRecord(projectId, (current) => reserveProductionReview(current, runId, { ...input, processId: PROCESS_ID }));
}

async function liveJobs() {
  const { listJobs } = await deps.queue();
  return [...listJobs({ kind: 'image' }), ...listJobs({ kind: 'video' })];
}

/** The run as reported to the director: `interrupted` when a restart unpinned it. */
const present = (run, project) => {
  const counted = run.steps.filter((s) => s.status !== 'refused');
  const reserved = counted.filter((s) => s.status === 'reserved');
  const spent = counted.filter((s) => s.status !== 'reserved');
  const assets = project && codeFirstProductionAssets(project);
  return { ...run, interrupted: run.status === 'running' && run.processId !== PROCESS_ID,
    accounting: {
      plannedGenerations: assets ? assets.steps.filter((s) => ['generate-image', 'generate-video'].includes(s.action)).length
        : (project?.scenes || []).reduce((n, scene) => n + (scene.visualLayer !== 'card' && !scene.referenceImageId && (!scene.videoHistoryId || pilotClass(scene, project) === 'still') ? 1 : 0) + (!scene.videoHistoryId && pilotClass(scene, project) !== 'still' && scene.visualLayer !== 'card' ? 1 : 0), 0),
      reservedUsd: reserved.reduce((n, s) => n + (s.costUsd || 0), 0),
      spentUsd: spent.reduce((n, s) => n + (s.costUsd || 0), 0),
      unpriced: counted.some((s) => s.costUsd == null),
      reviews: counted.filter((s) => s.kind === 'review').length,
    },
    ...(run.pilot ? { pilot: { ...run.pilot, scenes: (run.pilot.scenes || []).map((pilot) => {
      const review = project?.autoReviews?.find((r) => r.id === pilot.reviewRunId);
      const result = review?.attempts?.at(-1)?.review;
      return { ...pilot, status: result ? currentPilotPass(project, pilot) ? 'accepted' : result.verdict : review?.status || 'pending',
        excerptId: review?.attempts?.at(-1)?.excerptId, evidence: result?.evidence || null,
        ...(result && result.verdict !== 'pass' ? { repair: pilotRepair(result, project?.scenes?.find((s) => s.sceneId === pilot.sceneId), project) } : {}) };
    }) } } : {}),
  };
};
const response = (project, run) => {
  const shown = present(run, project);
  return { run: shown, project: { ...project, productionRuns: project.productionRuns.map((r) => r.id === run.id ? shown : r) } };
};

function publish(projectId, project, run, action) {
  const shown = present(run, project);
  musicVideoEvents.emit('production', { projectId, runId: run.id, run: shown, action,
    project: { ...project, productionRuns: project.productionRuns.map((r) => r.id === run.id ? shown : r) } });
}

async function halt(projectId, runId, { status, reason, error = null }) {
  const out = await mutateProjectRecord(projectId, (current) => {
    const run = findProductionRun(current, runId);
    return run.status === 'running' ? haltProduction(current, runId, { status, reason, error }) : { project: current, run };
  });
  const log = status === 'failed' ? console.error : status === 'completed' ? console.log : console.warn;
  log(`${status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏸️'} Music Video production ${short(runId)} ${status}${reason ? `: ${reason}` : ''}`);
  return out;
}

/** Preflight candidates once per run and shot basis; one repair, then a resumable stop. */
async function preflightPlate(projectId, runId, sceneId) {
  const project = await requireProject(projectId);
  const run = assertProductionActive(project, runId, PROCESS_ID);
  const original = project.scenes.find((scene) => scene.sceneId === sceneId);
  const basis = plateRequirementBasis(original);
  const repairSteps = run.steps.filter((step) => step.sceneId === sceneId && step.plateRepairBasis === basis);
  if (repairSteps.some((step) => ['reserved', 'queued'].includes(step.status))) return { ok: false };
  const takes = ensureSceneTakes(original).filter((take) => take.kind === 'image' && take.status !== 'rejected' && take.use !== 'motion-reference')
    .sort((a, b) => Number(b.assetId === original.referenceImageId) - Number(a.assetId === original.referenceImageId));
  let reviewer;
  for (const take of takes) {
    let evidence = currentPlateEvidence(original, take);
    if (evidence?.runId !== runId || (evidence.verdict === 'unverified' && evidence.reviewedAt < run.resumedAt)) evidence = null;
    if (!evidence) {
      const prepared = reviewer || await deps.resolvePlateReviewer(run.reviewer).catch((error) => ({ error }));
      if (prepared.error) return { halt: { status: 'blocked', reason: `Plate review needed: ${prepared.error.message}` } };
      reviewer = prepared;
      const reserved = await mutateProjectRecord(projectId, (current) => {
        const scene = current.scenes.find((entry) => entry.sceneId === sceneId);
        if (plateRequirementBasis(scene) !== basis || scene.referenceImageId !== original.referenceImageId) throw new ServerError('Plate selection or intent changed during preflight', { code: 'PRODUCTION_PLATE_CHANGED' });
        return reserveProductionStep(current, runId, { kind: 'plate', sceneId, route: { kind: 'plate', mode: reviewer.provider.id, model: reviewer.model }, costUsd: reviewer.costUsd, processId: PROCESS_ID });
      }).catch((error) => ({ error }));
      if (reserved.error) return { halt: { status: LIMIT_CODES.has(reserved.error.code) ? 'limit-reached' : 'blocked', reason: `Plate review needed: ${reserved.error.message}` } };
      const verifyCurrent = async (execution) => {
        if (execution?.provider && (execution.provider.id !== reviewer.provider.id || (reviewer.model && execution.model !== reviewer.model))) throw new ServerError('The selected plate reviewer changed before execution', { code: 'PRODUCTION_ROUTE_NOT_ALLOWED' });
        const current = await requireProject(projectId);
        assertProductionStepOpen(current, runId, reserved.step.key, { sceneId, kind: 'plate', processId: PROCESS_ID });
        const scene = current.scenes.find((entry) => entry.sceneId === sceneId);
        if (plateRequirementBasis(scene) !== basis || scene.referenceImageId !== original.referenceImageId
          || !ensureSceneTakes(scene).some((entry) => entry.assetId === take.assetId && entry.status !== 'rejected')) throw new ServerError('Plate changed during preflight', { code: 'PRODUCTION_PLATE_CHANGED' });
      };
      const result = await deps.reviewPlate({ scene: original, assetId: take.assetId, runId, reviewer, beforeExecute: verifyCurrent }).catch((error) => ({ error }));
      await mutateProjectRecord(projectId, (current) => settleProductionStep(current, runId, reserved.step.key, { status: result.error ? 'failed' : 'completed', error: result.error?.message }));
      if (result.error) return { halt: { status: 'blocked', reason: `Plate review needed: ${result.error.message}` } };
      evidence = result;
      const saved = await mutateProjectRecord(projectId, (current) => {
        assertProductionActive(current, runId, PROCESS_ID);
        const scene = current.scenes.find((entry) => entry.sceneId === sceneId);
        if (plateRequirementBasis(scene) !== basis || scene.referenceImageId !== original.referenceImageId) throw new ServerError('Plate changed during review', { code: 'PRODUCTION_PLATE_CHANGED' });
        const sceneTakes = ensureSceneTakes(scene);
        if (!sceneTakes.some((entry) => entry.assetId === take.assetId && entry.status !== 'rejected')) throw new ServerError('Plate was removed or rejected during review', { code: 'PRODUCTION_PLATE_CHANGED' });
        return { project: { ...current, scenes: current.scenes.map((entry) => entry.sceneId === sceneId ? { ...entry, takes: sceneTakes.map((candidate) => candidate.assetId === take.assetId && candidate.kind === 'image' ? { ...candidate, plateEvidence: evidence } : candidate) } : entry) } };
      }).catch((error) => ({ error }));
      if (saved.error) return { halt: { status: 'blocked', reason: `Plate review needed: ${saved.error.message}` } };
    }
    if (evidence.verdict === 'unverified') return { halt: { status: 'blocked', reason: 'Plate review needed: inconclusive evidence. Select or repair a plate, then resume.' } };
    if (evidence.verdict === 'pass') {
      const selected = await mutateProjectRecord(projectId, (current) => {
        assertProductionActive(current, runId, PROCESS_ID);
        const scene = current.scenes.find((entry) => entry.sceneId === sceneId);
        if (plateRequirementBasis(scene) !== basis || scene.referenceImageId !== original.referenceImageId) throw new ServerError('Plate changed before selection', { code: 'PRODUCTION_PLATE_CHANGED' });
        const liveTake = ensureSceneTakes(scene).find((entry) => entry.assetId === take.assetId && entry.kind === 'image');
        if (!liveTake || liveTake.status === 'rejected') throw new ServerError('The qualifying plate was rejected', { code: 'PRODUCTION_PLATE_CHANGED' });
        const out = selectSceneTake(current, sceneId, liveTake.takeId);
        if (!selectedPlatePasses(out.scene, runId)) throw new ServerError('Plate evidence is stale', { code: 'PRODUCTION_PLATE_CHANGED' });
        return out;
      }).catch((error) => ({ error }));
      return selected.error ? { halt: { status: 'blocked', reason: `Plate review needed: ${selected.error.message}` } } : { ok: true };
    }
  }
  if (repairSteps.length) return { halt: { status: 'blocked', reason: 'No plate satisfies the shot requirements after one budgeted repair. Review candidates and resume after a manual correction.' } };
  return { repair: true, basis };
}

// ---- dispatching one generation ----------------------------------------------

/**
 * Choose a pool route for one scene slot, enforce it, reserve the step, and
 * enqueue. Returns `{ ok: true }`, or `{ halt: {status, reason} }` when the
 * run cannot continue as configured, or `{ ok: false }` when the slot is
 * simply busy (another advance got there first).
 */
async function dispatchSlot(projectId, runId, { stepKind, sceneId, revisionId = null, plateRepairBasis = null }) {
  let project = await requireProject(projectId);
  let run = findProductionRun(project, runId);
  let scene = (project.scenes || []).find((s) => s.sceneId === sceneId);
  if (!scene) return { ok: false };
  if (stepKind === 'clip' && scene.direction?.actionContract) {
    const admission = await preflightPlate(projectId, runId, sceneId);
    if (admission.repair) return dispatchSlot(projectId, runId, { stepKind: 'frame', sceneId, plateRepairBasis: admission.basis });
    if (!admission.ok) {
      const current = await requireProject(projectId);
      if (findProductionRun(current, runId).status !== 'running') return { ok: false };
      return admission;
    }
    project = await requireProject(projectId);
    run = findProductionRun(project, runId);
    scene = project.scenes.find((entry) => entry.sceneId === sceneId);
  }
  const requirement = sceneRequirement(project, scene, stepKind);
  const env = await deps.loadEnv();
  const choice = await deps.chooseRoute(run, requirement, env);
  if (!choice?.route) {
    return { halt: { status: 'blocked', reason: `No allowed route can generate the ${stepKind} for "${scene.label || sceneId}": ${(choice?.reasons || []).join('; ')}` } };
  }
  // Enforced for ANY chooser — a model's pick outside the pool never reaches the queue.
  const refused = await assertRouteAllowed(run, choice.route, requirement, env).then(() => null, (err) => err);
  if (refused) return { halt: { status: 'blocked', reason: refused.message } };
  try { assertProductionPilotRoute(project, run, sceneId, stepKind, choice.route); }
  catch (error) { return { halt: { status: 'blocked', reason: error.message } }; }
  const costUsd = stepPriceUsd({ route: choice.route, project, scene, stepKind });
  await mutateProjectRecord(projectId, (current) => quoteProductionSpend(current, runId, { kind: stepKind, sceneId, costUsd }));

  const reserved = await mutateProjectRecord(projectId, (current) => reserveProductionStep(current, runId, {
    kind: stepKind, sceneId, revisionId, plateRepairBasis, route: choice.route, rationale: choice.rationale, processId: PROCESS_ID,
    costUsd: stepPriceUsd({ route: choice.route, project: current, scene: (current.scenes || []).find((s) => s.sceneId === sceneId), stepKind }),
  })).catch((err) => ({ error: err }));
  if (reserved.error) {
    const code = reserved.error.code;
    if (LIMIT_CODES.has(code)) return { halt: { status: 'limit-reached', reason: reserved.error.message } };
    if (code === 'PRODUCTION_STEP_IN_FLIGHT' || code === 'PRODUCTION_NOT_RUNNING' || code === 'PRODUCTION_INTERRUPTED') return { ok: false };
    throw reserved.error;
  }
  const { step } = reserved;
  const tag = { projectId, sceneId, productionRunId: runId, productionStepKey: step.key, ...(revisionId ? { revisionId } : {}) };
  const sent = await deps.dispatch({ stepKind, project: reserved.project, scene: reserved.project.scenes.find((s) => s.sceneId === sceneId), route: choice.route, tag, settings: env.settings })
    .catch((err) => ({ error: err }));
  if (sent.error) {
    await mutateProjectRecord(projectId, (current) => settleProductionStep(current, runId, step.key, { status: 'refused', error: sent.error.message,
      errorCode: sent.error.code || 'PRODUCTION_INVALID_REQUEST',
      // Invalid input/capability refusals cannot heal by repeating the request.
      // Availability and transport errors remain explicitly resumable.
      retryBlocked: [400, 422].includes(sent.error.status) || /(?:UNSUPPORTED|INCAPABLE)$/.test(sent.error.code || ''),
    }));
    if (revisionId) await deps.releaseRevisionSection(projectId, revisionId, sceneId).catch(() => {});
    console.warn(`⚠️ Music Video production ${short(runId)} ${stepKind} for ${sceneId} refused: ${sent.error.message}`);
    return { halt: { status: 'blocked', reason: `The ${stepKind} for "${scene.label || sceneId}" was refused: ${sent.error.message}` } };
  }
  const linked = await mutateProjectRecord(projectId, (current) => settleProductionStep(current, runId, step.key, { status: 'queued', jobId: sent.jobId }));
  console.log(`🎬 Music Video production ${short(runId)} ${stepKind} ${sceneId} → ${choice.route.mode}${choice.route.model ? `/${choice.route.model}` : ''} job ${String(sent.jobId).slice(0, 8)}`);
  // Stopped while this submission was in flight: its job must not run.
  if (linked.run.status !== 'running') await cancelOwnedJobs(runId, { includeRunning: false, jobIds: [sent.jobId] });
  return { ok: true };
}

/** Author only the failed song sections, preserving every approved asset and medium. */
async function authorDocument(projectId, runId, action) {
  const project = await requireProject(projectId);
  const run = assertProductionActive(project, runId, PROCESS_ID);
  const documents = await deps.documents();
  const revise = action.type === 'revise-document';
  const review = revise ? project.autoReviews.find((entry) => entry.id === action.reviewRunId) : null;
  const attempt = review?.attempts?.[review.attempts.length - 1];
  if (revise && (!attempt || attempt.n !== action.attemptN || review.status !== 'running')) return;
  const revisionId = revise ? `${review.id}:${attempt.n}` : null;
  const progress = run.documentRevision?.revisionId === revisionId ? run.documentRevision : null;
  const verifyReviewCurrent = (current, acceptedDirectory = null) => {
    assertProductionActive(current, runId, PROCESS_ID);
    if (!revise) return;
    const liveReview = current.autoReviews.find((entry) => entry.id === review.id);
    if (liveReview?.status !== 'running' || liveReview.attempts.at(-1)?.n !== attempt.n) throw new ServerError('This document review was stopped or changed', { status: 409, code: 'PRODUCTION_STEP_CLOSED' });
    if (current.composition?.document?.directory !== (acceptedDirectory || run.documentCheckpoint?.directory)) throw new ServerError('The reviewed document changed during revision', { status: 409, code: 'COMPOSITION_DRAFT_STALE' });
  };
  const context = revise ? await documents.readMixedMediaCandidate(projectId) : null;
  if (revise && (context.stale || !context.sections.length || context.source?.directory !== (progress?.directory || run.documentCheckpoint?.directory))) throw new ServerError('The reviewed document changed — author and review a fresh candidate', { status: 409, code: 'COMPOSITION_DRAFT_STALE' });
  const findings = attempt?.review?.findings?.filter((finding) => finding.severity === 'blocking') || [];
  const sections = revise ? context.sections.filter((section) => findings.some((finding) => {
    const time = review.startSec + finding.atSec;
    return time >= section.startSec && time < section.endSec;
  })).map((section) => section.id) : [null];
  if (revise && !sections.length) throw new ServerError('The review has no failed document section to revise — inspect the plan', { status: 409, code: 'PRODUCTION_MEDIUM_CONFLICT' });
  if (progress && progress.directory !== (project.composition.documentDraft || project.composition.document)?.directory) throw new ServerError('The revision candidate changed — review the current document', { status: 409, code: 'COMPOSITION_DRAFT_STALE' });
  const completed = new Set(progress?.completed || []);
  let directory = progress?.directory || project.composition.document?.directory || null;
  for (const sectionId of sections) {
    if (completed.has(sectionId)) continue;
    let key = null;
    const sceneId = sectionId || 'document';
    const verifyCurrent = (current) => {
      verifyReviewCurrent(current);
      if (key) assertProductionStepOpen(current, runId, key, { sceneId, kind: 'code', processId: PROCESS_ID });
    };
    const input = {
      ...run.authoring,
      ...(revise ? { expectedDraft: directory, feedback: findings.map((finding) => `${finding.atSec}s: ${finding.note}`).join('\n') } : {}),
      verifyCurrent,
      beforeSubmit: async ({ provider, model }) => {
        if (provider.id !== run.authoring.providerId || model !== run.authoring.model) throw new ServerError('The authoring provider/model changed; no fallback is allowed', { status: 409, code: 'PRODUCTION_AUTHORING_UNAVAILABLE' });
        if (!isToolFreeOneShotProvider(provider)) throw new ServerError('This code authoring provider cannot run without tools', { status: 422, code: 'PRODUCTION_AUTHORING_UNAVAILABLE' });
        const costUsd = isFreeProvider(provider) ? 0 : null;
        const reserved = await mutateProjectRecord(projectId, (current) => {
          verifyCurrent(current);
          return reserveProductionStep(current, runId, { kind: 'author', sceneId, revisionId,
            route: { kind: 'code', mode: provider.id, model }, costUsd,
            rationale: revise ? 'Revise this failed document section without changing the medium plan' : 'Author the approved mixed-media document', processId: PROCESS_ID });
        });
        key = reserved.step.key;
      },
    };
    const result = await (revise ? documents.regenerateMixedMediaSection(projectId, sectionId, input) : documents.generateMixedMediaDocument(projectId, input))
      .catch(async (error) => {
        if (key) await mutateProjectRecord(projectId, (current) => settleProductionStep(current, runId, key, { status: 'failed', error: error.message }));
        throw error;
      });
    directory = result.document.directory;
    completed.add(sectionId);
    await mutateProjectRecord(projectId, (current) => {
      verifyCurrent(current);
      const settled = settleProductionStep(current, runId, key, { status: 'completed' });
      return recordProductionDocumentRevision(settled.project, runId, { revisionId, completed: [...completed], directory });
    });
  }
  await documents.acceptMixedMediaDocument(projectId, directory, { verifyCurrent: verifyReviewCurrent });
  await mutateProjectRecord(projectId, (current) => {
    verifyReviewCurrent(current, directory);
    if (current.composition.document?.directory !== directory) throw new ServerError('The selected document changed', { status: 409, code: 'COMPOSITION_DRAFT_STALE' });
    const attached = attachProductionDocument(current, runId, directory);
    if (!revise) return attached;
    const liveReview = attached.project.autoReviews.find((entry) => entry.id === review.id);
    if (liveReview?.status !== 'running' || liveReview.attempts.at(-1)?.n !== attempt.n) throw new ServerError('The review stopped during authoring', { status: 409, code: 'PRODUCTION_STEP_CLOSED' });
    return { ...attached, project: beginNextAttempt(attached.project, review.id, null).project };
  });
  if (revise) {
    const { resumeAutoReview } = await deps.autoReview();
    await resumeAutoReview(projectId, review.id);
  }
}

// ---- the step loop --------------------------------------------------------------

async function takeSteps(projectId, runId) {
  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i += 1) {
    const project = await requireProject(projectId);
    const run = findProductionRun(project, runId);
    if (run.status !== 'running' || run.processId !== PROCESS_ID) return { project, run, action: { type: 'idle' } };
    const readiness = productionReadiness(project);
    if (!readiness.storyboard.approved) {
      await prepareProductionReview(projectId);
      return halt(projectId, runId, { status: 'blocked', reason: 'Production review needs human approval of the current visual guide and lyric-timed storyboard.' });
    }
    const step = nextProductionStep(project, run, { jobs: await liveJobs(), processId: PROCESS_ID });
    if (!readiness.proof.approved && run.pilot?.scenes?.length
      && run.pilot.scenes.every(pilot => currentPilotPass(project, pilot)) && step.type === 'dispatch') {
      if (productionProofNeedsRender(project, readiness.basis.proof)) {
        const pilot = run.pilot.scenes[0];
        const reviewed = project.autoReviews.find(review => review.id === pilot.reviewRunId);
        await attachProductionPilotProof(projectId, reviewed.attempts.at(-1).excerptId);
      }
      return halt(projectId, runId, { status: 'blocked', reason: 'Watch and approve the rendered pilot in Production review before bulk generation.' });
    }
    if (step.type === 'review' && !readiness.proof.approved) {
      if (productionProofNeedsRender(project, readiness.basis.proof)) {
        await renderProductionProof(projectId, productionProofWindow(project));
      }
      return halt(projectId, runId, { status: 'blocked', reason: 'Watch and approve the animated proof in Production review before the full film.' });
    }


    if (step.type === 'idle' || step.type === 'wait') return { project, run, action: step };
    if (step.type === 'plan-pilots') {
      await mutateProjectRecord(projectId, (current) => planProductionPilots(current, runId));
      continue;
    }

    if (step.type === 'halt') {
      const out = await halt(projectId, runId, { status: step.status, reason: step.reason });
      return { ...out, action: { type: 'idle' } };
    }

    if (step.type === 'cast-and-sets') {
      // Marked first, like the plan: a failed start halts instead of looping.
      await mutateProjectRecord(projectId, (current) => markProductionCastAndSets(current, runId));
      // The reviewer pick steers the direction call only when the brief pins no LLM of its
      // own — a saved brief pin (direction or Cast & Sets stage) is the deliberate choice
      // (castAndSetsService resolves it).
      const briefPinned = project.automation?.llm?.providerId || project.automation?.llmStages?.castAndSets?.providerId;
      const reviewerPin = !briefPinned && run.reviewer?.providerId;
      const started = await deps.startCastAndSets(projectId, {
        productionRunId: runId,
        ...(reviewerPin ? { providerId: run.reviewer.providerId } : {}),
        ...(reviewerPin && run.reviewer?.model ? { model: run.reviewer.model } : {}),
      }).catch((err) => ({ error: err }));
      if (started.error) {
        const out = await halt(projectId, runId, { status: 'blocked', reason: `The Cast & Sets check-in could not start: ${started.error.message}` });
        return { ...out, action: { type: 'idle' } };
      }
      console.log(`🎭 Music Video production ${short(runId)} started the Cast & Sets check-in`);
      continue;
    }

    if (step.type === 'plan') {
      // Marked first: a crash mid-plan must not re-plan (and re-pay) on resume.
      await mutateProjectRecord(projectId, (current) => markProductionPlanned(current, runId));
      const planned = await deps.planProject(projectId, { seedPrompts: true, directive: run.directive }).catch((err) => ({ error: err }));
      if (planned.error) {
        const out = await halt(projectId, runId, { status: 'blocked', reason: `Planning failed: ${planned.error.message}` });
        return { ...out, action: { type: 'idle' } };
      }
      console.log(`🪄 Music Video production ${short(runId)} planned ${planned.scenesAdded} scene(s)`);
      continue;
    }

    if (step.type === 'dispatch') {
      const res = await dispatchSlot(projectId, runId, { stepKind: step.kind, sceneId: step.sceneId });
      if (res.halt) {
        const out = await halt(projectId, runId, res.halt);
        return { ...out, action: { type: 'idle' } };
      }
      if (!res.ok) {
        const fresh = await requireProject(projectId);
        return { project: fresh, run: findProductionRun(fresh, runId), action: { type: 'wait', on: 'generation' } };
      }
      continue;
    }

    if (step.type === 'author-document' || step.type === 'revise-document') {
      const failure = await authorDocument(projectId, runId, step).then(() => null, (error) => error);
      if (failure) {
        const fresh = await requireProject(projectId);
        const active = findProductionRun(fresh, runId);
        if (active.status !== 'running') return { project: fresh, run: active, action: { type: 'idle' } };
        const out = await halt(projectId, runId, { status: LIMIT_CODES.has(failure.code) ? 'limit-reached' : 'blocked', reason: `Document authoring stopped: ${failure.message}` });
        return { ...out, action: { type: 'idle' } };
      }
      continue;
    }

    if (step.type === 'render-document') {
      const attemptId = randomUUID();
      await mutateProjectRecord(projectId, (current) => {
        assertProductionActive(current, runId, PROCESS_ID);
        return setProductionRender(current, runId, { status: 'reserved', jobId: null, attemptId });
      });
      const { renderMusicVideo } = await deps.render();
      const rendered = await renderMusicVideo(projectId, {
        productionRunId: runId,
        productionRenderAttemptId: attemptId,
        verifyCurrent: (current) => {
          const active = assertProductionActive(current, runId, PROCESS_ID);
          if (active.documentCheckpoint?.directory !== current.composition?.document?.directory) throw new ServerError('The reviewed document changed before final render', { status: 409, code: 'COMPOSITION_DRAFT_STALE' });
        },
      }).catch((error) => ({ error }));
      if (rendered.error) {
        await mutateProjectRecord(projectId, (current) => setProductionRender(current, runId, { status: 'failed', jobId: null, attemptId, error: rendered.error.message }));
      } else {
        const out = await mutateProjectRecord(projectId, (current) => setProductionRender(current, runId, { status: 'queued', jobId: rendered.jobId, attemptId }));
        if (out.run.status !== 'running') (await deps.render()).cancelRender(rendered.jobId);
      }
      continue;
    }

    if (step.type === 'review' || step.type === 'pilot-review') {
      const reviewsSpent = run.steps.filter((s) => s.kind === 'review').length;
      if (reviewsSpent >= run.limits.maxReviewAttempts) {
        const out = await halt(projectId, runId, { status: 'limit-reached', reason: 'The production review budget is exhausted; raise it and resume' });
        return { ...out, action: { type: 'idle' } };
      }
      const { startAutoReview } = await deps.autoReview();
      const started = await startAutoReview(projectId, {
        startSec: step.startSec,
        endSec: step.endSec,
        limits: {
          maxAttempts: step.type === 'pilot-review' ? 1 : run.limits.maxReviewAttempts - reviewsSpent,
          maxGenerations: Math.min(AUTO_REVIEW_MAX_GENERATIONS, remainingProductionGenerations(run)),
        },
        reviewer: run.reviewer,
        productionRunId: runId,
        ...(step.type === 'pilot-review' ? { productionPilotSceneId: step.sceneId } : {}),
        ...(run.authoring && step.type !== 'pilot-review' ? { documentRevisions: true } : {}),
      }).catch((err) => ({ error: err }));
      if (started.error) {
        const out = await halt(projectId, runId, { status: 'blocked', reason: `The draft review could not start: ${started.error.message}` });
        return { ...out, action: { type: 'idle' } };
      }
      await mutateProjectRecord(projectId, (current) => step.type === 'pilot-review'
        ? attachProductionPilotReview(current, runId, step.sceneId, started.run.id)
        : attachProductionReview(current, runId, started.run.id));
      console.log(`🔎 Music Video production ${short(runId)} handed the draft [${step.startSec}, ${step.endSec}]s to review ${short(started.run.id)}`);
      continue;
    }
    throw new Error(`Unknown production step ${step.type}`);
  }
  const project = await requireProject(projectId);
  return { project, run: findProductionRun(project, runId), action: { type: 'wait', on: 'step-budget' } };
}

/**
 * Advance a run as far as it can go right now. Concurrent calls for one run
 * coalesce onto the in-flight advance, which then takes one more pass.
 * Returns `{ project, run, action }`.
 */
function advanceProduction(projectId, runId) {
  const live = advancing.get(runId);
  if (live) {
    live.again = true;
    return live.promise;
  }
  const entry = { again: false, promise: null };
  entry.promise = (async () => {
    try {
      let result;
      do {
        entry.again = false;
        result = await takeSteps(projectId, runId);
      } while (entry.again);
      publish(projectId, result.project, result.run, result.action);
      return result;
    } finally {
      advancing.delete(runId);
    }
  })();
  advancing.set(runId, entry);
  return entry.promise;
}

function advanceInBackground(projectId, runId) {
  armJobListeners();
  return advanceProduction(projectId, runId).catch(async (err) => {
    console.error(`❌ Music Video production ${short(runId)} step failed: ${err.message}`);
    await halt(projectId, runId, { status: 'stopped', reason: `A step failed: ${err.message}`, error: err.message })
      .then((out) => publish(projectId, out.project, out.run, { type: 'idle' }))
      .catch(() => {});
  });
}

/** Cancel this run's queued (and optionally running) jobs. Evidence (records, takes, steps) is kept. */
async function cancelOwnedJobs(runId, { includeRunning = false, jobIds = null } = {}) {
  const { cancelJob } = await deps.queue();
  const owned = (await liveJobs()).filter((job) => job.params?.musicVideo?.productionRunId === runId
    && (job.status === 'queued' || (includeRunning && job.status === 'running'))
    && (!jobIds || jobIds.includes(job.id)));
  for (const job of owned) {
    await cancelJob(job.id).catch((err) => console.error(`❌ Music Video production ${short(runId)} could not cancel job ${job.id.slice(0, 8)}: ${err.message}`));
  }
  if (owned.length) console.log(`🛑 Music Video production ${short(runId)} cancelled ${owned.length} job(s)`);
  return owned.map((j) => j.id);
}

// ---- director actions -----------------------------------------------------------

/**
 * Start a run (explicit director request). Every pool route must be eligible
 * now. Returns `{ project, run }`; the run advances in the background.
 */
export async function startProduction(projectId, { directive, pool: requested, limits, reviewer, authoring: requestedAuthoring }) {
  const project = await requireProject(projectId);
  const assets = codeFirstProductionAssets(project);
  const authoring = assets ? await deps.resolveAuthoring(requestedAuthoring) : null;
  const pool = normalizeProductionPool(requested, { allowEmpty: !!assets });
  await assertPoolEligible(pool, await deps.loadEnv());
  // The autopilot cuts on the song (#9290) unless the director chose how it
  // cuts — set before the run captures its creative-setup basis.
  const out = await mutateProjectRecord(projectId, (current) => startProductionOnProject(withAutopilotCutting(current), {
    directive, pool, limits, reviewer, authoring, processId: PROCESS_ID, pricing: poolPricing(pool, current),
  }));
  console.log(`🎬 Music Video production ${short(out.run.id)} started: ${out.run.pool.length} allowed route(s), ≤${out.run.limits.maxGenerations} generations, ≤${out.run.limits.maxReviewAttempts} reviews`);
  advanceInBackground(projectId, out.run.id);
  return response(out.project, out.run);
}

/**
 * Resume a run: settle its steps against the queue, re-pin it to this process
 * (optionally raising limits / accepting a changed creative setup), resume its
 * paused review, and continue. Returns `{ project, run }`.
 */
export async function resumeProduction(projectId, runId, { limits, acceptBasis = false } = {}) {
  const before = await requireProject(projectId);
  const priorReviewId = findProductionRun(before, runId).reviewRunId;
  const jobs = await liveJobs();
  await mutateProjectRecord(projectId, (current) => reconcileProductionSteps(current, runId, jobs));
  const out = await mutateProjectRecord(projectId, (current) => resumeProductionOnProject(current, runId, { limits, acceptBasis, processId: PROCESS_ID }));
  if (priorReviewId && !out.run.reviewRunId) {
    const oldReview = before.autoReviews?.find((entry) => entry.id === priorReviewId);
    if (oldReview && ['running', 'stopped', 'limit-reached'].includes(oldReview.status)) await (await deps.autoReview()).cancelAutoReview(projectId, priorReviewId);
  }
  const owned = new Set([out.run.reviewRunId, ...(out.run.pilot?.scenes || []).map((p) => p.reviewRunId)]);
  for (const review of (out.project.autoReviews || []).filter((r) => owned.has(r.id)
    && ['running', 'stopped', 'limit-reached'].includes(r.status))) {
    const { resumeAutoReview } = await deps.autoReview();
    const headroom = Math.min(AUTO_REVIEW_MAX_GENERATIONS, review.usage.generations + remainingProductionGenerations(out.run));
    await resumeAutoReview(projectId, review.id, {
      limits: {
        maxAttempts: Math.max(review.limits.maxAttempts, out.run.limits.maxReviewAttempts),
        maxGenerations: Math.max(review.limits.maxGenerations, headroom),
      },
    }).catch((err) => console.warn(`⚠️ Music Video production ${short(runId)} could not resume its review: ${err.message}`));
  }
  advanceInBackground(projectId, runId);
  const fresh = await requireProject(projectId);
  return response(fresh, findProductionRun(fresh, runId));
}

/** Stop: nothing new is dispatched and queued owned jobs are cancelled; running ones land. */
export async function stopProduction(projectId, runId) {
  const out = await mutateProjectRecord(projectId, (current) => stopProductionOnProject(current, runId));
  await cancelOwnedJobs(runId);
  const owned = new Set([out.run.reviewRunId, ...(out.run.pilot?.scenes || []).map((p) => p.reviewRunId)]);
  for (const review of (out.project.autoReviews || []).filter((r) => owned.has(r.id) && r.status === 'running')) {
    const { stopAutoReview } = await deps.autoReview();
    await stopAutoReview(projectId, review.id).catch(() => {});
  }
  const fresh = await requireProject(projectId);
  const run = findProductionRun(fresh, runId);
  publish(projectId, fresh, run, { type: 'idle' });
  return response(fresh, run);
}

/** Cancel (terminal): every owned job still live is cancelled, and the review with its revision. */
export async function cancelProduction(projectId, runId) {
  const out = await mutateProjectRecord(projectId, (current) => cancelProductionOnProject(current, runId));
  await cancelOwnedJobs(runId, { includeRunning: true });
  if (out.run.finalRender?.jobId) (await deps.render()).cancelRender(out.run.finalRender.jobId);
  const owned = new Set([out.run.reviewRunId, ...(out.run.pilot?.scenes || []).map((p) => p.reviewRunId)]);
  for (const review of (out.project.autoReviews || []).filter((r) => owned.has(r.id) && ['running', 'stopped', 'limit-reached'].includes(r.status))) {
    const { cancelAutoReview } = await deps.autoReview();
    await cancelAutoReview(projectId, review.id).catch(() => {});
  }
  const fresh = await requireProject(projectId);
  const run = findProductionRun(fresh, runId);
  publish(projectId, fresh, run, { type: 'idle' });
  return response(fresh, run);
}

/** One run as the director sees it (`interrupted` after a restart). */
export async function getProduction(projectId, runId) {
  const project = await requireProject(projectId);
  return { run: present(findProductionRun(project, runId), project) };
}

// ---- completion events of work a run put in flight --------------------------------

const runningHere = (run) => run?.status === 'running' && run.processId === PROCESS_ID;

/** A job this run dispatched ended: settle its step (idempotent), then continue. */
async function onProductionJobEnded(job) {
  const tag = job?.params?.musicVideo;
  if (!tag?.projectId || !tag.productionRunId) return;
  const project = await getProject(tag.projectId);
  const run = project ? projectProductionRuns(project).find((r) => r.id === tag.productionRunId) : null;
  if (!run || !stepForJob(run, job)) return;
  const status = job.status === 'completed' ? 'completed' : job.status === 'canceled' ? 'canceled' : 'failed';
  const out = await mutateProjectRecord(tag.projectId, (current) => {
    const r = findProductionRun(current, tag.productionRunId);
    const step = stepForJob(r, job);
    return step ? settleProductionStep(current, r.id, step.key, { status, jobId: job.id, error: status === 'completed' ? null : (job.error || job.status) }) : { project: current, changed: false };
  });
  if (out.changed && status !== 'completed' && runningHere(out.run)) await advanceProduction(tag.projectId, tag.productionRunId);
}

/**
 * The review run a production owns advanced: dispatch the revised sections it
 * handed out (the board never submits those), or continue when it ended.
 */
async function onOwnedReviewAdvanced({ projectId, run: review, action } = {}) {
  if (!projectId || !review?.productionRunId) return;
  const project = await getProject(projectId);
  const run = project ? projectProductionRuns(project).find((r) => r.id === review.productionRunId) : null;
  if (!runningHere(run)) return;
  if (run.pilot?.scenes?.some((pilot) => pilot.reviewRunId === review.id)) {
    if (review.status !== 'running') await advanceProduction(projectId, run.id);
    return;
  }
  if (run.reviewRunId !== review.id) return;
  if (action?.type === 'revise-document' && run.authoring) {
    await advanceProduction(projectId, run.id);
    return;
  }
  if (action?.type === 'generate' && review.status === 'running' && action.sections?.length) {
    for (const section of action.sections) {
      const stepKind = section.kind === 'image' ? 'frame' : 'clip';
      const res = await dispatchSlot(projectId, run.id, { stepKind, sceneId: section.sceneId, revisionId: action.revisionId });
      if (res.halt) {
        // The revision's claim is released so a resume hands the section out again.
        await deps.releaseRevisionSection(projectId, action.revisionId, section.sceneId).catch(() => {});
        const out = await halt(projectId, run.id, res.halt);
        publish(projectId, out.project, out.run, { type: 'idle' });
        const { stopAutoReview } = await deps.autoReview();
        await stopAutoReview(projectId, review.id).catch(() => {});
        return;
      }
    }
    return;
  }
  if (review.status !== 'running') await advanceProduction(projectId, run.id);
}

/** A take landed on a scene: a running run waiting on generation continues. */
async function onSceneTake({ projectId } = {}) {
  if (!projectId) return;
  const project = await getProject(projectId);
  const run = project ? projectProductionRuns(project).find(runningHere) : null;
  if (run) await advanceProduction(projectId, run.id);
}

const guarded = (label, fn) => (payload) => {
  Promise.resolve().then(() => fn(payload))
    .catch((err) => console.error(`❌ Music Video production could not continue after ${label}: ${err.message}`));
};

musicVideoEvents.on('scene-image', guarded('a frame landed', onSceneTake));
musicVideoEvents.on('scene-video', guarded('a clip landed', onSceneTake));
musicVideoEvents.on('auto-review', guarded('its review advanced', onOwnedReviewAdvanced));

/** The Cast & Sets check-in settled (approved, skipped) or failed: a run waiting on it continues or halts. */
async function onCastAndSetsAdvanced({ projectId, stage } = {}) {
  if (!projectId || !['approved', 'skipped', 'failed'].includes(stage?.status)) return;
  const project = await getProject(projectId);
  const run = project ? projectProductionRuns(project).find(runningHere) : null;
  if (run && !run.planned) await advanceProduction(projectId, run.id);
}
musicVideoEvents.on('cast-and-sets', guarded('its Cast & Sets check-in advanced', onCastAndSetsAdvanced));

// The queue listener is armed on a run's first Start/Resume (never at boot);
// the queue module is deferred because only this path needs it.
let jobListenersArmed = false;
function armJobListeners() {
  if (jobListenersArmed) return;
  jobListenersArmed = true;
  deps.queue().then(({ mediaJobEvents }) => {
    const onEnded = guarded('a job ended', onProductionJobEnded);
    for (const event of ['completed', 'failed', 'canceled']) mediaJobEvents.on(event, onEnded);
  }).catch((err) => {
    jobListenersArmed = false;
    console.error(`❌ Music Video production could not watch generation jobs: ${err.message}`);
  });
}

// Internal final-render event: settle only this run, and never advance a run
// pinned to an older process after a restart.
musicVideoEvents.on('document-render', guarded('its final document rendered', async ({ projectId, runId, jobId, status, error, attemptId }) => {
  if (!projectId || !runId) return;
  const out = await mutateProjectRecord(projectId, (current) => setProductionRender(current, runId, { jobId, status, error, attemptId }));
  if (runningHere(out.run)) await advanceProduction(projectId, runId);
}));
