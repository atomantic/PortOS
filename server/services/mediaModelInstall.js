/**
 * Add a custom base model (image or video) from a HuggingFace repo (#2124): parse the
 * ref, fetch repo metadata, classify runtime/format, refuse what no runtime can load,
 * append a registry entry and hot-reload the cache. Mirrors services/loras.js
 * installFromHuggingface. Metadata-only: the multi-GB download runs afterwards via the
 * per-model snapshot SSE (hfDownload.js). Errors bubble to middleware (ServerError).
 */

import { fetchHuggingfaceModel, parseHuggingfaceLoraRef } from '../lib/huggingfaceLora.js';
import {
  buildCustomModelEntry,
  classifyHfMediaModel,
} from '../lib/huggingfaceModel.js';
import { addUserModelEntry } from '../lib/mediaModels.js';
import { getHfToken } from './hfToken.js';
import { ServerError } from '../lib/errorHandler.js';

// Add a media model from a HuggingFace repo. `input.url` is any HF ref shape
// (URL or org/name@rev). Optional `kind` ('image'|'video'), `runtime` (video),
// `runner` (image) let the UI correct a mis-detected repo. `name`/`steps`/
// `guidance` override the derived defaults. Returns the new registry entry.
// A stalled Hub would otherwise hold the add request open with no answer.
const METADATA_FETCH_TIMEOUT_MS = 10_000;

export const addModelFromHuggingface = async (input, { fetchImpl = fetch } = {}) => {
  const { repo, revision } = parseHuggingfaceLoraRef(input?.url);
  // Refuse a pinned revision: the registry stores only `repo` and render pulls the
  // default branch, so a pinned classification would silently render different weights.
  // A user needing one can hand-edit media-models.json.
  if (revision) {
    throw new ServerError(
      `HuggingFace repo "${repo}" was given a pinned revision ("${revision}"), which the model download/render paths don't honor — they always use the default branch. Add the repo without a revision (the default branch), or pin the revision by editing data/media-models.json directly.`,
      { status: 422, code: 'HF_REVISION_UNSUPPORTED' },
    );
  }
  // Stored/env/CLI token — needed only for gated repos, harmless on public ones.
  const token = (typeof input?.token === 'string' && input.token.trim()) || (await getHfToken()) || '';
  const model = await fetchHuggingfaceModel(repo, { token, revision, fetchImpl, signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS) });

  // Strict classification (HF_* errors): a repo no runtime can load must never reach the
  // registry, or it would wedge the model picker.
  const classification = classifyHfMediaModel({
    repo,
    model,
    kind: input?.kind,
    runtime: input?.runtime,
    runner: input?.runner,
    // Defaults to the host platform; Windows refuses video adds (its render
    // path can't load a custom repo).
    isWindows: process.platform === 'win32',
  });

  const entry = buildCustomModelEntry({
    repo,
    model,
    classification,
    name: input?.name,
    steps: Number.isFinite(input?.steps) ? input.steps : undefined,
    guidance: Number.isFinite(input?.guidance) ? input.guidance : undefined,
  });

  // Throws MODEL_ALREADY_EXISTS on a duplicate id; persists and hot-reloads the cache.
  addUserModelEntry(entry, { kind: classification.kind });
  console.log(`✅ Added HuggingFace media model: ${entry.id} [${classification.kind}/${classification.runtime || classification.runner}]`);
  return { entry, kind: classification.kind };
};
