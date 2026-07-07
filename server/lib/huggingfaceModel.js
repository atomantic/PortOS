/**
 * HuggingFace base-model classifier — pure helpers for the "add a base model
 * from HuggingFace" flow (issue #2124). The LoRA installer's analogue
 * (huggingfaceLora.js) picks a single .safetensors and tags a video-LoRA
 * family; this module instead inspects a full repo's siblings + card and
 * decides which PortOS image/video *runtime* (if any) can load it, then shapes
 * a `data/media-models.json` registry entry.
 *
 * The overriding design goal is STRICT REFUSAL: a base model that no runtime
 * can load must never land in the registry, because a broken entry wedges the
 * model picker (a 400/"Unknown model" the first time the UI tries to use it).
 * So GGUF-only repos (llama.cpp/ggml — read nowhere in the image/video
 * pipeline), Wan/HunyuanVideo (BYO-venv runtimes provisioned only via
 * scripts/setup-image-video.sh, not self-service), and anything unclassifiable
 * are refused up front with a typed ServerError the UI can surface.
 *
 * No try/catch — errors bubble to centralized middleware; domain errors throw
 * ServerError.
 */

import { ServerError } from './errorHandler.js';
import { RUNNER_FAMILIES } from './runners.js';
import { readResponseJson } from './readResponseJson.js';
import {
  HF_API,
  looksLikeLtxVideo,
  modelClassificationBlob,
  modelSiblingFilenames,
} from './huggingfaceLora.js';

