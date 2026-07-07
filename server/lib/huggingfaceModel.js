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
  if (looksLikeLtxVideo(blob)) {
    // dgrauet's LTX-2 repos run on the `ltx2` BYO-venv runtime (true keyframe
    // pipeline), not notapalindrome's `mlx_video` — auto-detect that from the
    // author/marker so an added dgrauet repo routes to the right generator.
    // Everything else LTX defaults to mlx_video (the shipped default runtime).
    if (/dgrauet|ltx[\s._-]?pipelines/.test(blob)) return { runtime: 'ltx2' };
    return { runtime: 'mlx_video' };
  }
  return null;
};

// Image runners a user MAY target when adding a model — the diffusers-family
// runners (flux2 / z-image / ernie / hidream / qwen) whose Python entry point
// loads weights from the entry's `repo` field (`--repo <hf-repo>`). `mflux` is
// deliberately EXCLUDED: `mflux-generate --model <id>` only accepts the two
// built-in aliases (`dev`/`schnell`) and ignores the stored repo, so a custom
// `hf-org-model` mflux id would register but fail at render. A Flux.1 repo the
// user wants must go through a runner that honors `repo`. Kept as an explicit
// allowlist (not `Object.values(RUNNER_FAMILIES)`) so a bad add can't wedge the
// picker with an unrenderable entry.
export const ADDABLE_IMAGE_RUNNERS = Object.freeze(
  Object.values(RUNNER_FAMILIES).filter((r) => r !== RUNNER_FAMILIES.MFLUX),
);

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

