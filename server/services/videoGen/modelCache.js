/**
 * Video Gen — HuggingFace cache verify/repair engine.
 *
 * Enumerates every weight / text-encoder / IC-LoRA repo a video model needs,
 * keys them, runs shallow and deep integrity verification, and drives repair.
 * No HTTP surface: the video-gen routes are the current callers, but the media
 * job queue and maintenance scripts can reach the same answers without pulling
 * in an Express router.
 *
 * Sits beside runtimes.js / runtimeInstaller.js, which answer the same
 * "is this install ready to render" question from the Python side.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { repoForModel, getTextEncoderRepo, isHfRepoId } from '../../lib/mediaModels.js';
import { IC_LORA_MODE_VALUES, icLoraSpecForMode, icLoraRepos } from '../../lib/icLoraWeights.js';
import { downloadableVideoTextEncoders, downloadableVideoTextEncoder } from '../../lib/videoTextEncoders.js';
import { downloadableVideoDraftDecoders } from '../../lib/videoDraftDecoders.js';
import {
  inspectModelCache, verifyModelCache, repairModelCache,
  verifyCachedRepoFiles, repairCachedRepoFiles, summarizeVerify, aggregateVerifies,
  isSafeHfRepoRelativePath,
} from '../../lib/hfCache.js';
// Through the local facade the routes already use, so a caller that mocks
// `videoGen/local.js` sees one model registry across the route and this module.
import { listVideoModels } from './local.js';

// One definition of "a valid `only` list" for every download target this file
// builds — model repos, their required weights, and the substitutable prompt
// conditioners. `owner` is only used to name the offender in the error, so a
// conditioner entry can pass its own registry id.
const safeOnlyList = (owner, files, label) => {
  const only = Array.isArray(files) ? files.filter((file) => typeof file === 'string' && file.length > 0) : [];
  if (only.some((file) => !isSafeHfRepoRelativePath(file))) {
    throw new ServerError(
      `${owner} has an unsafe ${label} path. Use repo-relative POSIX filenames only.`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  return only;
};

const videoModelLabel = (model) => `Video model "${model?.id}"`;

export const modelDownloadTargets = (model) => {
  const repo = repoForModel(model);
  if (!repo) return [];
  // `repoFiles` narrows the model's OWN repo to an explicit file list, the way
  // `requiredWeights[].files` already does for a secondary repo. It is required
  // — not an optimization — whenever the model's repo is an aggregate that
  // holds more than the one component set the runner loads: MiniMax H3 ships
  // its diffusers layout, a second transformer partition and the original
  // non-diffusers layout in one ~498 GB repo, so the default whole-snapshot
  // target would pull 3.5x what the render path can use. Absent (every other
  // model) still means "snapshot the repo".
  const targets = [{
    repo,
    revision: model?.revision || null,
    only: safeOnlyList(videoModelLabel(model), model?.repoFiles, 'repo-file'),
  }];
  for (const dep of Array.isArray(model?.requiredWeights) ? model.requiredWeights : []) {
    if (typeof dep?.repo !== 'string') continue;
    const only = safeOnlyList(videoModelLabel(model), dep.files, 'required-weight');
    if (only.length > 0) targets.push({ repo: dep.repo, revision: dep.revision || null, only });
  }
  // The model's preview-fidelity decoder (#5423), when it declares one. Scoped
  // to its pinned file for the same reason every other entry here is — and
  // listed under the MODEL rather than as a standalone target, because it is
  // useless without the checkpoint it decodes for, so the download badge that
  // offers it belongs beside that model's own.
  for (const decoder of downloadableVideoDraftDecoders([model])) {
    targets.push({
      repo: decoder.repo,
      revision: decoder.revision || null,
      only: safeOnlyList(`Draft decoder "${decoder.id}"`, decoder.files, 'weight-file'),
    });
  }
  return targets;
};

// One download target per substitutable prompt conditioner. Each names an
// explicit file list inside a repo that holds more than the loader can use —
// quantizations and generation tails in a repack, or the language layers past
// the conditioning depth in an upstream checkpoint — so these are ALWAYS scoped
// to `only: entry.files`. A repo-wide snapshot would pull ~130 GB of unusable
// variants for the repack and ~10 GB of never-built layers for the upstream one.
export const textEncoderDownloadTarget = (entry) => ({
  repo: entry.repo,
  revision: entry.revision || null,
  only: safeOnlyList(`Text encoder "${entry.id}"`, entry.files, 'weight-file'),
});
// Paired with its entry so the status lane can project the registry fields
// (label, size) alongside the cache verdict without a second lookup.
export const textEncoderDownloadTargets = () => downloadableVideoTextEncoders()
  .map((entry) => ({ entry, target: textEncoderDownloadTarget(entry) }));

export const targetKey = (target) => `${target.repo}@${target.revision || 'latest'}::${target.only.join(',')}`;
const targetVerifyOptions = (target, deep) => ({
  deep,
  ...(target.revision ? { revision: target.revision } : {}),
});
export const verifyDownloadTarget = (target, { deep = false } = {}) => target.only.length > 0
  ? verifyCachedRepoFiles(target.repo, target.only, targetVerifyOptions(target, deep))
  : verifyModelCache(target.repo, targetVerifyOptions(target, deep));
export const repairDownloadTarget = (target, { deep = false } = {}) => target.only.length > 0
  ? repairCachedRepoFiles(target.repo, target.only, targetVerifyOptions(target, deep))
  : repairModelCache(target.repo, targetVerifyOptions(target, deep));

// Resolve the repo set an integrity scan should cover. A specific `modelId`
// scopes to that model's repo; no modelId scans every model repo plus the
// shared text encoder.
export const reposToVerify = (modelId) => {
  if (modelId) {
    const m = listVideoModels().find((x) => x.id === modelId);
    return m ? modelDownloadTargets(m) : [];
  }
  const targets = listVideoModels().flatMap(modelDownloadTargets);
  const enc = getTextEncoderRepo();
  if (isHfRepoId(enc)) targets.push({ repo: enc, only: [] });
  // Substitutable prompt conditioners are single pinned files the render path
  // depends on, so an unscoped scan must reach them too — a truncated one
  // otherwise only surfaces as a load failure minutes into a render.
  targets.push(...textEncoderDownloadTargets().map(({ target }) => target));
  // IC-LoRA remix weights are separate HF pulls that the render path depends
  // on, so an unscoped integrity scan must cover them too — otherwise a
  // corrupt IC weight only surfaces as a garbled render.
  targets.push(...icLoraRepos().map((repo) => ({ repo, only: [] })));
  return [...new Map(targets.map((target) => [targetKey(target), target])).values()];
};

// Cache + integrity for one HF repo, in the `{ cached, sizeBytes, integrity }`
// shape every download badge consumes. The integrity check only runs for a repo
// that's actually downloaded — a not-yet-cached repo gets the Download badge,
// not a Repair banner. Shared by all three lanes of /models/status so the
// badge semantics can't drift between models, the encoder, and IC weights.
export const repoCacheStatus = async (repo) => {
  const { cached, sizeBytes } = await inspectModelCache(repo);
  return { cached, sizeBytes, integrity: cached ? summarizeVerify(await verifyModelCache(repo)) : null };
};

// Per-model download status — see /api/image-gen/models/status for the
// shape contract.
export const modelCacheStatus = async (model, cache = null) => {
  const targets = modelDownloadTargets(model);
  if (targets.length === 0) return { repo: null, cached: null, sizeBytes: 0, integrity: null };
  const readTarget = (target) => {
    if (!cache) return verifyDownloadTarget(target);
    const key = targetKey(target);
    if (!cache.has(key)) cache.set(key, verifyDownloadTarget(target));
    return cache.get(key);
  };
  const verifies = await Promise.all(targets.map(readTarget));
  return {
    repo: targets[0].repo,
    requiredRepos: [...new Set(targets.map((target) => target.repo))],
    cached: verifies.every((verify) => verify.status === 'ok'),
    sizeBytes: verifies.reduce((sum, verify) => sum + (verify.sizeBytes || 0), 0),
    integrity: aggregateVerifies(verifies),
  };
};

// Mode → IC-LoRA spec, keyed by the PortOS remix mode ('ic-control', …) the
// client also puts in the render payload.
export const icLoraSpecFromParam = (mode) => {
  const spec = icLoraSpecForMode(mode);
  if (!spec) {
    throw new ServerError(
      `Unknown IC-LoRA remix mode: ${mode} (expected one of ${IC_LORA_MODE_VALUES.join(', ')})`,
      { status: 404, code: 'IC_LORA_UNKNOWN_MODE' },
    );
  }
  return spec;
};

// Registry id → substitutable prompt-conditioner entry (lib/videoTextEncoders.js).
export const textEncoderFromParam = (id) => {
  const entry = downloadableVideoTextEncoder(id);
  if (!entry) {
    const known = downloadableVideoTextEncoders().map((e) => e.id);
    throw new ServerError(
      `Unknown text encoder: ${id}${known.length ? ` (expected one of ${known.join(', ')})` : ''}`,
      { status: 404, code: 'VIDEO_TEXT_ENCODER_UNKNOWN' },
    );
  }
  return entry;
};
