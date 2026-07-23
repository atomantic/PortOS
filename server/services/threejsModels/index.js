/**
 * Three.js Models orchestration — gallery lineage, provider dispatch, validated
 * procedural scene generation, persistence, retry/refinement, and source export.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, resolveGalleryImage } from '../../lib/fileUtils.js';
import { runPromptThroughProvider } from '../../lib/promptRunner.js';
import { extractJson } from '../../lib/jsonExtract.js';
import { buildThreejsFactorySource, threejsSculptSpecSchema } from '../../lib/threejsModel.js';
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
  sourcePath,
  prompt,
}) {
  try {
    const result = await runPromptThroughProvider({
      provider,
      model: requestedModel || undefined,
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
    prompt: input.prompt,
  });
}

export async function startGeneration(id, {
  providerId,
  model,
  prompt,
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
  const generationPrompt = buildThreejsGenerationPrompt({
    sourcePath,
    name: current.name,
    prompt: effectivePrompt,
    currentSpec: current.spec,
    feedback,
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
          feedback: feedback || null,
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
      sourcePath,
      prompt: generationPrompt,
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
