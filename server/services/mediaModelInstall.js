/**
 * Add a custom base model (image or video) from a HuggingFace repo — the
 * self-service analogue of hand-editing data/media-models.json + restarting
 * (issue #2124). Mirrors the LoRA installer's structure (services/loras.js
 * installFromHuggingface): parse the ref → fetch repo metadata → classify the
 * runtime/format → refuse anything no runtime can load → append a registry
 * entry and hot-reload the boot-only cache.
 *
 * The actual multi-GB weight download is NOT done here: base models are
 * multi-file repos, so the existing per-model snapshot download SSE
 * (GET /api/{image,video}-gen/models/:id/download, backed by hfDownload.js)
 * handles the pull with progress once the entry exists. This endpoint is
 * metadata-only and returns fast, exactly like adding a row and letting the
 * download badge take over.
 *
 * No try/catch — errors bubble to centralized middleware; domain errors throw
 * ServerError.
 */

import { fetchHuggingfaceModel, parseHuggingfaceLoraRef } from '../lib/huggingfaceLora.js';
import {
  buildCustomModelEntry,
  classifyHfMediaModel,
} from '../lib/huggingfaceModel.js';
import { addUserModelEntry } from '../lib/mediaModels.js';
import { getHfToken } from '../lib/hfToken.js';
import { ServerError } from '../lib/errorHandler.js';

// Add a media model from a HuggingFace repo. `input.url` is any HF ref shape
// (URL or org/name@rev). Optional `kind` ('image'|'video'), `runtime` (video),
// `runner` (image) let the UI correct a mis-detected repo. `name`/`steps`/
// `guidance` override the derived defaults. Returns the new registry entry.
export const addModelFromHuggingface = async (input, { fetchImpl = fetch } = {}) => {
  const { repo, revision } = parseHuggingfaceLoraRef(input?.url);
  // Refuse a pinned revision (`org/name@rev`, `/tree/<rev>`). The registry
  // entry stores only `repo`, and the download + render paths pull the default
  // branch — so classifying against a pinned revision but generating against
  // `main` would silently render different weights. Rather than persist a
  // revision the render path ignores, reject it up front (the strict-refusal
  // guarantee: an add either renders what it classified, or is refused). A user
  // who needs a specific revision can pin it by hand-editing media-models.json.
  if (revision) {
    throw new ServerError(
      `HuggingFace repo "${repo}" was given a pinned revision ("${revision}"), which the model download/render paths don't honor — they always use the default branch. Add the repo without a revision (the default branch), or pin the revision by editing data/media-models.json directly.`,
      { status: 422, code: 'HF_REVISION_UNSUPPORTED' },
    );
  }
  // Stored/env/CLI token — needed only for gated repos, harmless on public ones.
  const token = (typeof input?.token === 'string' && input.token.trim()) || (await getHfToken()) || '';
  const model = await fetchHuggingfaceModel(repo, { token, revision, fetchImpl });

  // Strict classification: throws HF_UNSUPPORTED_FORMAT (GGUF-only),
  // HF_NO_SAFETENSORS, HF_UNSUPPORTED_RUNTIME (wan/hunyuan),
  // HF_UNKNOWN_KIND/RUNNER, or the HF_BAD_* override-validation errors. A repo
  // no runtime can load never reaches the registry — that's the whole point:
  // a bad add would wedge the model picker.
  const classification = classifyHfMediaModel({
    repo,
    model,
    kind: input?.kind,
    runtime: input?.runtime,
    runner: input?.runner,
  });

  const entry = buildCustomModelEntry({
    repo,
    model,
    classification,
    name: input?.name,
    steps: Number.isFinite(input?.steps) ? input.steps : undefined,
    guidance: Number.isFinite(input?.guidance) ? input.guidance : undefined,
  });

  // addUserModelEntry throws MODEL_ALREADY_EXISTS on a duplicate id (repo
  // already added) and persists + hot-reloads the registry cache.
  addUserModelEntry(entry, { kind: classification.kind });
  console.log(`✅ Added HuggingFace media model: ${entry.id} [${classification.kind}/${classification.runtime || classification.runner}]`);
  return { entry, kind: classification.kind };
};
