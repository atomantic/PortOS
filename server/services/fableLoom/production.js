/**
 * FableLoom production batch service.
 *
 * Planning is deterministic and side-effect free. A batch run is explicitly
 * started by the user, then advances its dependency graph through the shared
 * media queue. The run registry is intentionally process-local: media jobs
 * remain the durable work records, while this small state machine provides the
 * episode-level grouping, dependency barriers, cancellation, and resume UX.
 */

import { randomInt, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import { resolveImageInputPath } from '../../lib/fileUtils.js';
import { getImageModels, isEditOnly } from '../../lib/mediaModels.js';
import { selectLocalImageModel, resolveLocalImageModel } from '../imageGen/prepareParams.js';
import { readImageSidecar } from '../imageGen/local.js';
import {
  IMAGE_GEN_MODE,
  QUEUEABLE_IMAGE_MODES,
  resolveQueueImageMode,
} from '../imageGen/modes.js';
import { maxInputImages, resolveRenderTargetConfig } from '../imageGen/cloudProviderConfig.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { getSettings } from '../settings.js';
import {
  DEFAULT_NUM_FRAMES,
  defaultVideoModelId,
  listVideoModels,
  resolveVideoModel,
} from '../videoGen/local.js';
import { loadHistory as loadVideoHistory } from '../videoGen/history.js';
import { VIDEO_GEN_MODE, VIDEO_GEN_MODES, resolveVideoMode } from '../videoGen/modes.js';
import {
  compileFableLoomVisualRequest,
  fableLoomImageCapabilities,
  fableLoomVideoCapabilities,
} from './visualConditioning.js';
import { cancelJob, enqueueJob, mediaJobEvents } from '../mediaJobQueue/index.js';
import {
  asFableLoomRenderSettings,
  buildEpisodeProductionPlan,
  exactRenderParameterIssues,
  FABLELOOM_PRODUCTION_MODE_DEFAULT,
  inspectEpisodeProductionOrder,
} from '../../lib/fableLoomProduction.js';
import { analyzeEpisodeContinuity } from '../../lib/fableLoomContinuity.js';
import { analyzeSeriesStoryOutlines } from '../../lib/fableLoomOutline.js';
import { getUniverse } from '../universeBuilder.js';
import { listVoiceProfiles } from '../voice/profiles.js';
import { listLoras } from '../loras.js';
import { getLoom, findEpisode } from './records.js';

const BATCH_RUN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_CONCURRENT_RUNS = 20;
const _batchRuns = new Map();
const _runRuntime = new Map();
const _jobToAsset = new Map();

const TERMINAL_JOB_EVENTS = Object.freeze(['completed', 'failed', 'canceled']);
const ACTIVE_ASSET_STATUSES = new Set(['preparing', 'queued', 'running']);
const EFFECTIVE_PARAMETER_KEYS = Object.freeze([
  'width', 'height', 'numFrames', 'fps', 'steps', 'guidance', 'guidanceScale',
  'seed', 'imageStrength', 'quantize', 'effort', 'mode', 'videoMode',
  'aspectRatio', 'disableAudio', 'tiling',
]);

const nowIso = () => new Date().toISOString();
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const errorMessage = (error) => error?.message || String(error);
const isTerminalRun = (run) => ['completed', 'canceled', 'failed'].includes(run?.status);

function effectiveParameters(params = {}) {
  return Object.fromEntries(EFFECTIVE_PARAMETER_KEYS.flatMap((key) => {
    const value = params[key];
    if (typeof value === 'number' && Number.isFinite(value)) return [[key, value]];
    if (typeof value === 'boolean') return [[key, value]];
    if (typeof value === 'string' && value.trim()) return [[key, value.trim()]];
    return [];
  }));
}

const exactInputError = (message) => new ServerError(message, {
  status: 409,
  code: 'EXACT_INPUTS_REFUSED',
});

function updateSummary(run) {
  const summary = {
    total: run.assets.length,
    pending: 0,
    preparing: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    canceled: 0,
  };
  for (const asset of run.assets) {
    if (summary[asset.status] !== undefined) summary[asset.status] += 1;
  }
  run.summary = summary;
}

function touchRun(run) {
  run.updatedAt = nowIso();
  updateSummary(run);
}

function cleanStaleRuns() {
  const cutoff = Date.now() - BATCH_RUN_MAX_AGE_MS;
  for (const [runId, run] of _batchRuns.entries()) {
    if (!isTerminalRun(run)) continue;
    const updatedAt = Date.parse(run.updatedAt || run.createdAt || '');
    if (Number.isFinite(updatedAt) && updatedAt < cutoff) {
      _batchRuns.delete(runId);
      _runRuntime.delete(runId);
      for (const [jobId, mapping] of _jobToAsset.entries()) {
        if (mapping.runId === runId) _jobToAsset.delete(jobId);
      }
    }
  }
}

function normalizedRenderOptions({ imageMode, imageModel, videoMode, videoModel, effort } = {}) {
  return {
    imageMode: QUEUEABLE_IMAGE_MODES.includes(imageMode) ? imageMode : null,
    imageModel: text(imageModel) || null,
    videoMode: VIDEO_GEN_MODES.includes(videoMode) ? videoMode : null,
    videoModel: text(videoModel) || null,
    effort: text(effort) || null,
  };
}

function renderGeometry(run, recordedConditioning = null) {
  const recorded = exactRenderParameters(run, recordedConditioning);
  return {
    width: Number.isFinite(recorded.width) ? recorded.width : run.render.width,
    height: Number.isFinite(recorded.height) ? recorded.height : run.render.height,
    aspectRatio: text(recorded.aspectRatio) || run.render.aspectRatio,
  };
}

function exactRenderParameters(run, recordedConditioning) {
  if (run.mode !== 'exact_inputs') return {};
  const issues = exactRenderParameterIssues(recordedConditioning);
  if (issues.length) {
    throw exactInputError(`Exact-input reproduction refused: ${issues.join(' ')}`);
  }
  return effectiveParameters(recordedConditioning.render.parameters);
}

const aspectMismatch = (width, height, expectedWidth, expectedHeight) => {
  if (![width, height, expectedWidth, expectedHeight].every((value) => Number.isFinite(value) && value > 0)) {
    return false;
  }
  const actual = width / height;
  const expected = expectedWidth / expectedHeight;
  return Math.abs(actual - expected) / expected > 0.02;
};

async function inspectImageDimensions(asset, node) {
  const filename = asset.existingAssetId;
  const { metadata } = await readImageSidecar(filename);
  if (Number.isFinite(Number(metadata?.width)) && Number.isFinite(Number(metadata?.height))) {
    return { width: Number(metadata.width), height: Number(metadata.height) };
  }
  const manifests = [
    node?.visualConditioning,
    ...Object.values(node?.playbackAssets?.visualConditioningByAsset || {}),
  ];
  const recorded = manifests.find((manifest) => manifest?.capability?.kind === 'image'
    && manifest?.assetId === asset.id)?.render?.parameters;
  return Number.isFinite(recorded?.width) && Number.isFinite(recorded?.height)
    ? { width: recorded.width, height: recorded.height }
    : null;
}

function inspectVideoDimensions(asset, node, historyById) {
  const history = historyById.get(asset.existingAssetId);
  if (Number.isFinite(Number(history?.width)) && Number.isFinite(Number(history?.height))) {
    return { width: Number(history.width), height: Number(history.height) };
  }
  const perAsset = node?.playbackAssets?.visualConditioningByAsset || {};
  const recorded = (perAsset[asset.existingAssetId]
    || perAsset[asset.id]
    || Object.values(perAsset).find((manifest) => manifest?.assetId === asset.id))
    ?.render?.parameters;
  return Number.isFinite(recorded?.width) && Number.isFinite(recorded?.height)
    ? { width: recorded.width, height: recorded.height }
    : null;
}

async function flagRenderFormatMismatches(plan, episode, render) {
  plan.formatMismatches = [];
  if (plan.mode === 'exact_inputs') return plan;
  const nodeById = new Map((episode.nodes || []).map((node) => [node.id, node]));
  const existingAssets = plan.plannedAssets.filter((asset) => asset.existingAssetId
    && (asset.type === 'image' || asset.type.startsWith('video_')));
  const videoAssets = existingAssets.filter((asset) => asset.type.startsWith('video_'));
  const history = videoAssets.length ? await loadVideoHistory() : [];
  const historyById = new Map((Array.isArray(history) ? history : [])
    .filter((item) => item?.id)
    .map((item) => [item.id, item]));
  const inspected = await Promise.all(existingAssets.map(async (asset) => ({
    asset,
    dimensions: asset.type === 'image'
      ? await inspectImageDimensions(asset, nodeById.get(asset.nodeId))
      : inspectVideoDimensions(asset, nodeById.get(asset.nodeId), historyById),
  })));
  const formatMismatches = [];
  const forcedAssetIds = new Set();
  for (const { asset, dimensions } of inspected) {
    if (forcedAssetIds.has(asset.id)) continue;
    if (!dimensions || !aspectMismatch(dimensions.width, dimensions.height, render.width, render.height)) continue;
    const mismatch = {
      assetId: asset.id,
      assetType: asset.type,
      nodeId: asset.nodeId,
      nodeTitle: asset.nodeTitle,
      actualWidth: dimensions.width,
      actualHeight: dimensions.height,
      expectedWidth: render.width,
      expectedHeight: render.height,
      expectedAspectRatio: render.aspectRatio,
    };
    formatMismatches.push(mismatch);
    const relatedAssets = asset.type === 'image'
      ? plan.plannedAssets.filter((candidate) => candidate.nodeId === asset.nodeId
        && (candidate.type === 'image' || candidate.type.startsWith('video_'))
        && candidate.existingAssetId)
      : [asset];
    for (const related of relatedAssets) {
      related.formatMismatch = mismatch;
      if (related.readiness?.ready !== false) related.status = 'ready';
      forcedAssetIds.add(related.id);
    }
  }
  plan.formatMismatches = formatMismatches;
  plan.readyAssetsCount = plan.plannedAssets.filter((asset) => asset.status === 'ready').length;
  plan.alreadyRenderedCount = plan.plannedAssets.filter((asset) => asset.status === 'already_rendered').length;
  plan.skippedAssetsCount = plan.plannedAssets.filter((asset) => asset.status === 'skipped').length;
  plan.blockedAssetsCount = plan.plannedAssets.filter((asset) => asset.status === 'blocked').length;
  plan.isFullyReady = plan.blockedAssetsCount === 0
    && plan.exactInputIssues.length === 0
    && plan.planningIssues.length === 0;
  return plan;
}

function selectAssets(plan, { assetTypes = null, nodeIds = null } = {}) {
  const typeFilter = Array.isArray(assetTypes) && assetTypes.length > 0 ? new Set(assetTypes) : null;
  const nodeFilter = Array.isArray(nodeIds) && nodeIds.length > 0 ? new Set(nodeIds) : null;
  const byId = new Map(plan.plannedAssets.map((asset) => [asset.id, asset]));
  const selected = new Set(plan.plannedAssets
    .filter((asset) => (!typeFilter || typeFilter.has(asset.type))
      && (!nodeFilter || nodeFilter.has(asset.nodeId)))
    .map((asset) => asset.id));

  // A filtered batch must carry the full dependency closure. Selecting only
  // video stills must not enqueue a clip before its scene still exists.
  const visit = (assetId) => {
    const asset = byId.get(assetId);
    if (!asset || selected.has(assetId)) return;
    selected.add(assetId);
    for (const dependencyId of asset.dependencies || []) visit(dependencyId);
  };
  for (const assetId of [...selected]) {
    for (const dependencyId of byId.get(assetId)?.dependencies || []) visit(dependencyId);
  }
  return plan.plannedAssets.filter((asset) => selected.has(asset.id));
}

function assetState(asset) {
  const alreadyRendered = asset.status === 'already_rendered';
  const skipped = asset.status === 'skipped';
  return {
    id: asset.id,
    nodeId: asset.nodeId,
    nodeTitle: asset.nodeTitle,
    type: asset.type,
    role: asset.role || null,
    transitionId: asset.transitionId || null,
    characterId: asset.characterId || null,
    intent: asset.intent || null,
    depth: asset.depth,
    stageIndex: asset.stageIndex,
    prompt: asset.prompt || '',
    cameraMovement: asset.cameraMovement || null,
    temporalSourceNodeId: asset.temporalSourceNodeId || null,
    dependencies: Array.isArray(asset.dependencies) ? [...asset.dependencies] : [],
    existingAssetId: asset.existingAssetId || null,
    readiness: asset.readiness || { ready: false, reasons: [] },
    skipReason: asset.skipReason || null,
    formatMismatch: asset.formatMismatch || null,
    status: alreadyRendered ? 'completed' : skipped ? 'skipped' : 'pending',
    jobId: null,
    provider: null,
    modelId: null,
    modelRevision: null,
    result: alreadyRendered && asset.existingAssetId
      ? { filename: basename(asset.existingAssetId), existing: true }
      : null,
    visualConditioning: null,
    effectiveParameters: null,
    error: null,
  };
}

async function loadRecordedConditioning(run, asset) {
  if (run.mode !== 'exact_inputs') return null;
  const loom = await getLoom(run.loomId);
  const episode = loom?.episodes?.find((item) => item.id === run.episodeId);
  const node = episode?.nodes?.find((item) => item.id === asset.nodeId);
  const perAsset = node?.playbackAssets?.visualConditioningByAsset || {};
  const matched = perAsset[asset.id]
    || Object.values(perAsset).find((manifest) => manifest?.assetId === asset.id)
    || (asset.existingAssetId ? perAsset[asset.existingAssetId] : null);
  return matched || node?.visualConditioning || null;
}

function exactConditioningMismatches(recorded, current) {
  if (!recorded || !current) return ['The recorded visual conditioning could not be reconstructed.'];
  const mismatches = [];
  const recordedCapability = recorded.capability || {};
  const currentCapability = current.capability || {};
  for (const key of ['kind', 'backend', 'modelId', 'modelRevision']) {
    if (recordedCapability[key] != null && recordedCapability[key] !== currentCapability[key]) {
      mismatches.push(`Recorded ${key} "${recordedCapability[key]}" does not match the current compiled value "${currentCapability[key] || 'unknown'}".`);
    }
  }
  for (const key of ['bindings', 'assets', 'adapters', 'temporalSourceNodeId', 'referenceImageStrengths']) {
    if (recorded[key] !== undefined && JSON.stringify(recorded[key]) !== JSON.stringify(current[key])) {
      mismatches.push(`Recorded visual conditioning ${key} changed.`);
    }
  }
  for (const key of ['compiledPrompt', 'compiledNegativePrompt']) {
    if (recorded[key] !== undefined && recorded[key] !== current[key]) {
      mismatches.push(`Recorded ${key} changed.`);
    }
  }
  return mismatches;
}

function assertExactConditioning(recorded, current) {
  const mismatches = exactConditioningMismatches(recorded, current);
  if (mismatches.length) {
    throw exactInputError(`Exact-input reproduction refused: ${mismatches.join(' ')}`);
  }
}

function enrichConditioning(conditioning, job, asset) {
  if (!conditioning) return null;
  return {
    ...conditioning,
    assetId: asset.id,
    render: {
      provider: job.provider,
      modelId: job.modelId || null,
      modelRevision: job.modelRevision || conditioning.capability?.modelRevision || null,
      parameters: effectiveParameters(job.params),
    },
  };
}

function productionTag(run, asset) {
  const tag = {
    loomId: run.loomId,
    episodeId: run.episodeId,
    nodeId: asset.nodeId,
  };
  if (asset.type === 'image') tag.role = 'image';
  if (asset.type !== 'image' && asset.role) tag.role = asset.role;
  if (asset.transitionId) tag.transitionId = asset.transitionId;
  return tag;
}

async function loadRunLoom(run) {
  const loom = await getLoom(run.loomId);
  if (!loom) throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  const outputByNode = new Map(run.assets
    .filter((asset) => asset.type === 'image' && asset.status === 'completed' && asset.result?.filename)
    .map((asset) => [asset.nodeId, asset.result.filename]));
  if (!outputByNode.size) return loom;
  return {
    ...loom,
    episodes: loom.episodes.map((episode) => (episode.id !== run.episodeId ? episode : {
      ...episode,
      nodes: episode.nodes.map((node) => (outputByNode.has(node.id)
        ? { ...node, image: outputByNode.get(node.id) }
        : node)),
    })),
  };
}

function imageInputForNode(run, asset) {
  const imageAsset = run.assets.find((candidate) => candidate.type === 'image' && candidate.nodeId === asset.nodeId);
  return resolveImageInputPath(imageAsset?.result?.filename || null);
}

function requestedImageModel(settings, render, recordedConditioning = null) {
  return recordedConditioning?.capability?.modelId
    || render.imageModel
    || settings.imageGen?.local?.modelId
    || undefined;
}

function resolveImageBackend(settings, render, recordedConditioning = null) {
  const recordedBackend = recordedConditioning?.capability?.backend;
  if (recordedBackend) {
    if (render.imageMode && render.imageMode !== recordedBackend) {
      throw exactInputError(`Exact-input reproduction refuses image backend "${render.imageMode}"; the recorded render used "${recordedBackend}".`);
    }
    if (!QUEUEABLE_IMAGE_MODES.includes(recordedBackend)) {
      throw exactInputError(`Exact-input reproduction cannot replay unsupported image backend "${recordedBackend}".`);
    }
    const resolvedRecorded = resolveQueueImageMode(recordedBackend, settings);
    if (resolvedRecorded !== recordedBackend) {
      const recordedCloud = resolveRenderTargetConfig(settings, RENDER_TARGET.FABLELOOM_PRODUCTION, {
        mode: recordedBackend,
      }).cloud;
      throw exactInputError(recordedCloud?.disabledError?.message
        || `Exact-input reproduction cannot use recorded image backend "${recordedBackend}" on this machine.`);
    }
    return recordedBackend;
  }
  const requested = render.imageMode || (render.imageModel ? IMAGE_GEN_MODE.LOCAL : null);
  const mode = requested ? resolveQueueImageMode(requested, settings) : resolveQueueImageMode(null, settings);
  if (requested && mode !== requested) {
    const requestedCloud = resolveRenderTargetConfig(settings, RENDER_TARGET.FABLELOOM_PRODUCTION, {
      mode: requested,
    }).cloud;
    if (requestedCloud?.disabledError) throw requestedCloud.disabledError;
  }
  return mode;
}

function resolveVideoBackend(settings, render, recordedConditioning = null) {
  const recordedBackend = recordedConditioning?.capability?.backend;
  if (recordedBackend) {
    if (render.videoMode && render.videoMode !== recordedBackend) {
      throw exactInputError(`Exact-input reproduction refuses video backend "${render.videoMode}"; the recorded render used "${recordedBackend}".`);
    }
    if (!VIDEO_GEN_MODES.includes(recordedBackend)) {
      throw exactInputError(`Exact-input reproduction cannot replay unsupported video backend "${recordedBackend}".`);
    }
    const resolvedRecorded = resolveVideoMode(recordedBackend, settings);
    if (resolvedRecorded !== recordedBackend) {
      throw exactInputError(`Exact-input reproduction cannot use recorded video backend "${recordedBackend}" on this machine.`);
    }
    return recordedBackend;
  }
  const requested = render.videoMode;
  const mode = requested ? resolveVideoMode(requested, settings) : resolveVideoMode(null, settings);
  if (requested === VIDEO_GEN_MODE.GROK && mode !== VIDEO_GEN_MODE.GROK) {
    throw new ServerError('Grok video is disabled — enable Grok in Settings → Image Gen first', {
      status: 400,
      code: 'GROK_VIDEO_DISABLED',
    });
  }
  return mode;
}

function conditionRequest(run, asset, kind, capability, sourceImagePath = null) {
  return compileFableLoomVisualRequest({
    tag: productionTag(run, asset),
    kind,
    capability,
    authoredPrompt: asset.prompt,
    sourceImagePath,
    loadLoom: () => loadRunLoom(run),
  });
}

async function prepareImageJob(run, asset) {
  const settings = await getSettings();
  const recordedConditioning = await loadRecordedConditioning(run, asset);
  const mode = resolveImageBackend(settings, run.render, recordedConditioning);
  const allModels = getImageModels();
  const requestedModel = requestedImageModel(settings, run.render, recordedConditioning);
  const provisionalModel = selectLocalImageModel(requestedModel, allModels);
  const cloud = mode === IMAGE_GEN_MODE.LOCAL
    ? null
    : resolveRenderTargetConfig(settings, RENDER_TARGET.FABLELOOM_PRODUCTION, {
      mode,
      model: recordedConditioning?.capability?.modelId
        || (run.render.imageMode === mode ? run.render.imageModel : null),
    }).cloud;
  const capability = fableLoomImageCapabilities({
    mode,
    model: mode === IMAGE_GEN_MODE.LOCAL ? provisionalModel : { id: cloud?.modelId || null },
    inputBudget: maxInputImages(mode) || 4,
  });
  const conditioned = await conditionRequest(run, asset, 'image', capability);
  if (run.mode === 'exact_inputs') assertExactConditioning(recordedConditioning, conditioned?.visualConditioning);
  const referenceImagePaths = conditioned?.referenceImagePaths || [];
  const localInitImagePath = conditioned?.sourceImagePath || referenceImagePaths[0] || null;
  const geometry = renderGeometry(run, recordedConditioning);
  const replayParameters = exactRenderParameters(run, recordedConditioning);

  if (mode === IMAGE_GEN_MODE.LOCAL) {
    const local = resolveLocalImageModel(settings, {
      modelId: requestedModel,
      initImagePath: localInitImagePath,
    });
    if (!local.selectedModel) {
      throw new ServerError('No compatible local image model is available.', {
        status: 409,
        code: 'IMAGE_GEN_UNKNOWN_MODEL',
      });
    }
    const selectedIsEditOnly = isEditOnly(local.selectedModel);
    return {
      kind: 'image',
      provider: mode,
      modelId: local.selectedModel.id,
      modelRevision: local.selectedModel.revision || null,
      params: {
        pythonPath: local.pythonPath,
        prompt: conditioned?.prompt || asset.prompt,
        negativePrompt: conditioned?.negativePrompt || '',
        modelId: local.selectedModel.id,
        width: geometry.width,
        height: geometry.height,
        aspectRatio: geometry.aspectRatio,
        steps: settings.imageGen?.local?.steps ?? local.selectedModel.steps,
        guidance: settings.imageGen?.local?.guidance ?? local.selectedModel.guidance,
        quantize: settings.imageGen?.local?.quantize ?? '8',
        seed: randomInt(0, 2_147_483_647),
        ...replayParameters,
        ...(selectedIsEditOnly && localInitImagePath ? { initImagePath: localInitImagePath } : {}),
        referenceImagePaths: selectedIsEditOnly ? referenceImagePaths.slice(1) : referenceImagePaths,
        referenceImageStrengths: selectedIsEditOnly
          ? (conditioned?.referenceImageStrengths || []).slice(1)
          : (conditioned?.referenceImageStrengths || []),
        loraFilenames: conditioned?.loraFilenames || [],
        loraScales: conditioned?.loraScales || [],
        visualConditioning: conditioned?.visualConditioning || null,
        fableLoom: productionTag(run, asset),
      },
    };
  }

  if (!cloud?.enabled) {
    throw cloud?.disabledError || new ServerError('Image provider is disabled.', {
      status: 400,
      code: 'IMAGE_PROVIDER_DISABLED',
    });
  }
  const providerParams = {
    ...cloud.providerParams,
    ...(mode === IMAGE_GEN_MODE.CODEX && run.render.effort ? { effort: run.render.effort } : {}),
  };
  return {
    kind: 'image',
    provider: mode,
    modelId: cloud.modelId,
    modelRevision: capability.modelRevision || null,
    params: {
      mode,
      ...providerParams,
      prompt: conditioned?.prompt || asset.prompt,
      negativePrompt: conditioned?.negativePrompt || '',
      width: geometry.width,
      height: geometry.height,
      aspectRatio: geometry.aspectRatio,
      ...replayParameters,
      initImagePath: conditioned?.sourceImagePath || null,
      referenceImagePaths,
      referenceImageStrengths: conditioned?.referenceImageStrengths || [],
      loraFilenames: conditioned?.loraFilenames || [],
      loraScales: conditioned?.loraScales || [],
      visualConditioning: conditioned?.visualConditioning || null,
      fableLoom: productionTag(run, asset),
    },
  };
}

async function prepareVideoJob(run, asset) {
  const settings = await getSettings();
  const recordedConditioning = await loadRecordedConditioning(run, asset);
  const backend = resolveVideoBackend(settings, run.render, recordedConditioning);
  const requestedModelId = recordedConditioning?.capability?.modelId
    || run.render.videoModel
    || settings.videoGen?.defaultModelId
    || defaultVideoModelId();
  const model = resolveVideoModel(requestedModelId);
  if (backend === VIDEO_GEN_MODE.LOCAL && !model) {
    throw new ServerError(`Unknown video model: ${requestedModelId}`, {
      status: 400,
      code: 'VIDEO_GEN_UNKNOWN_MODEL',
    });
  }
  const capability = fableLoomVideoCapabilities({
    backend,
    model: backend === VIDEO_GEN_MODE.LOCAL
      ? model
      : { id: 'grok-video', supportedModes: ['image'] },
  });
  const requestedSourceImagePath = imageInputForNode(run, asset);
  const conditioned = await conditionRequest(run, asset, 'video', capability, requestedSourceImagePath);
  if (run.mode === 'exact_inputs') assertExactConditioning(recordedConditioning, conditioned?.visualConditioning);
  const sourceImagePath = conditioned ? conditioned.sourceImagePath : requestedSourceImagePath;
  const geometry = renderGeometry(run, recordedConditioning);
  const replayParameters = exactRenderParameters(run, recordedConditioning);

  if (backend === VIDEO_GEN_MODE.LOCAL) {
    const supportedModes = Array.isArray(model.supportedModes) ? model.supportedModes : [];
    const videoMode = sourceImagePath ? 'image' : 'text';
    if (!supportedModes.includes(videoMode)) {
      throw new ServerError(`Video model "${model.id}" does not support ${videoMode}-to-video renders.`, {
        status: 409,
        code: 'VIDEO_MODEL_UNSUPPORTED_MODE',
      });
    }
    return {
      kind: 'video',
      provider: backend,
      modelId: model.id,
      modelRevision: model.revision || null,
      params: {
        pythonPath: settings.imageGen?.local?.pythonPath || null,
        prompt: conditioned?.prompt || asset.prompt,
        negativePrompt: conditioned?.negativePrompt || '',
        modelId: model.id,
        width: geometry.width,
        height: geometry.height,
        aspectRatio: geometry.aspectRatio,
        numFrames: model.defaultFrames || DEFAULT_NUM_FRAMES,
        fps: model.defaultFps || model.fpsOptions?.[0] || 24,
        steps: model.steps,
        guidanceScale: model.guidance,
        seed: randomInt(0, 2_147_483_647),
        tiling: 'auto',
        disableAudio: false,
        sourceImagePath,
        mode: videoMode,
        ...replayParameters,
        visualConditioning: conditioned?.visualConditioning || null,
        fableLoom: productionTag(run, asset),
      },
    };
  }

  const cloud = resolveRenderTargetConfig(settings, RENDER_TARGET.FABLELOOM_PRODUCTION, {
    mode: IMAGE_GEN_MODE.GROK,
    model: recordedConditioning?.capability?.modelId || null,
  }).cloud;
  if (!cloud?.enabled) {
    throw cloud?.disabledError || new ServerError('Grok video is disabled.', {
      status: 400,
      code: 'GROK_VIDEO_DISABLED',
    });
  }
  return {
    kind: 'video',
    provider: backend,
    modelId: cloud.modelId,
    modelRevision: capability.modelRevision || null,
    params: {
      mode: VIDEO_GEN_MODE.GROK,
      videoMode: sourceImagePath ? 'image' : 'text',
      ...cloud.providerParams,
      prompt: conditioned?.prompt || asset.prompt,
      negativePrompt: conditioned?.negativePrompt || '',
      width: geometry.width,
      height: geometry.height,
      aspectRatio: geometry.aspectRatio,
      ...replayParameters,
      sourceImagePath,
      visualConditioning: conditioned?.visualConditioning || null,
      fableLoom: productionTag(run, asset),
    },
  };
}

async function prepareJob(run, asset) {
  if (asset.type === 'image') return prepareImageJob(run, asset);
  if (asset.type === 'dialogue') return null;
  return prepareVideoJob(run, asset);
}

function failRun(run, error) {
  if (isTerminalRun(run)) return;
  run.status = 'failed';
  run.error = errorMessage(error);
  for (const asset of run.assets) {
    if (asset.status === 'pending' || asset.status === 'preparing') {
      asset.status = 'blocked';
      asset.error = 'Batch stopped before this dependency stage could run.';
    }
  }
  touchRun(run);
}

function scheduleRun(runId, operation) {
  const runtime = _runRuntime.get(runId);
  if (!runtime) return Promise.resolve(null);
  const next = runtime.tail.then(operation);
  const handled = next.catch((error) => {
    const run = _batchRuns.get(runId);
    if (run) failRun(run, error);
    console.error(`❌ FableLoom production batch ${runId.slice(0, 16)} failed: ${errorMessage(error)}`);
    return null;
  });
  runtime.tail = handled;
  return handled;
}

function dependenciesReady(run, asset) {
  const byId = new Map(run.assets.map((candidate) => [candidate.id, candidate]));
  for (const dependencyId of asset.dependencies) {
    const dependency = byId.get(dependencyId);
    if (!dependency) return { ready: false, failed: true, reason: `Missing dependency ${dependencyId}.` };
    if (['failed', 'canceled', 'blocked'].includes(dependency.status)) {
      return { ready: false, failed: true, reason: `Dependency ${dependencyId} did not complete.` };
    }
    if (!['completed', 'skipped'].includes(dependency.status)) return { ready: false, failed: false };
  }
  return { ready: true, failed: false };
}

async function advanceRun(runId) {
  const run = _batchRuns.get(runId);
  if (!run || run.status !== 'in_progress' || run.cancelRequested) return run;
  if (run.assets.some((asset) => ACTIVE_ASSET_STATUSES.has(asset.status))) return run;

  const pending = run.assets.filter((asset) => asset.status === 'pending');
  if (!pending.length) {
    run.status = run.assets.some((asset) => ['failed', 'blocked', 'canceled'].includes(asset.status))
      ? 'failed'
      : 'completed';
    run.error = run.status === 'failed' ? (run.error || 'One or more production assets failed.') : null;
    touchRun(run);
    return run;
  }

  const nextStage = Math.min(...pending.map((asset) => asset.stageIndex ?? 0));
  const stageAssets = pending.filter((asset) => (asset.stageIndex ?? 0) === nextStage);
  const dependencyState = stageAssets.map((asset) => ({ asset, state: dependenciesReady(run, asset) }));
  const blocked = dependencyState.filter(({ state }) => state.failed);
  if (blocked.length) {
    for (const { asset, state } of blocked) {
      asset.status = 'blocked';
      asset.error = state.reason;
    }
    run.status = 'failed';
    run.error = 'A production dependency failed; resume after repairing the failed asset.';
    touchRun(run);
    return run;
  }
  if (dependencyState.some(({ state }) => !state.ready)) return run;

  for (const asset of stageAssets) asset.status = 'preparing';
  touchRun(run);
  const prepared = await Promise.all(stageAssets.map(async (asset) => ({
    asset,
    job: await prepareJob(run, asset),
  })));
  if (run.cancelRequested || run.status !== 'in_progress') return run;

  for (const { asset, job } of prepared) {
    if (!job) {
      asset.status = 'skipped';
      asset.skipReason = asset.skipReason || 'No queue-backed render is required for this asset.';
      continue;
    }
    const visualConditioning = enrichConditioning(job.params.visualConditioning, job, asset);
    if (visualConditioning) job.params.visualConditioning = visualConditioning;
    const enqueued = enqueueJob({
      kind: job.kind,
      params: job.params,
      owner: `fableloom:${run.loomId}:${run.episodeId}:${asset.id}`,
    });
    asset.jobId = enqueued.jobId;
    asset.provider = job.provider || (job.kind === 'image' ? IMAGE_GEN_MODE.LOCAL : VIDEO_GEN_MODE.LOCAL);
    asset.modelId = job.modelId || null;
    asset.modelRevision = job.modelRevision || visualConditioning?.render?.modelRevision || null;
    asset.visualConditioning = visualConditioning;
    asset.effectiveParameters = effectiveParameters(job.params);
    asset.status = 'queued';
    _jobToAsset.set(enqueued.jobId, { runId, assetId: asset.id });
  }
  touchRun(run);
  return run;
}

async function handleJobTerminal(event, job) {
  const mapping = _jobToAsset.get(job?.id);
  if (!mapping) return;
  const run = _batchRuns.get(mapping.runId);
  const asset = run?.assets.find((candidate) => candidate.id === mapping.assetId);
  if (!run || !asset) {
    _jobToAsset.delete(job.id);
    return;
  }
  _jobToAsset.delete(job.id);
  if (event === 'completed') {
    asset.status = 'completed';
    asset.result = job.result || null;
    asset.error = null;
  } else if (event === 'canceled') {
    asset.status = 'canceled';
    asset.error = job.error || 'Media job canceled.';
  } else {
    asset.status = 'failed';
    asset.error = job.error || 'Media job failed.';
    run.error = run.error || asset.error;
  }
  touchRun(run);
  if (run.status === 'in_progress' && event === 'completed') await advanceRun(run.id);
  if (run.status === 'in_progress' && event === 'canceled') {
    run.status = 'canceled';
    run.cancelRequested = true;
    touchRun(run);
  }
  if (run.status === 'in_progress' && event === 'failed') {
    run.status = 'failed';
    for (const pendingAsset of run.assets) {
      if (pendingAsset.status === 'pending' || pendingAsset.status === 'preparing') {
        pendingAsset.status = 'blocked';
        pendingAsset.error = 'Batch stopped after a media job failed.';
      }
    }
    touchRun(run);
  }
}

for (const event of TERMINAL_JOB_EVENTS) {
  mediaJobEvents.on(event, (job) => {
    const mapping = _jobToAsset.get(job?.id);
    if (!mapping) return;
    void scheduleRun(mapping.runId, () => handleJobTerminal(event, job)).catch((error) => {
      console.error(`❌ FableLoom production media event failed: ${errorMessage(error)}`);
    });
  });
}

/** Plan production assets and topological execution for an episode. */
export async function planEpisodeProduction(loomId, episodeId, {
  mode = FABLELOOM_PRODUCTION_MODE_DEFAULT,
  imageMode,
  imageModel,
  videoMode,
  videoModel,
  effort,
} = {}) {
  const loom = await getLoom(loomId);
  if (!loom) throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  const episode = findEpisode(loom, episodeId);
  if (!episode) throw new ServerError('Episode not found', { status: 404, code: 'NOT_FOUND' });
  const [universe, voiceProfiles, loras] = await Promise.all([
    loom.universeId ? getUniverse(loom.universeId) : null,
    listVoiceProfiles(),
    listLoras(),
  ]);
  const plan = buildEpisodeProductionPlan({
    loom,
    episode,
    universe,
    mode,
    localVoiceProfiles: voiceProfiles,
    localLoras: loras,
    availableImageModels: getImageModels(),
    availableVideoModels: listVideoModels(),
    resolveAsset: resolveImageInputPath,
  });
  const render = {
    ...normalizedRenderOptions({ imageMode, imageModel, videoMode, videoModel, effort }),
    ...asFableLoomRenderSettings(loom.renderSettings),
  };
  await flagRenderFormatMismatches(plan, episode, render);
  const episodeOrderReadiness = inspectEpisodeProductionOrder(loom, episode);
  plan.episodeOrderReadiness = episodeOrderReadiness;
  if (!episodeOrderReadiness.ready) {
    plan.planningIssues.push(`Episode order: ${episodeOrderReadiness.reason}`);
  }
  const seriesStoryReadiness = analyzeSeriesStoryOutlines(loom);
  plan.seriesStoryReadiness = seriesStoryReadiness;
  for (const issue of seriesStoryReadiness.issues.filter((candidate) => candidate.severity === 'error')) {
    plan.planningIssues.push(`Story arc: ${issue.message}`);
  }
  const settings = await getSettings();
  if (plan.mode === 'exact_inputs') {
    const exactEnvironmentIssues = new Set();
    for (const node of episode.nodes || []) {
      const manifests = [
        node.visualConditioning,
        ...Object.values(node.playbackAssets?.visualConditioningByAsset || {}),
      ].filter((manifest) => manifest && typeof manifest === 'object');
      for (const manifest of manifests) {
        const capability = manifest.capability || {};
        const key = `${node.id}:${capability.kind || 'media'}:${capability.backend || 'unknown'}:${capability.modelId || 'unknown'}`;
        let issue = null;
        if (capability.kind === 'video') {
          if (!VIDEO_GEN_MODES.includes(capability.backend)) {
            issue = `Recorded visual conditioning names unsupported video backend "${capability.backend || 'unknown'}".`;
          } else if (capability.backend === VIDEO_GEN_MODE.GROK
            && settings.imageGen?.grok?.enabled !== true) {
            issue = 'Recorded visual conditioning requires Grok video, which is disabled in Settings → Image Gen.';
          }
        } else if (!QUEUEABLE_IMAGE_MODES.includes(capability.backend)) {
          issue = `Recorded visual conditioning names unsupported image backend "${capability.backend || 'unknown'}".`;
        } else if (capability.backend !== IMAGE_GEN_MODE.LOCAL) {
          const provider = resolveRenderTargetConfig(settings, RENDER_TARGET.FABLELOOM_PRODUCTION, {
            mode: capability.backend,
          }).cloud;
          if (provider && !provider.enabled) issue = provider.disabledError.message;
        }
        if (issue && !exactEnvironmentIssues.has(`${key}:${issue}`)) {
          exactEnvironmentIssues.add(`${key}:${issue}`);
          plan.exactInputIssues.push({ nodeId: node.id, errors: [issue], warnings: [] });
        }
      }
    }
  }
  if (render.imageMode && render.imageMode !== IMAGE_GEN_MODE.LOCAL) {
    const imageProvider = resolveRenderTargetConfig(settings, RENDER_TARGET.FABLELOOM_PRODUCTION, {
      mode: render.imageMode,
    }).cloud;
    if (imageProvider && !imageProvider.enabled) {
      plan.planningIssues.push(`${render.imageMode} image generation is disabled in Settings → Image Gen.`);
    }
  }
  if (render.imageMode === IMAGE_GEN_MODE.LOCAL || render.imageModel) {
    const imageModelId = render.imageModel || settings.imageGen?.local?.modelId;
    if (imageModelId && !getImageModels().some((model) => model.id === imageModelId)) {
      plan.planningIssues.push(`Image model "${imageModelId}" is not available on this machine.`);
    }
  }
  if (render.videoMode === VIDEO_GEN_MODE.GROK
    && settings.imageGen?.grok?.enabled !== true) {
    plan.planningIssues.push('Grok video is disabled in Settings → Image Gen.');
  }
  if (render.videoMode === VIDEO_GEN_MODE.LOCAL || render.videoModel) {
    const videoModelId = render.videoModel || settings.videoGen?.defaultModelId;
    if (videoModelId && !listVideoModels().some((model) => model.id === videoModelId)) {
      plan.planningIssues.push(`Video model "${videoModelId}" is not available on this machine.`);
    }
  }
  plan.isFullyReady = plan.blockedAssetsCount === 0
    && plan.exactInputIssues.length === 0
    && plan.planningIssues.length === 0;
  return {
    ...plan,
    renderOptions: render,
  };
}

/** Start a user-triggered batch production run. */
export async function startEpisodeProductionBatch(loomId, episodeId, {
  mode = FABLELOOM_PRODUCTION_MODE_DEFAULT,
  assetTypes = null,
  nodeIds = null,
  imageMode,
  imageModel,
  videoMode,
  videoModel,
  effort,
} = {}) {
  cleanStaleRuns();
  const activeRuns = [..._batchRuns.values()].filter((run) => run.status === 'in_progress').length;
  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    throw new ServerError('The maximum number of active production runs is already in progress.', {
      status: 409,
      code: 'PRODUCTION_RUN_LIMIT',
    });
  }

  const requestedRender = normalizedRenderOptions({ imageMode, imageModel, videoMode, videoModel, effort });
  const plan = await planEpisodeProduction(loomId, episodeId, { mode, ...requestedRender });
  const render = plan.renderOptions;
  const targetAssets = selectAssets(plan, { assetTypes, nodeIds });
  const blockedAssets = targetAssets.filter((asset) => asset.status === 'blocked');
  if (blockedAssets.length > 0 || plan.exactInputIssues.length > 0 || plan.planningIssues.length > 0) {
    throw new ServerError(
      plan.mode === 'exact_inputs'
        ? 'Exact-input reproduction refused: recorded assets or revisions are missing or mismatched.'
        : 'Production batch is not ready: resolve the reported asset and continuity blockers first.',
      {
        status: 409,
        code: plan.mode === 'exact_inputs' ? 'EXACT_INPUTS_REFUSED' : 'PRODUCTION_NOT_READY',
        context: {
          details: {
            blockedAssetCount: blockedAssets.length,
            exactInputIssueCount: plan.exactInputIssues.length,
            planningIssueCount: plan.planningIssues.length,
          },
        },
      },
    );
  }

  const runId = `batch-${randomUUID()}`;
  const createdAt = nowIso();
  const run = {
    id: runId,
    loomId,
    episodeId,
    mode: plan.mode,
    status: 'in_progress',
    createdAt,
    updatedAt: createdAt,
    cancelRequested: false,
    error: null,
    render,
    plan: {
      mode: plan.mode,
      totalNodes: plan.totalNodes,
      totalAssets: targetAssets.length,
      executionStages: plan.executionStages
        .map((stage) => ({
          ...stage,
          assetIds: stage.assetIds.filter((assetId) => targetAssets.some((asset) => asset.id === assetId)),
        }))
        .filter((stage) => stage.assetIds.length > 0),
    },
    assets: targetAssets.map(assetState),
    summary: null,
  };
  updateSummary(run);
  _batchRuns.set(runId, run);
  _runRuntime.set(runId, { tail: Promise.resolve() });
  if (run.summary.pending === 0) {
    run.status = run.summary.failed || run.summary.blocked ? 'failed' : 'completed';
    touchRun(run);
  } else {
    void scheduleRun(runId, () => advanceRun(runId));
  }
  return run;
}