// Static per-runner registry metadata the render path needs beyond `repo` —
// FIXED per family (identical across the shipped built-ins), so a self-service
// add can stamp them and the entry renders without hand-editing:
//   - flux2:   quantization:'none' → runner loads `repo` directly (no tokenizerRepo)
//   - ernie:   ErnieImagePipeline isn't in diffusers' auto-registry; usePromptEnhancer on
//   - hidream: HiDreamImagePipeline + the (gated) Llama-3.1 text encoder + its class names
//   - qwen:    QwenImagePipeline pinned so a registry edit can't fight auto-resolution
// z-image needs nothing beyond `repo` (autodetected). Mirrors DEFAULT_REGISTRY.
const RUNNER_METADATA = {
  [RUNNER_FAMILIES.FLUX2]: { quantization: 'none' },
  [RUNNER_FAMILIES.ERNIE]: { pipelineClass: 'ErnieImagePipeline', usePromptEnhancer: true },
  [RUNNER_FAMILIES.HIDREAM]: {
    pipelineClass: 'HiDreamImagePipeline',
    textEncoderRepo: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    textEncoderClass: 'LlamaForCausalLM',
    tokenizerClass: 'PreTrainedTokenizerFast',
  },
  [RUNNER_FAMILIES.QWEN]: { pipelineClass: 'QwenImagePipeline' },
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

// A repo is a LoRA ADAPTER (not a base model) when its card declares a
// `base_model` it adapts, or its id/tags carry the lora marker. The base-model
// installer must refuse these — a LoRA has the video LoRA installer
// (/api/loras/install/huggingface) and would otherwise register as a bogus base
// entry the render path can't load. `peft`/`adapter` library tags are the
// diffusers signal for an adapter package.
const looksLikeLora = ({ repo, model }) => {
  const blob = `${String(repo || '').toLowerCase()} ${(Array.isArray(model?.tags) ? model.tags : []).join(' ').toLowerCase()}`;
  if (/\blora\b|\blycoris\b|\blocon\b|\bdora\b/.test(blob)) return true;
  const lib = typeof model?.library_name === 'string' ? model.library_name.toLowerCase() : '';
  if (lib === 'peft') return true;
  // A base_model reference in the card means "this adapts that model" → adapter.
  const bm = model?.cardData?.base_model;
  if (typeof bm === 'string' && bm.trim()) return true;
  if (Array.isArray(bm) && bm.some((b) => typeof b === 'string' && b.trim())) return true;
  return false;
};

const assertNotLora = ({ repo, model }) => {
  if (looksLikeLora({ repo, model })) {
    throw new ServerError(
      `HuggingFace repo "${repo}" looks like a LoRA adapter, not a base model — install LoRAs from the LoRA manager (/media/loras), not here.`,
      { status: 422, code: 'HF_IS_LORA' },
    );
  }
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
  assertNotLora({ repo, model });
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

  // Refuse a repo whose DETECTED runtime isn't addable (wan22 / hunyuan need a
  // BYO venv) UNCONDITIONALLY — before kind resolution and before any override.
  // The "a bad add can't wedge the picker" guarantee must hold even when the
  // caller forces `runtime: 'mlx_video'` on a Hunyuan repo OR `kind: 'image'`
  // (which would otherwise route it into the image branch and skip this check
  // entirely, persisting a Wan/Hunyuan repo as a bogus image model).
  if (detectedVideo && !ADDABLE_VIDEO_RUNTIMES.includes(detectedVideo.runtime)) {
    throw new ServerError(
      `HuggingFace repo "${repo}" targets the "${detectedVideo.runtime}" runtime, which needs a dedicated venv (${detectedVideo.installHint}) and can't be added self-service — set it up via the script, then edit data/media-models.json.`,
      { status: 422, code: 'HF_UNSUPPORTED_RUNTIME' },
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
    // Explicit override wins (already allowlist-validated).
    if (runtime) return { kind: 'video', runtime, format: 'safetensors' };
    // Otherwise require a POSITIVELY-detected addable runtime. A repo that only
    // looks like video via its pipeline_tag (no LTX/Wan/Hunyuan marker) must NOT
    // default to mlx_video — that runtime only loads the LTX family, so the
    // entry would register but 400 at render. Refuse and ask for an explicit
    // runtime, keeping the "a bad add can't wedge the picker" guarantee.
    if (!detectedVideo) {
      throw new ServerError(
        `Couldn't determine which video runtime loads "${repo}" — only LTX-family repos are auto-detected. Pass an explicit runtime (one of ${ADDABLE_VIDEO_RUNTIMES.join(', ')}) if you know it loads on one of them.`,
        { status: 422, code: 'HF_UNKNOWN_RUNTIME' },
      );
    }
    return { kind: 'video', runtime: detectedVideo.runtime, format: 'safetensors' };
  }

  const resolvedRunner = runner || imageRunner;
  if (!resolvedRunner) {
    throw new ServerError(
      `Couldn't determine which image runner loads "${repo}". Pass an explicit runner (one of ${ADDABLE_IMAGE_RUNNERS.join(', ')}).`,
      { status: 422, code: 'HF_UNKNOWN_RUNNER' },
    );
  }
  // A detected mflux runner (a Flux.1 repo) is refused for the same reason
  // mflux is off ADDABLE_IMAGE_RUNNERS — `mflux-generate` ignores the repo and
  // only loads its two built-in aliases, so a custom mflux entry can't render.
  // (An explicit mflux override was already rejected by the enum check above.)
  if (!ADDABLE_IMAGE_RUNNERS.includes(resolvedRunner)) {
    throw new ServerError(
      `HuggingFace repo "${repo}" looks like a Flux.1 (mflux) model, which can't be added self-service — the mflux runner only loads its built-in dev/schnell models and ignores a custom repo. Use a repo that runs on a diffusers-family runner (${ADDABLE_IMAGE_RUNNERS.join(', ')}).`,
      { status: 422, code: 'HF_UNSUPPORTED_RUNNER' },
    );
  }
  // A QUANTIZED FLUX.2 repo (SDNQ / int8 community package) can't be added
  // self-service: the entry builder stamps `quantization:'none'` (bf16), but
  // the runner then loads `repo` as a native bf16 pipeline and never passes the
  // `tokenizerRepo`/`basePipelineRepo` those quant repos require — so it would
  // register but 400 at render. We can't auto-derive the right sibling repos, so
  // refuse and point at the bf16 base (which IS addable) or a hand-edit.
  if (resolvedRunner === RUNNER_FAMILIES.FLUX2 && /\bsdnq\b|\bint8\b|\b4bit\b|\bnf4\b|quantiz/.test(blob)) {
    throw new ServerError(
      `HuggingFace repo "${repo}" is a quantized FLUX.2 package (SDNQ/int8), which can't be added self-service — it needs a separate tokenizer/base-pipeline repo this flow can't derive. Add the unquantized bf16 base repo instead, or edit data/media-models.json to set quantization + the required sibling repos.`,
      { status: 422, code: 'HF_FLUX2_QUANTIZED' },
    );
  }
  // Qwen-Image-Edit loads QwenImageEditPipeline (not QwenImagePipeline) and
  // REQUIRES a source image — a text-only render crashes deep in diffusers, so
  // the built-in carries `editOnly`. Detect the edit repo so the added entry
  // gets the right pipeline + gate instead of the plain text-to-image config.
  const editVariant = resolvedRunner === RUNNER_FAMILIES.QWEN && /qwen[\s._-]?image[\s._-]?edit|-edit\b|\bedit\b/.test(blob);
  return { kind: 'image', runner: resolvedRunner, format: 'safetensors', ...(editVariant ? { editVariant: true } : {}) };
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
  if (classification.kind === 'video') {
    entry.runtime = classification.runtime;
  } else {
    entry.runner = classification.runner;
    // Stamp the static per-runner metadata the render path requires beyond
    // `repo` (flux2 quantization:'none', ernie/hidream/qwen pipelineClass +
    // hidream's gated text encoder). Without these the entry would register but
    // 400 at render (IMAGE_GEN_*_MISCONFIGURED) — the strict-refusal guarantee
    // is "renders what it classified, or is refused," so we must supply them.
    // For HiDream the text encoder is a GATED Llama repo: the add succeeds but
    // the first render will prompt the user to accept that license + set an HF
    // token, same as the shipped built-in.
    Object.assign(entry, RUNNER_METADATA[classification.runner] || {});
    // A Qwen-Image-Edit repo needs the edit pipeline + the editOnly gate
    // (text-only renders crash it), overriding the plain QwenImagePipeline.
    if (classification.editVariant) {
      entry.pipelineClass = 'QwenImageEditPipeline';
      entry.editOnly = true;
    }
  }
  return entry;
};