// Search the HF Hub for candidate base-model repos matching a free-text query.
// Backs the manager UI's "search HuggingFace" box (mirrors the LoRA installer's
// GET /search). Returns lightweight `{ id, likes, downloads, pipeline_tag }`
// rows — the caller adds one by pasting its id into the add flow, which does
// the full classify/refuse pass. `pipeline` scopes to `text-to-image` /
// `text-to-video` etc. when provided. fetchImpl is injectable for tests.
export const searchHuggingfaceModels = async (query, { pipeline, limit = 12, fetchImpl = fetch } = {}) => {
  const params = new URLSearchParams();
  const search = typeof query === 'string' ? query.trim() : '';
  if (search) params.set('search', search);
  if (pipeline) params.set('pipeline_tag', pipeline);
  params.set('limit', String(Math.max(1, Math.min(50, limit))));
  params.set('sort', 'downloads');
  const res = await fetchImpl(`${HF_API}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new ServerError(`HuggingFace search failed: ${res.status}`, { status: 502, code: 'HF_SEARCH_FAILED' });
  }
  const rows = await readResponseJson(res, { fallback: [] });
  const list = Array.isArray(rows) ? rows : [];
  return list.map((r) => ({
    id: r?.id || r?.modelId || null,
    likes: Number.isFinite(r?.likes) ? r.likes : 0,
    downloads: Number.isFinite(r?.downloads) ? r.downloads : 0,
    pipeline_tag: typeof r?.pipeline_tag === 'string' ? r.pipeline_tag : null,
  })).filter((r) => r.id);
};

// Video runtimes a user MAY target when adding a model. Both load MLX /
// diffusers `.safetensors`:
//   - mlx_video  — notapalindrome's single-PyPI-package runtime (T2V/I2V).
//   - ltx2       — dgrauet's BYO-venv KeyframeInterpolationPipeline.
// A repo whose detected runtime isn't in this allowlist is refused (see
// detectVideoRuntime + classifyHfMediaModel) — this is the single gate, not a
// default-mlx_video-plus-denylist. Kept in sync with BYOV_RUNTIME_INFO's keys
// in server/services/videoGen/runtimes.js (the classifier stays pure, so the
// self-service exclusions live here rather than importing that stateful module).
export const ADDABLE_VIDEO_RUNTIMES = Object.freeze(['mlx_video', 'ltx2']);

// Detect the underlying video runtime family from the classification blob, so
// the allowlist above can refuse the rest symmetrically with the image path.
// Wan / HunyuanVideo resolve to their (non-addable) runtime ids + the install
// hint the refusal surfaces; LTX resolves to mlx_video (the safetensors/MLX
// default). Returns `{ runtime, installHint? }` or null when no video marker
// matches. A NEW BYO-venv runtime added upstream automatically falls through to
// "not addable" instead of silently registering as a broken mlx_video entry.
const detectVideoRuntime = (blob) => {
  if (/\bwan[\s._-]?2|wan-ai\b/.test(blob) || /\bwan2\.\d/.test(blob)) {
    return { runtime: 'wan22', installHint: 'INSTALL_WAN22=1 bash scripts/setup-image-video.sh' };
  }
  if (/hunyuan/.test(blob)) {
    return { runtime: 'hunyuan', installHint: 'INSTALL_HUNYUAN=1 bash scripts/setup-image-video.sh' };
  }
  if (looksLikeLtxVideo(blob)) return { runtime: 'mlx_video' };
  return null;
};

// Image runners are all self-service (mflux + the shared diffusers runner
// families). Any RUNNER_FAMILIES value is fair game.
export const ADDABLE_IMAGE_RUNNERS = Object.freeze(Object.values(RUNNER_FAMILIES));

// Default steps/guidance per target so an added entry renders sanely without
// the user having to know each pipeline's sweet spot. Mirrors the shipped
// DEFAULT_REGISTRY entries.
const VIDEO_DEFAULTS = { mlx_video: { steps: 25, guidance: 3.0 }, ltx2: { steps: 8, guidance: 3.0 } };
const IMAGE_DEFAULTS = {
  [RUNNER_FAMILIES.MFLUX]: { steps: 20, guidance: 3.5 },
  [RUNNER_FAMILIES.FLUX2]: { steps: 8, guidance: 3.5 },
  [RUNNER_FAMILIES.Z_IMAGE]: { steps: 8, guidance: 1.0 },
  [RUNNER_FAMILIES.ERNIE]: { steps: 50, guidance: 4.0 },
  [RUNNER_FAMILIES.HIDREAM]: { steps: 50, guidance: 5.0 },
  [RUNNER_FAMILIES.QWEN]: { steps: 30, guidance: 4.0 },
};

// Inspect the repo's file list. `.gguf` present (llama.cpp/ggml) is the format
// we can never load in the image/video pipeline; `.safetensors` is required.
// Reuses the shared sibling lister from huggingfaceLora.js.
export const inspectModelFiles = (model) => {
  const names = modelSiblingFilenames(model);
  return {
    hasSafetensors: names.some((f) => /\.safetensors$/i.test(f)),
    hasGguf: names.some((f) => /\.gguf$/i.test(f)),
    fileCount: names.length,
  };
};

// Refuse formats no runtime can load. Throws a typed ServerError; the message
// is user-facing and points at the supported alternative.
const assertLoadableFormat = ({ repo, model }) => {
  const { hasSafetensors, hasGguf } = inspectModelFiles(model);
  if (hasGguf && !hasSafetensors) {
    throw new ServerError(
      `HuggingFace repo "${repo}" ships only GGUF weights, which no PortOS image/video runtime can load (GGUF is used only by the local text-LLM + Whisper paths). If a native MLX/safetensors build of this model exists, add that instead.`,
      { status: 422, code: 'HF_UNSUPPORTED_FORMAT' },
    );
  }
  if (!hasSafetensors) {
    throw new ServerError(
      `HuggingFace repo "${repo}" has no .safetensors weights — only diffusers/MLX safetensors models can be added.`,
      { status: 422, code: 'HF_NO_SAFETENSORS' },
    );
  }
};

// Extend the shared LoRA classification blob with the base-model-only signals
// (pipeline_tag / library_name), so both classifiers read the same core fields.
const classificationBlob = ({ repo, model }) => {
  const extra = [];
  if (typeof model?.pipeline_tag === 'string') extra.push(model.pipeline_tag.toLowerCase());
  if (typeof model?.library_name === 'string') extra.push(model.library_name.toLowerCase());
  return `${modelClassificationBlob({ repo, model })} ${extra.join(' ')}`;
};

// Best-effort image-runner detection from the classification blob. Order
// matters: FLUX.2 before FLUX.1, since "flux.2" contains "flux".
const detectImageRunner = (blob) => {
  if (/flux[\s._-]?2|flux\.2/.test(blob)) return RUNNER_FAMILIES.FLUX2;
  if (/z[\s._-]?image/.test(blob)) return RUNNER_FAMILIES.Z_IMAGE;
  if (/ernie/.test(blob)) return RUNNER_FAMILIES.ERNIE;
  if (/hidream/.test(blob)) return RUNNER_FAMILIES.HIDREAM;
  if (/qwen[\s._-]?image/.test(blob)) return RUNNER_FAMILIES.QWEN;
  if (/flux[\s._-]?1|flux\.1|\bflux\b/.test(blob)) return RUNNER_FAMILIES.MFLUX;
  return null;
};

const isVideoPipelineTag = (model) =>
  typeof model?.pipeline_tag === 'string' && /video/.test(model.pipeline_tag.toLowerCase());
const isImagePipelineTag = (model) =>
  typeof model?.pipeline_tag === 'string' && /text-to-image|image-to-image/.test(model.pipeline_tag.toLowerCase());

/**
 * Classify an HF repo into a proposed PortOS media-model entry.
 *
 * @param {object} args
 * @param {string} args.repo  - `org/name` repo id
 * @param {object} args.model - parsed HF `/api/models/{repo}` response
 * @param {'image'|'video'} [args.kind]     - explicit kind override
 * @param {string} [args.runtime]           - explicit video runtime override
 * @param {string} [args.runner]            - explicit image runner override
 * @returns {{ kind, runtime?, runner?, format:'safetensors' }}
 *   Throws ServerError (HF_UNSUPPORTED_FORMAT / HF_NO_SAFETENSORS /
 *   HF_UNSUPPORTED_RUNTIME / HF_UNKNOWN_KIND / HF_UNKNOWN_RUNNER /
 *   HF_BAD_KIND / HF_BAD_RUNTIME / HF_BAD_RUNNER) on anything unloadable or
 *   unclassifiable.
 */
export const classifyHfMediaModel = ({ repo, model, kind, runtime, runner } = {}) => {
  assertLoadableFormat({ repo, model });
  const blob = classificationBlob({ repo, model });
  // Detect once and reuse across kind-resolution + runtime/runner resolution.
  const detectedVideo = detectVideoRuntime(blob);
  const imageRunner = detectImageRunner(blob);

  // Validate explicit overrides against the addable enums before trusting them.
  if (kind !== undefined && kind !== 'image' && kind !== 'video') {
    throw new ServerError(`Unknown model kind "${kind}" — expected "image" or "video".`, { status: 400, code: 'HF_BAD_KIND' });
  }
  if (runtime !== undefined && !ADDABLE_VIDEO_RUNTIMES.includes(runtime)) {
    throw new ServerError(
      `Video runtime "${runtime}" can't be added self-service — expected one of ${ADDABLE_VIDEO_RUNTIMES.join(', ')}.`,
      { status: 400, code: 'HF_BAD_RUNTIME' },
    );
  }
  if (runner !== undefined && !ADDABLE_IMAGE_RUNNERS.includes(runner)) {
    throw new ServerError(
      `Unknown image runner "${runner}" — expected one of ${ADDABLE_IMAGE_RUNNERS.join(', ')}.`,
      { status: 400, code: 'HF_BAD_RUNNER' },
    );
  }

  // Resolve kind: explicit override wins, else detect.
  let resolvedKind = kind || null;
  if (!resolvedKind) {
    if (runtime) resolvedKind = 'video';
    else if (runner) resolvedKind = 'image';
    else if (detectedVideo || isVideoPipelineTag(model)) resolvedKind = 'video';
    else if (imageRunner || isImagePipelineTag(model)) resolvedKind = 'image';
  }
  if (!resolvedKind) {
    throw new ServerError(
      `Couldn't tell whether "${repo}" is an image or video model. Pass an explicit kind (and runtime/runner) if you know what it targets.`,
      { status: 422, code: 'HF_UNKNOWN_KIND' },
    );
  }

  if (resolvedKind === 'video') {
    // Explicit override wins (already allowlist-validated). Otherwise use the
    // detected runtime — and if that detected runtime isn't addable (wan22 /
    // hunyuan need a BYO venv), refuse with the install hint. A repo with no
    // video marker at all defaults to mlx_video (the safetensors/MLX default).
    if (runtime) return { kind: 'video', runtime, format: 'safetensors' };
    if (detectedVideo && !ADDABLE_VIDEO_RUNTIMES.includes(detectedVideo.runtime)) {
      throw new ServerError(
        `HuggingFace repo "${repo}" targets the "${detectedVideo.runtime}" runtime, which needs a dedicated venv (${detectedVideo.installHint}) and can't be added self-service — set it up via the script, then edit data/media-models.json.`,
        { status: 422, code: 'HF_UNSUPPORTED_RUNTIME' },
      );
    }
    return { kind: 'video', runtime: detectedVideo?.runtime || 'mlx_video', format: 'safetensors' };
  }

  const resolvedRunner = runner || imageRunner;
  if (!resolvedRunner) {
    throw new ServerError(
      `Couldn't determine which image runner loads "${repo}". Pass an explicit runner (one of ${ADDABLE_IMAGE_RUNNERS.join(', ')}).`,
      { status: 422, code: 'HF_UNKNOWN_RUNNER' },
    );
  }
  return { kind: 'image', runner: resolvedRunner, format: 'safetensors' };
};

