/** Inspect, download and repair Video Gen model artifacts and local runtimes. */

import { runtimeQuerySchema } from '../lib/queryValidation.js';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { registerArtifactRoutes } from '../lib/modelArtifactRoutes.js';
import { listVideoModels, BYOV_RUNTIME_INFO, isByovRuntimeReady } from '../services/videoGen/local.js';
import { getTextEncoderRepo, isHfRepoId } from '../lib/mediaModels.js';
import { listIcLoraWeights, icLoraWeightCandidates, findCachedIcLoraWeight, icLoraWeightKey, icLoraProbesExactFile } from '../lib/icLoraWeights.js';
import { publicTextEncoderOption } from '../lib/videoTextEncoders.js';
import { repairModelCache, repairCachedFile, summarizeVerify } from '../lib/hfCache.js';
import {
  modelDownloadTargets, textEncoderDownloadTarget, textEncoderDownloadTargets,
  verifyDownloadTarget, repairDownloadTarget, reposToVerify,
  repoCacheStatus, modelCacheStatus, icLoraSpecFromParam, textEncoderFromParam,
} from '../services/videoGen/modelCache.js';
import { startHfDownloadStream } from '../services/hfDownloadStream.js';
import { openSseStream } from '../lib/sseDownload.js';
import {
  getVideoRuntimeStatus,
  streamVideoRuntimeInstall,
} from '../services/videoGen/runtimeInstaller.js';
import { modelDownloadParamsSchema, icLoraDownloadParamsSchema, textEncoderDownloadParamsSchema } from '../lib/mediaGenerationValidation.js';
import { speedProfileDownloadQuerySchema } from '../lib/videoGenValidation.js';

const router = Router();

// `installed` here means "fully ready to render" — both the venv binary
// exists AND its python packages are importable. The sync existsSync gate
// alone is too permissive: a partial install (clone done, `uv pip install`
// aborted) leaves a venv directory present but no torch, which would
// hide the banner and make every render fail with a deep ImportError.
const sendRuntimeStatus = async (req, res) => {
  const runtime = String(validateRequest(runtimeQuerySchema, req.query).runtime || '');
  res.json(await getVideoRuntimeStatus(runtime));
};

router.get('/setup/runtime-status', asyncHandler(sendRuntimeStatus));

// Backward-compatible read surface for stale clients or status pollers. GET
// never installs; host mutation is restricted to the POST route below.
router.get('/setup/runtime-install', asyncHandler(sendRuntimeStatus));

router.post('/setup/runtime-install', asyncHandler(async (req, res) => {
  const runtime = String(validateRequest(runtimeQuerySchema, req.query).runtime || '');
  const { send, safeEnd } = openSseStream(res);
  await streamVideoRuntimeInstall({
    runtime,
    send,
    safeEnd,
    onDisconnect: (handler) => res.on('close', handler),
    isResponseEnded: () => res.writableEnded,
  });
}));

const sharedTextEncoderCacheStatus = async (repo = getTextEncoderRepo()) => {
  if (!isHfRepoId(repo)) return { repo, cached: true, sizeBytes: 0, integrity: null };
  return { repo, ...await repoCacheStatus(repo) };
};

const textEncoderCacheStatus = async (entry, target = textEncoderDownloadTarget(entry)) => {
  // Through the shared target verifier, so the badge, the integrity scan
  // and the repair route can't drift on how a pinned single-file target is
  // checked.
  const verify = await verifyDownloadTarget(target);
  const cached = verify.status === 'ok';
  return {
    ...publicTextEncoderOption(entry),
    estimatedBytes: entry.sizeBytes,
    cached,
    sizeBytes: verify.sizeBytes || 0,
    // Same rule as repoCacheStatus: a not-yet-downloaded file gets the
    // Download badge, not a Repair banner.
    integrity: cached ? summarizeVerify(verify) : null,
  };
};

