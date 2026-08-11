/**
 * Three.js Models orchestration — gallery lineage, provider dispatch, validated
 * procedural scene generation, persistence, retry/refinement, and source export.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, resolveGalleryImage } from '../../lib/fileUtils.js';
import { runPromptThroughProvider } from '../../lib/promptRunner.js';
import { extractJson } from '../../lib/jsonExtract.js';
import {
  buildThreejsFactorySource,
  buildThreejsFlatnessFeedback,
  evaluateThreejsFlatness,
  threejsSculptSpecSchema,
} from '../../lib/threejsModel.js';
import { buildThreejsCoverageFeedback, evaluateThreejsPartCoverage } from '../../lib/threejsModelCoverage.js';
import { buildThreejsPenetrationFeedback, evaluateThreejsPenetration } from '../../lib/threejsModelPenetration.js';
import { evaluateThreejsRigReadiness } from '../../lib/threejsModelRig.js';
import { GENERAL_FAMILY_ID } from '../../lib/threejsModelFamilies.js';
import { resolveCliEffort } from '../../lib/providerModels.js';
import { getProviderById } from '../providers.js';
import { buildThreejsGenerationPrompt } from './prompt.js';
import * as store from './db.js';

const MAX_RUNS = 30;
const SUPPORTED_PROVIDER_TYPES = new Set(['api', 'cli', 'tui']);
const activeOperations = new Set();

const trimRuns = (runs) => runs.slice(-MAX_RUNS);
const cleanError = (error) => String(error?.message || error || 'Generation failed').slice(0, 2_000);

async function resolveProvider(providerId) {
  const provider = await getProviderById(providerId);
  if (!provider || provider.enabled === false) {
    throw new ServerError('Choose an enabled AI provider', { status: 400, code: 'PROVIDER_UNAVAILABLE' });
  }
  if (!SUPPORTED_PROVIDER_TYPES.has(provider.type)) {
    throw new ServerError(`Provider ${provider.name || provider.id} cannot generate a Three.js model`, {
      status: 400,
      code: 'PROVIDER_TYPE_UNSUPPORTED',
    });
  }
  return provider;
}

function updateRun(runs, operationId, patch) {
  return trimRuns((Array.isArray(runs) ? runs : []).map((run) => (
    run.operationId === operationId ? { ...run, ...patch } : run
  )));
}

async function failGeneration(id, operationId, error) {
  const message = cleanError(error);
  await store.mutateModel(id, (current) => {
    if (current.generationOperationId !== operationId) return null;
    return {
      ...current,
      status: 'failed',
      error: message,
      generationOperationId: null,
      runs: updateRun(current.runs, operationId, {
        status: 'failed',
        error: message,
        completedAt: new Date().toISOString(),
      }),
    };
  }).catch((persistError) => {
    console.error(`❌ Three.js model ${id} failure could not be persisted: ${persistError.message}`);
  });
}

async function executeGeneration({
  id,
  operationId,
  provider,
  requestedModel,
  requestedEffort,
  sourcePath,
  prompt,
  family,
}) {
  try {
    const result = await runPromptThroughProvider({
      provider,
      model: requestedModel || undefined,
      // No-op for API providers and for CLI/TUI providers with no effort
      // control — runPromptThroughProvider clamps/drops it per provider.
      effort: requestedEffort || undefined,
      prompt,
      source: 'threejs-model-generation',
      // CLI/TUI agents only need the gallery image and JSON contract. Keep
      // their working directory in runtime data so a generation request cannot
      // accidentally turn into a source-code editing session.
      cwd: PATHS.data,
      screenshots: provider.type === 'api' ? [sourcePath] : [],
      responseSchema: threejsSculptSpecSchema,
      timeout: Math.max(provider.timeout || 0, 10 * 60 * 1000),
    });
    const extracted = extractJson(result.text, {
      skipInnerFence: true,
      shapePredicate: (value) => threejsSculptSpecSchema.safeParse(value).success,
    });
    const spec = threejsSculptSpecSchema.parse(extracted.value);
    // A structural miss is not a parse failure — a spec that promises more than
    // it builds is still a usable generation, so the gate is recorded on the
    // record and surfaced as refinement feedback rather than thrown away.
    const coverage = evaluateThreejsPartCoverage(spec, { family });
    // Likewise for a spec that builds everything it promised out of slabs: it
    // renders correctly from the generated camera, so it is recorded rather than
    // rejected — the user sees it and an unsteered refinement asks for depth.
    const flatness = evaluateThreejsFlatness(spec);
    // And likewise for a spec whose parts are modelled inside each other: it
    // still renders, and from the hero angle it still looks right, so the
    // finding is recorded and fed back rather than thrown away.
    const penetration = evaluateThreejsPenetration(spec);
    // Nothing PortOS generates is skinned, so what gets recorded is whether the
    // spec declared an articulation graph a later rig path could attach to — and
    // when it did not, the reason. A model with no graph reports not-ready with
    // reasons rather than passing silently.
    const rig = evaluateThreejsRigReadiness(spec);
    const completedAt = new Date().toISOString();
    const effectiveProvider = result.provider?.id || result.fallbackProvider?.id || provider.id;
    const effectiveModel = result.model || requestedModel || provider.defaultModel || null;

    await store.mutateModel(id, (current) => {
      if (current.generationOperationId !== operationId) return null;
      return {
        ...current,
        providerId: effectiveProvider,
        model: effectiveModel,
        status: 'ready',
        spec,
        coverage,
        flatness,
        penetration,
        rig,
        error: null,
        generationOperationId: null,
        generatedAt: completedAt,
        runs: updateRun(current.runs, operationId, {
          status: 'completed',
          runId: result.runId,
          providerId: effectiveProvider,
          model: effectiveModel,
          completedAt,
        }),
      };
    });
    console.log(`🧊 Three.js model ready: ${id} (${effectiveProvider}/${effectiveModel || 'default'})`);
    if (coverage.errorCount > 0) {
      console.warn(`⚠️ Three.js model ${id} assembly coverage: ${coverage.errorCount} error, ${coverage.warningCount} warning finding(s)`);
    }
    if (flatness.warningCount > 0) {
      console.warn(`⚠️ Three.js model ${id} cross-section: ${flatness.flatIdentityDetailCount}/${flatness.identityDetailCount} identity feature(s) built only from flat parts`);
    }
    if (penetration.errorCount > 0 || penetration.warningCount > 0) {
      console.warn(`⚠️ Three.js model ${id} cross-part penetration: ${penetration.errorCount} error, ${penetration.warningCount} warning finding(s) over ${penetration.comparedPairCount} compared pair(s)`);
    }
    if (rig.articulationReady) {
      console.log(`🦴 Three.js model ${id} declares an articulation graph: ${rig.jointCount} joint(s), ${rig.socketCount} pivot socket(s)`);
    }
  } catch (error) {
    console.error(`❌ Three.js model generation failed for ${id}: ${cleanError(error)}`);
    await failGeneration(id, operationId, error);
  } finally {
    activeOperations.delete(operationId);
  }
}

export const listModels = store.listModels;
export const getModel = store.getModel;
export const deleteModel = store.deleteModel;

export async function createModel(input) {
  const sourcePath = resolveGalleryImage(input.filename);
  if (!sourcePath) {
    throw new ServerError('Gallery image not found', { status: 400, code: 'GALLERY_IMAGE_NOT_FOUND' });
  }
  await resolveProvider(input.providerId);
  const created = await store.createModel(input);
  return startGeneration(created.id, {
    providerId: input.providerId,
    model: input.model,
    effort: input.effort,
    prompt: input.prompt,
    family: input.family,
  });
}

export async function startGeneration(id, {
  providerId,
  model,
  effort,
  prompt,
  family,
  feedback = '',
} = {}) {
  const current = await store.getModel(id);
  if (!current) throw new ServerError('Three.js model not found', { status: 404, code: 'NOT_FOUND' });
  if (current.status === 'generating' || (current.generationOperationId && activeOperations.has(current.generationOperationId))) {
    throw new ServerError('This model is already generating', { status: 409, code: 'MODEL_BUSY' });
  }

  const effectiveProviderId = providerId || current.providerId;
  const provider = await resolveProvider(effectiveProviderId);
  const sourcePath = resolveGalleryImage(current.sourceImage?.filename);
  if (!sourcePath) {
    throw new ServerError('The source gallery image is no longer available', { status: 409, code: 'GALLERY_IMAGE_NOT_FOUND' });
  }

  const operationId = randomUUID();
  const startedAt = new Date().toISOString();
  const effectivePrompt = prompt ?? current.prompt ?? '';
  // A refinement the user did not steer aims at what the last pass measurably
  // got wrong — the promises it did not build, the identity parts it built
  // without a cross-section, and the parts it modelled inside each other —
  // instead of a generic "improve it". All are sent when all fired: they are
  // independent defects with independent remedies.
  const effectiveFeedback = (feedback || '').trim() || [
    buildThreejsCoverageFeedback(current.coverage),
    buildThreejsFlatnessFeedback(current.flatness),
    buildThreejsPenetrationFeedback(current.penetration),
  ].filter(Boolean).join('\n\n');
  // Absent (`undefined`) keeps whatever the record already had; an explicit
  // `null` — what the picker's "Default effort" choice sends — clears it.
  const requestedEffort = effort === undefined ? (current.effort || null) : (effort || null);
  // Persist what will ACTUALLY run, not what was asked for. The picker hides the
  // effort control for a provider/model with no tiers but keeps its last value,
  // so an unhonored level would otherwise be stored and rendered ("high effort")
  // for a run that never used one — with no way to clear it. resolveCliEffort
  // returns null for API/effort-less providers and clamps an out-of-range level
  // to the tier the chosen model really has, matching the CLI arg builders.
  const effectiveEffort = resolveCliEffort(requestedEffort, provider, model || provider.defaultModel || null);
  // Absent keeps the record's stored family; the picker's "General" choice sends
  // the explicit `general` id, which is a real value rather than a clear — it is
  // how the user turns a checklist back OFF for the next pass.
  const effectiveFamily = family === undefined
    ? (current.family || GENERAL_FAMILY_ID)
    : (family || GENERAL_FAMILY_ID);
  const generationPrompt = buildThreejsGenerationPrompt({
    sourcePath,
    name: current.name,
    prompt: effectivePrompt,
    currentSpec: current.spec,
    feedback: effectiveFeedback,
    family: effectiveFamily,
  });
  const next = await store.mutateModel(id, (fresh) => {
    if (fresh.status === 'generating') {
      throw new ServerError('This model is already generating', { status: 409, code: 'MODEL_BUSY' });
    }
    return {
      ...fresh,
      prompt: effectivePrompt,
      providerId: provider.id,
      model: model || provider.defaultModel || null,
      effort: effectiveEffort,
      family: effectiveFamily,
      status: 'generating',
      error: null,
      generationOperationId: operationId,
      runs: trimRuns([
        ...(Array.isArray(fresh.runs) ? fresh.runs : []),
        {
          operationId,
          status: 'running',
          providerId: provider.id,
          model: model || provider.defaultModel || null,
          effort: effectiveEffort,
          family: effectiveFamily,
          feedback: effectiveFeedback || null,
          startedAt,
          completedAt: null,
          runId: null,
          error: null,
        },
      ]),
    };
  });

  activeOperations.add(operationId);
  setImmediate(() => {
    void executeGeneration({
      id,
      operationId,
      provider,
      requestedModel: model,
      requestedEffort: effectiveEffort,
      sourcePath,
      prompt: generationPrompt,
      family: effectiveFamily,
    });
  });
  return next;
}

export async function getModelSource(id) {
  const model = await store.getModel(id);
  if (!model) throw new ServerError('Three.js model not found', { status: 404, code: 'NOT_FOUND' });
  if (!model.spec) {
    throw new ServerError('This model does not have a generated scene yet', { status: 409, code: 'MODEL_NOT_READY' });
  }
  return {
    filename: `${model.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'procedural-model'}.js`,
    source: buildThreejsFactorySource(model.spec),
  };
}

export async function recoverInterruptedModels() {
  const result = await store.recoverInterruptedModels();
  if (result.recovered > 0) {
    console.log(`🧊 Recovered ${result.recovered} interrupted Three.js model generation(s)`);
  }
  return result;
}