// Derive a stable, collision-resistant registry id from the repo. `org/name`
// → `org-name` lowercased, with a `hf-` prefix so a user entry can't collide
// with a shipped built-in id (which are hand-picked short slugs like
// `ltx23_distilled_q4`). Non-id chars collapse to a single dash.
export const customModelIdFromRepo = (repo) => {
  const slug = String(repo || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `hf-${slug || 'model'}`;
};

// Build the `data/media-models.json` entry for a classified add. `source:
// 'user'` is the flag the registry mutators + UI gate on to distinguish
// user-added (editable/removable) from shipped built-in (read-only). Steps /
// guidance default per target but respect explicit values.
export const buildCustomModelEntry = ({ repo, model, classification, name, steps, guidance }) => {
  const id = customModelIdFromRepo(repo);
  const displayName = (typeof name === 'string' && name.trim())
    || (typeof model?.cardData?.model_name === 'string' && model.cardData.model_name.trim())
    || repo.split('/')[1]
    || repo;
  const defaults = classification.kind === 'video'
    ? (VIDEO_DEFAULTS[classification.runtime] || { steps: 25, guidance: 3.0 })
    : (IMAGE_DEFAULTS[classification.runner] || { steps: 20, guidance: 3.5 });
  const entry = {
    id,
    name: displayName,
    repo,
    steps: Number.isFinite(steps) ? steps : defaults.steps,
    guidance: Number.isFinite(guidance) ? guidance : defaults.guidance,
    source: 'user',
    installedAt: new Date().toISOString(),
  };
  if (classification.kind === 'video') entry.runtime = classification.runtime;
  else entry.runner = classification.runner;
  return entry;
};