const icLoraCacheStatus = async (spec) => {
  // A spec that must be located by its exact file can't use the repo-wide
  // verdict. Two reasons, both fatal to it: a mirrored spec (Ingredients)
  // has a 708 GB aggregate mirror that reports `cached` off any unrelated
  // weight, and a revision-pinned spec would accept a DIFFERENT commit's
  // snapshot. Probe the ONE file across the candidates instead, and skip the
  // integrity walk (which would stat/hash every sibling weight in a mirror).
  if (icLoraProbesExactFile(spec)) {
    const found = await findCachedIcLoraWeight(spec);
    return {
      id: icLoraWeightKey(spec), repo: spec.repo, label: spec.label,
      baseModel: spec.baseModel, revision: spec.revision || null,
      requiresPreDownload: !!spec.requiresPreDownload,
      estimatedBytes: spec.sizeBytes,
      gated: !!spec.gated, mirrorRepo: spec.mirrorRepo || null,
      cached: !!found,
      resolvedRepo: found?.repo || null,
      // The badge falls back to `estimatedBytes` when sizeBytes is 0, and the
      // real number would cost a stat on a path we already proved resident —
      // so report 0 and let the estimate speak.
      sizeBytes: 0,
      integrity: null,
    };
  }
  return {
    id: icLoraWeightKey(spec), repo: spec.repo, label: spec.label,
    baseModel: spec.baseModel, revision: spec.revision || null,
    requiresPreDownload: !!spec.requiresPreDownload,
    estimatedBytes: spec.sizeBytes,
    gated: !!spec.gated,
    ...await repoCacheStatus(spec.repo),
  };
};

router.get('/models/status', asyncHandler(async (_req, res) => {
  // Text encoder is shared across all video renders. A registry entry with
  // `localPath` (e.g. an LM Studio install) trumps the HF cache check, so
  // surface both the repo-cache status and the resolved local path so the UI
  // can distinguish "not downloaded" from "served from LM Studio".
  const verifyCache = new Map();
  const [models, textEncoder, textEncoderOptions, icLoras] = await Promise.all([
    Promise.all(listVideoModels().map(async (m) => {
      return { id: m.id, ...await modelCacheStatus(m, verifyCache) };
    })),
    sharedTextEncoderCacheStatus(),
    // Substitutable prompt conditioners (lib/videoTextEncoders.js) — the same
    // `{ id, repo, cached, sizeBytes, integrity }` badge shape as the models and
    // the IC weights, so the video form renders their Download button and
    // Repair banner with the existing components. Scoped to the ONE pinned file
    // (never the repo) for the reason in textEncoderDownloadTargets.
    Promise.all(textEncoderDownloadTargets().map(({ entry, target }) => textEncoderCacheStatus(entry, target))),
    // IC-LoRA weights (issue #3100). Each is a separate several-hundred-MB pull,
    // so they get the same cached/size/integrity shape as the models — that's
    // what lets the mode panel render a Download badge and a Repair banner with
    // the existing components. This is the PROVISIONING list, so it spans weights
    // that are not remix modes (the LTX-2.5 upscale adapter, #6502) and reports
    // each by its `icLoraWeightKey` rather than assuming a `mode` value exists.
    Promise.all(listIcLoraWeights().map(icLoraCacheStatus)),
  ]);
  res.json({ models, textEncoder, textEncoderOptions, icLoras });
}));

const videoModelFromId = (modelId) => {
  const model = listVideoModels().find((entry) => entry.id === modelId);
  if (!model) throw new ServerError(`Unknown video model: ${modelId}`, { status: 404, code: 'UNKNOWN_MODEL' });
  return model;
};

const requireVideoModelTargets = (model, targets) => {
  if (targets.length === 0) {
    throw new ServerError(`Model "${model.id}" has no HuggingFace repo on file.`, { status: 400, code: 'NO_REPO_FOR_MODEL' });
  }
  return targets;
};

registerArtifactRoutes(router, {
  mount: (router, { status, download, repair, verify }) => {
    router.post('/models/verify', verify);
    router.post('/models/:modelId/repair', repair);
    router.get('/models/:modelId/download', status);
    router.post('/models/:modelId/download', download);
  },
  paramsSchema: modelDownloadParamsSchema,
  downloadQuerySchema: speedProfileDownloadQuerySchema,
  resolve: ({ modelId }) => videoModelFromId(modelId),
  status: async (model) => ({ id: model.id, ...await modelCacheStatus(model) }),
  download: async (model, { speedProfileId, ...stream }) => {
    const repos = requireVideoModelTargets(model, modelDownloadTargets(model, { speedProfileId }));
    const runtimeInfo = BYOV_RUNTIME_INFO[model.runtime];
    const pythonPath = runtimeInfo?.hfDownloadPython !== false
      && await isByovRuntimeReady(model.runtime)
      ? runtimeInfo.venvPython
      : null;
    await startHfDownloadStream({ ...stream, repos, pythonPath });
  },
  repair: async (model, { deep }) => {
    const repos = requireVideoModelTargets(model, reposToVerify(model.id));
    const repaired = await Promise.all(repos.map((target) => repairDownloadTarget(target, { deep })));
    const deleted = repaired.flatMap((r) => r.deleted.map((name) => ({ repo: r.repoId, name })));
    return { deleted, repos: [...new Set(repos.map((target) => target.repo))] };
  },
  verify: async ({ modelId, deep }) => {
    const repos = reposToVerify(modelId);
    if (modelId && repos.length === 0) {
      throw new ServerError(`Unknown video model: ${modelId}`, { status: 404, code: 'UNKNOWN_MODEL' });
    }
    const results = await Promise.all(repos.map((target) => verifyDownloadTarget(target, { deep })));
    return results.map((r) => ({ repo: r.repoId, ...summarizeVerify(r) }));
  },
});