/** Get the status of an ongoing or completed batch run. */
export function getEpisodeProductionBatch(runId) {
  if (!runId || typeof runId !== 'string') return null;
  return _batchRuns.get(runId) || null;
}

/** Cancel an in-flight batch run and its queued/running media jobs. */
export async function cancelEpisodeProductionBatch(runId) {
  const run = _batchRuns.get(runId);
  if (!run) throw new ServerError('Batch run not found', { status: 404, code: 'NOT_FOUND' });
  if (run.status !== 'in_progress') return run;
  run.cancelRequested = true;
  const jobIds = run.assets
    .filter((asset) => asset.jobId && ['queued', 'running'].includes(asset.status))
    .map((asset) => asset.jobId);
  await Promise.all(jobIds.map((jobId) => cancelJob(jobId)));
  for (const asset of run.assets) {
    if (asset.status === 'pending' || asset.status === 'preparing'
      || asset.status === 'queued' || asset.status === 'running') {
      asset.status = 'canceled';
      asset.error = 'Canceled by the user.';
    }
  }
  for (const jobId of jobIds) _jobToAsset.delete(jobId);
  run.status = 'canceled';
  touchRun(run);
  return run;
}

/** Resume a failed or canceled run after the user repairs its blockers. */
export function resumeEpisodeProductionBatch(runId) {
  const run = _batchRuns.get(runId);
  if (!run) throw new ServerError('Batch run not found', { status: 404, code: 'NOT_FOUND' });
  if (!['failed', 'canceled'].includes(run.status)) return run;
  for (const asset of run.assets) {
    if (asset.status === 'failed' || asset.status === 'blocked' || asset.status === 'canceled') {
      asset.status = 'pending';
      asset.jobId = null;
      asset.error = null;
    }
  }
  run.status = 'in_progress';
  run.cancelRequested = false;
  run.error = null;
  _runRuntime.set(runId, _runRuntime.get(runId) || { tail: Promise.resolve() });
  touchRun(run);
  void scheduleRun(runId, () => advanceRun(runId));
  return run;
}

/** Perform a user-triggered continuity review across an episode. */
export async function reviewEpisodeContinuity(loomId, episodeId) {
  const loom = await getLoom(loomId);
  if (!loom) throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  const episode = findEpisode(loom, episodeId);
  if (!episode) throw new ServerError('Episode not found', { status: 404, code: 'NOT_FOUND' });
  const [universe, voiceProfiles] = await Promise.all([
    loom.universeId ? getUniverse(loom.universeId) : null,
    listVoiceProfiles(),
  ]);
  return analyzeEpisodeContinuity({
    loom,
    episode,
    universe,
    localVoiceProfiles: voiceProfiles,
  });
}

/** Test-only helper to reset in-memory batch runs. */
export function _resetProductionBatchRuns() {
  _batchRuns.clear();
  _runRuntime.clear();
  _jobToAsset.clear();
}