// Remix weights are keyed by mode. Exact-file specs try the official repo then
// the mirror, pinning both filename and any revision. A snapshot of the gated
// Ingredients repo can fail, and its aggregate mirror can fill the user's disk.
registerArtifactRoutes(router, {
  mount: (router, { status, download, repair }) => {
    router.get('/ic-loras/:mode/download', status);
    router.post('/ic-loras/:mode/download', download);
    router.post('/ic-loras/:mode/repair', repair);
  },
  paramsSchema: icLoraDownloadParamsSchema,
  resolve: ({ mode }) => icLoraSpecFromParam(mode),
  status: icLoraCacheStatus,
  download: (spec, stream) => {
    if (!icLoraProbesExactFile(spec)) return startHfDownloadStream({ ...stream, repo: spec.repo });
    return startHfDownloadStream({
      ...stream,
      fallbacks: icLoraWeightCandidates(spec)
        .map((c) => ({ repo: c.repo, only: [c.filename], revision: c.revision })),
      // An unrelated weight in the aggregate mirror can make the repo look cached.
      cachedFile: async () => !!(await findCachedIcLoraWeight(spec)),
    });
  },
  repair: async (spec, { deep }) => {
    // Repo-wide repair would touch unrelated weights in an aggregate mirror.
    if (icLoraProbesExactFile(spec)) {
      const found = await findCachedIcLoraWeight(spec);
      if (!found) return { deleted: [], repos: [spec.repo] };
      await repairCachedFile(found.path);
      return { deleted: [{ repo: found.repo, name: found.filename }], repos: [found.repo] };
    }
    const result = await repairModelCache(spec.repo, { deep });
    return { deleted: result.deleted.map((name) => ({ repo: result.repoId, name })), repos: [spec.repo] };
  },
});

// Per-render text encoder alternatives only need the files pinned in the
// registry. The shared LTX encoder below is selected once for the install.
registerArtifactRoutes(router, {
  mount: (router, { status, download, repair }) => {
    router.get('/text-encoders/:id/download', status);
    router.post('/text-encoders/:id/download', download);
    router.post('/text-encoders/:id/repair', repair);
  },
  paramsSchema: textEncoderDownloadParamsSchema,
  resolve: ({ id }) => textEncoderFromParam(id),
  status: textEncoderCacheStatus,
  download: (entry, stream) => startHfDownloadStream({ ...stream, repos: [textEncoderDownloadTarget(entry)] }),
  repair: async (entry, { deep }) => {
    const result = await repairDownloadTarget(textEncoderDownloadTarget(entry), { deep });
    return { deleted: result.deleted.map((name) => ({ repo: entry.repo, name })), repos: [entry.repo] };
  },
});

const downloadableTextEncoderRepo = () => {
  const repo = getTextEncoderRepo();
  if (!isHfRepoId(repo)) {
    throw new ServerError('Active text encoder is a local-path entry, not an HF repo.', { status: 400, code: 'NOT_DOWNLOADABLE' });
  }
  return repo;
};

registerArtifactRoutes(router, {
  mount: (router, { status, download, repair }) => {
    router.post('/text-encoder/repair', repair);
    router.get('/text-encoder/download', status);
    router.post('/text-encoder/download', download);
  },
  // A local-path encoder is available for rendering but has no HF cache to modify.
  resolve: downloadableTextEncoderRepo,
  status: sharedTextEncoderCacheStatus,
  resolveStatus: () => getTextEncoderRepo(),
  download: (repo, stream) => startHfDownloadStream({ ...stream, repo }),
  repair: async (repo, { deep }) => {
    const result = await repairModelCache(repo, { deep });
    return { deleted: result.deleted.map((name) => ({ repo: result.repoId, name })), repos: [repo] };
  },
});

export default router;
