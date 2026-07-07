/**
 * Media model registry — single source of truth for image/video model
 * definitions and the text encoder used by the LTX video pipeline.
 *
 * On first load, seeds `data/media-models.json` with the project's default
 * catalog. Edit that JSON to add models, tune steps/guidance, switch the
 * text encoder, etc. Server restart picks up changes (the registry is
 * cached at boot — there's no hot-reload).
 *
 * Schema (see seed defaults below for the full picture):
 *   - video.macos[], video.windows[]: { id, name, repo?, steps, guidance, broken? }
 *   - video.defaultMacos / video.defaultWindows: id of the default model
 *   - image[]: { id, name, steps, guidance, broken? }
 *   - textEncoders[]: { id, label, repo, localPath? }
 *   - selectedTextEncoder: id of the active text encoder
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { PATHS, expandHome } from './fileUtils.js';
import { isPlainObject } from './objects.js';
import { RUNNER_FAMILIES } from './runners.js';
import { ServerError } from './errorHandler.js';
// fileUtils.ensureDir is async/Promise-returning; this module needs a
// synchronous version because `loadMediaModels()` is called at import-time
// from videoGen/imageGen modules, which can't await before exporting.

// Allow tests + non-standard deployments to point at a different file
// without monkey-patching PATHS. Defaults to data/media-models.json.
const REGISTRY_FILE = process.env.PORTOS_MEDIA_MODELS_FILE || join(PATHS.data, 'media-models.json');
const IS_WIN = process.platform === 'win32';

const DEFAULT_REGISTRY = {
  _doc: 'PortOS media model registry. Edit to add models, tune defaults, or switch the text encoder. Restart the server to apply changes.',
  video: {
    macos: [
      // notapalindrome's mlx-video-with-audio runtime — single PyPI package,
      // T2V/I2V only, FFLF degrades to last-frame conditioning (one --image arg).
      // LTX-2 (the older 42 GB model) stays deprecated — superseded by 2.3.
      // The 2.3 Unified Beta and Distilled Q4 are no longer deprecated:
      // 2.3 Unified bf16 is the quality ceiling for the mlx_video runtime, and
      // is now practical on 128 GB unified-memory hardware. Distilled Q4 is
      // still the shipped default because it works on smaller boxes.
      { id: 'ltx2_unified',       name: 'LTX-2 Unified (~42 GB)',          repo: 'notapalindrome/ltx2-mlx-av',     runtime: 'mlx_video', steps: 30, guidance: 3.0, deprecated: true },
      { id: 'ltx23_unified',      name: 'LTX-2.3 Unified Beta (~48 GB, bf16 quality ceiling)', repo: 'notapalindrome/ltx23-mlx-av',    runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4 (~22 GB)',   repo: 'notapalindrome/ltx23-mlx-av-q4', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      // dgrauet's ltx-2-mlx runtime — true KeyframeInterpolationPipeline,
      // native video Extend, audio→video. Requires a separate venv synced
      // via `INSTALL_LTX2=1 bash scripts/setup-image-video.sh`.
      { id: 'ltx23_dgrauet_q4',   name: 'LTX-2.3 dgrauet Q4 (~16 GB, true keyframes)', repo: 'dgrauet/ltx-2.3-mlx-q4', runtime: 'ltx2', steps: 8, guidance: 3.0 },
      { id: 'ltx23_dgrauet_q8',   name: 'LTX-2.3 dgrauet Q8 (~25 GB, true keyframes)', repo: 'dgrauet/ltx-2.3-mlx-q8', runtime: 'ltx2', steps: 8, guidance: 3.0 },
      // Wan 2.2 (Alibaba) — pure-MLX port at osama-ata/Wan2.2-mlx, weights
      // at Wan-AI/Wan2.2-T2V-A14B. Requires a dedicated venv synced via
      // `INSTALL_WAN22=1 bash scripts/setup-image-video.sh` (clones the
      // runtime repo into ~/.portos/wan2.2-mlx). MoE-A14B = 14B active
      // params at inference, ~28 GB resident at bf16.
      {
        id: 'wan22_t2v_a14b',
        name: 'Wan 2.2 T2V A14B (~28 GB, MoE-14B-active)',
        repo: 'Wan-AI/Wan2.2-T2V-A14B',
        runtime: 'wan22',
        mode: 't2v',
        steps: 25,
        guidance: 5.0,
      },
      {
        id: 'wan22_i2v_a14b',
        name: 'Wan 2.2 I2V A14B (~28 GB, image-to-video)',
        repo: 'Wan-AI/Wan2.2-I2V-A14B',
        runtime: 'wan22',
        mode: 'i2v',
        steps: 25,
        guidance: 5.0,
      },
      // HunyuanVideo (Tencent) — MLX port at gaurav-nelson/HunyuanVideo_MLX,
      // weights at tencent/HunyuanVideo. 13B params, ~60 GB resident at bf16.
      // Practical only with Gemma 4-bit text encoder (not bf16) + nothing else
      // in unified memory. Provisioned via `INSTALL_HUNYUAN=1 bash
      // scripts/setup-image-video.sh`.
      {
        id: 'hunyuan_video',
        // fp32-only on MPS: fp16/bf16 trip an MPS matmul accumulator-dtype
        // assertion within ~2s of the first forward pass. At 576×1024×121
        // frames × 30 steps that's a 4-8 hr render — marked `deprecated`
        // so it lands in the "Legacy" optgroup. Migration 044 patches
        // existing installs that still have the pre-fix shape.
        name: 'HunyuanVideo (13B — fp32-only on MPS, ~4-8 hr per render)',
        repo: 'tencent/HunyuanVideo',
        runtime: 'hunyuan',
        mode: 't2v',
        steps: 30,
        guidance: 6.0,
        precision: 'fp32',
        deprecated: true,
      },
    ],
    windows: [
      { id: 'ltx_video', name: 'LTX-Video 0.9.5 — T2V + I2V (~9.5 GB, auto-downloads)', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
    ],
    defaultMacos: 'ltx23_distilled_q4',
    defaultWindows: 'ltx_video',
  },
  image: [
    // mflux runner — MLX-only, Flux 1 (dev/schnell). `runner` defaults to 'mflux'.
    { id: 'dev',              name: 'Flux 1 Dev',      steps: 20, guidance: 3.5, requiresHfToken: true, licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.1-dev' },
    { id: 'schnell',          name: 'Flux 1 Schnell',  steps: 4,  guidance: 0,   cfgDisabled: true },
    // flux2 runner — PyTorch + diffusers + MPS (Apple Silicon) or CUDA (Win/Linux).
    // Models are quantized to fit on consumer hardware; tokenizer comes from the
    // gated base repo, so users must accept the license at huggingface.co and
    // set HF_TOKEN before first use.
    {
      id: 'flux2-klein-4b',
      name: 'Flux 2 Klein 4B (SDNQ 4-bit, ~8 GB @ 512px)',
      runner: 'flux2',
      quantization: 'sdnq',
      repo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic',
      tokenizerRepo: 'black-forest-labs/FLUX.2-klein-4B',
      steps: 8,
      guidance: 3.5,
      cfgDisabled: true,
    },
    {
      id: 'flux2-klein-9b',
      name: 'Flux 2 Klein 9B (SDNQ 4-bit, ~12 GB — needs 32+ GB RAM)',
      runner: 'flux2',
      quantization: 'sdnq',
      repo: 'Disty0/FLUX.2-klein-9B-SDNQ-4bit-dynamic-svd-r32',
      // KV repo's tokenizer is the same Qwen3 tokenizer as the base 9B repo,
      // but the multi-reference editing path in scripts/flux2_macos.py probes
      // HF auth against this value — pinning to the KV repo means accepting
      // its license once enables both single-ref + multi-ref renders.
      tokenizerRepo: 'black-forest-labs/FLUX.2-klein-9B-kv',
      steps: 8,
      guidance: 3.5,
      cfgDisabled: true,
    },
    {
      id: 'flux2-klein-4b-int8',
      name: 'Flux 2 Klein 4B (Int8, ~16 GB)',
      runner: 'flux2',
      quantization: 'int8',
      repo: 'aydin99/FLUX.2-klein-4B-int8',
      basePipelineRepo: 'black-forest-labs/FLUX.2-klein-4B',
      steps: 8,
      guidance: 3.5,
      cfgDisabled: true,
    },
    // FLUX.2 9B at native bf16 — no quantization, full quality. Needs ~36 GB
    // resident for the transformer alone, plus ~8 GB for the text encoder.
    // Practical on 128GB unified-memory hardware; will OOM on smaller boxes.
    // Uses the gated black-forest-labs/FLUX.2-klein-9B repo directly (same
    // license as flux2-klein-9b SDNQ variant — accept once at huggingface.co).
    {
      id: 'flux2-klein-9b-bf16',
      name: 'Flux 2 Klein 9B (bf16, ~36 GB — 64+ GB RAM)',
      runner: 'flux2',
      quantization: 'none',
      repo: 'black-forest-labs/FLUX.2-klein-9B',
      // Multi-reference editing loads this `-kv` sibling repo instead of the
      // base 9B (its transformer is tuned for the K/V reference-editing task).
      // The plain text/i2i bf16 path stays on `repo`. Same FLUX.2-klein
      // license — accept once at huggingface.co. Threaded to the runner as
      // `--kv-repo`; see scripts/flux2_macos.py.
      kvRepo: 'black-forest-labs/FLUX.2-klein-9B-kv',
      steps: 20,
      guidance: 3.5,
      cfgDisabled: true,
      requiresHfToken: true,
      licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-9B',
    },
    // hidream runner — HiDream-I1 17B MoE DiT, Apache 2.0 weights but needs
    // meta-llama/Meta-Llama-3.1-8B-Instruct (gated) as text-encoder-4.
    // Pipeline class isn't auto-detected so passed explicitly. Reuses the
    // FLUX.2 venv (diffusers >= 0.32 has HiDreamImagePipeline).
    {
      id: 'hidream-i1-full',
      name: 'HiDream-I1 Full (17B, ~34 GB @ bf16, 50 steps)',
      runner: 'hidream',
      repo: 'HiDream-ai/HiDream-I1-Full',
      pipelineClass: 'HiDreamImagePipeline',
      textEncoderRepo: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      textEncoderClass: 'LlamaForCausalLM',
      tokenizerClass: 'PreTrainedTokenizerFast',
      steps: 50,
      guidance: 5.0,
      requiresHfToken: true,
      licenseUrl: 'https://huggingface.co/meta-llama/Meta-Llama-3.1-8B-Instruct',
    },
    {
      id: 'hidream-i1-fast',
      name: 'HiDream-I1 Fast (17B distilled, ~34 GB, 16 steps)',
      runner: 'hidream',
      repo: 'HiDream-ai/HiDream-I1-Fast',
      pipelineClass: 'HiDreamImagePipeline',
      textEncoderRepo: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      textEncoderClass: 'LlamaForCausalLM',
      tokenizerClass: 'PreTrainedTokenizerFast',
      steps: 16,
      guidance: 0,
      cfgDisabled: true,
      requiresHfToken: true,
      licenseUrl: 'https://huggingface.co/meta-llama/Meta-Llama-3.1-8B-Instruct',
    },
    // qwen runner — Qwen-Image 20B MMDiT, Apache 2.0, ungated. Uses
    // Qwen/Qwen2.5-VL-7B-Instruct as the bundled text encoder (also Apache).
    // Diffusers >= 0.31 ships QwenImagePipeline (autodetectable via
    // AutoPipelineForText2Image, but pinned explicitly so registry edits
    // don't fight pipeline-class auto-resolution).
    {
      id: 'qwen-image',
      name: 'Qwen-Image (20B MMDiT, ~40 GB @ bf16, best text rendering)',
      runner: 'qwen',
      repo: 'Qwen/Qwen-Image',
      pipelineClass: 'QwenImagePipeline',
      steps: 30,
      guidance: 4.0,
    },
    {
      id: 'qwen-image-edit',
      name: 'Qwen-Image-Edit (20B, image-to-image + text-rewrite)',
      runner: 'qwen',
      repo: 'Qwen/Qwen-Image-Edit',
      pipelineClass: 'QwenImageEditPipeline',
      steps: 30,
      guidance: 4.0,
      // QwenImageEditPipeline requires a source `image` arg — a text-only
      // submission crashes deep inside diffusers. `editOnly` lets the route
      // reject (and the UI gate) a render with no init image up-front.
      editOnly: true,
    },
    // z-image runner — Apache 2.0, ungated, reuses the FLUX.2 venv. Turbo
    // distillation runs ~8 steps with CFG disabled (guidance 1.0).
    {
      id: 'z-image-turbo-bf16',
      name: 'Z-Image-Turbo (bf16, ~13 GB)',
      runner: 'z-image',
      repo: 'Tongyi-MAI/Z-Image-Turbo',
      steps: 8,
      guidance: 1.0,
      cfgDisabled: true,
    },
    // ernie runner — Baidu's ERNIE-Image (8B DiT). Apache 2.0, ungated,
    // reuses the FLUX.2 venv. Pipeline class isn't in AutoPipelineForText2Image's
    // registry yet so we pass `pipelineClass: 'ErnieImagePipeline'` for
    // explicit dispatch. `usePromptEnhancer` activates the built-in PE module.
    {
      id: 'ernie-image',
      name: 'ERNIE-Image (~16 GB @ bf16, 50 steps)',
      runner: 'ernie',
      repo: 'baidu/ERNIE-Image',
      pipelineClass: 'ErnieImagePipeline',
      usePromptEnhancer: true,
      steps: 50,
      guidance: 4.0,
    },
    {
      id: 'ernie-image-turbo',
      name: 'ERNIE-Image-Turbo (~16 GB @ bf16, 8 steps)',
      runner: 'ernie',
      repo: 'baidu/ERNIE-Image-Turbo',
      pipelineClass: 'ErnieImagePipeline',
      usePromptEnhancer: true,
      steps: 8,
      guidance: 1.0,
      cfgDisabled: true,
    },
    {
      id: 'z-image-turbo-quant',
      name: 'Z-Image-Turbo (community quantized)',
      runner: 'z-image',
      repo: '',
      steps: 8,
      guidance: 1.0,
      cfgDisabled: true,
      // Hidden from the UI until the user picks a community quant repo and
      // clears this flag. Keeping the entry here gives them a copy-paste
      // template instead of having to remember the schema.
      broken: true,
    },
  ],
  textEncoders: [
    { id: 'gemma-4bit',     label: 'Gemma 3 12B 4-bit (smallest, ~7 GB)',                repo: 'mlx-community/gemma-3-12b-it-4bit' },
    { id: 'gemma-qat-4bit', label: 'Gemma 3 12B QAT 4-bit (better, ~8 GB, LM Studio)',   repo: 'mlx-community/gemma-3-12b-it-qat-4bit', localPath: '~/.lmstudio/models/mlx-community/gemma-3-12b-it-qat-4bit' },
    { id: 'gemma-bf16',     label: 'Gemma 3 12B bf16 (default, best quality, ~24 GB)',   repo: 'mlx-community/gemma-3-12b-it-bf16' },
  ],
  selectedTextEncoder: 'gemma-bf16',
};

let cached = null;

const ensureDir = (file) => {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

const seedIfMissing = () => {
  if (existsSync(REGISTRY_FILE)) return;
  ensureDir(REGISTRY_FILE);
  writeFileSync(REGISTRY_FILE, JSON.stringify(DEFAULT_REGISTRY, null, 2) + '\n');
  console.log(`📝 Seeded media model registry: ${REGISTRY_FILE}`);
};

// Merge user-edited registry over DEFAULT_REGISTRY so missing top-level keys
// (e.g. someone deletes `video` or saves `{}`) don't blow up consumers that
// assume `reg.video.macos`. We also coerce array-shaped fields back to the
// defaults when the user's JSON is parseable but wrong-shape (e.g.
// `image: {}` or `video.macos: "ltx"`) — otherwise getImageModels /
// getVideoModels / buildAppModels would throw at module import-time and
// take down server startup. If a user supplies a real array, that's their
// list, full stop — we don't deep-merge entries.
const arrayOrDefault = (v, fallback) => (Array.isArray(v) ? v : fallback);

// Pre-flux2 stored entries had `broken: 'macos'` and no `runner` field. Merge
// missing flux2 fields from DEFAULT_REGISTRY when an entry id matches a known
// flux2 model but is missing the runner discriminator. User overrides for
// other fields (custom name, steps, repo) are preserved.
const FLUX2_DEFAULTS_BY_ID = Object.fromEntries(
  DEFAULT_REGISTRY.image.filter((m) => m.runner === RUNNER_FAMILIES.FLUX2).map((m) => [m.id, m])
);

const upgradeImageEntries = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    const seed = FLUX2_DEFAULTS_BY_ID[entry.id];
    // Only upgrade entries that DIDN'T set `runner` at all — a user who
    // explicitly chose a different runner for a known flux2 id (e.g. to
    // wire it up to a custom runner) keeps that override.
    if (!seed || entry.runner !== undefined) return entry;
    // Only strip `broken: 'macos'` (the legacy flag the upgrade is meant
    // to clear). Any other broken value the user added is intentional and
    // preserved.
    const { broken, ...rest } = entry;
    const merged = { ...seed, ...rest, runner: RUNNER_FAMILIES.FLUX2 };
    if (broken !== undefined && broken !== 'macos') merged.broken = broken;
    return merged;
  });
};

// IDs whose underlying pipeline is step-wise distilled (Flux Schnell, FLUX.2
// Klein, Z-Image-Turbo). For these models, classifier-free guidance is fixed
// internally and any user-supplied guidance scale is silently ignored — the
// diffusers runner literally prints "Guidance scale X is ignored for step-
// wise distilled models." into the log on every render. Surface this as an
// explicit flag on each registry entry so the UI can hide the Guidance input
// and the runners can skip passing the flag.
const CFG_DISABLED_IDS = new Set([
  'schnell',
  'flux2-klein-4b',
  'flux2-klein-9b',
  'flux2-klein-9b-bf16',
  'flux2-klein-4b-int8',
  'z-image-turbo-bf16',
  'z-image-turbo-quant',
  'ernie-image-turbo',
  'hidream-i1-fast',
]);

const backfillCfgDisabled = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    if ('cfgDisabled' in entry) return entry; // user override (true OR false) wins
    if (!CFG_DISABLED_IDS.has(entry.id)) return entry;
    return { ...entry, cfgDisabled: true };
  });
};

// IDs whose underlying pipeline REQUIRES a source `image` arg (Qwen-Image-Edit
// loads QwenImageEditPipeline). A text-only render against one of these crashes
// deep inside diffusers, so the route rejects (and the UI gates) it up-front.
// Backfilled at load time — same pattern as cfgDisabled — so installs that
// stored their `qwen-image-edit` entry before this flag existed pick it up
// without a migration. Mirrored in data.reference/media-models.json.
const EDIT_ONLY_IDS = new Set([
  'qwen-image-edit',
]);

const backfillEditOnly = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    if ('editOnly' in entry) return entry; // user override (true OR false) wins
    if (!EDIT_ONLY_IDS.has(entry.id)) return entry;
    return { ...entry, editOnly: true };
  });
};

// Multi-reference editing on the bf16 path loads the `-kv` sibling repo. Map
// each id to the base repo it shipped with and the kv repo it should pair
// with. Existing installs stored their `flux2-klein-9b-bf16` entry before
// `kvRepo` existed, so backfill it at load (same pattern as
// cfgDisabled/editOnly) AND ship migration 064 for installs that have already
// persisted the registry. Mirrored in data.reference/media-models.json.
//
// Fork-preservation: only backfill when the entry's `repo` still matches the
// shipped base repo. A user who pointed `repo` at a fork must NOT get the
// upstream kv sibling silently injected (reference renders would mix a custom
// base with the upstream KV repo) — this mirrors migration 064's guard. A
// user-set `kvRepo` (any value, including '') always wins: `'kvRepo' in entry`
// is the override signal.
const KV_REPO_BY_ID = {
  'flux2-klein-9b-bf16': {
    shippedRepo: 'black-forest-labs/FLUX.2-klein-9B',
    kvRepo: 'black-forest-labs/FLUX.2-klein-9B-kv',
  },
};

const backfillKvRepo = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    if ('kvRepo' in entry) return entry; // user override wins
    const spec = KV_REPO_BY_ID[entry.id];
    if (!spec || entry.repo !== spec.shippedRepo) return entry; // unknown id or forked repo
    return { ...entry, kvRepo: spec.kvRepo };
  });
};

export const isFlux2 = (model) => model?.runner === RUNNER_FAMILIES.FLUX2;
export const isZImage = (model) => model?.runner === RUNNER_FAMILIES.Z_IMAGE;
export const isErnie = (model) => model?.runner === RUNNER_FAMILIES.ERNIE;
export const isHiDream = (model) => model?.runner === RUNNER_FAMILIES.HIDREAM;
export const isQwen = (model) => model?.runner === RUNNER_FAMILIES.QWEN;
export const isCfgDisabled = (model) => model?.cfgDisabled === true;
export const isEditOnly = (model) => model?.editOnly === true;

// Append models that are genuinely new in this release (not in
// _shippedDefaults) to the user's list, while respecting deletions the user
// already made. Returns both the merged entry list and the newly-added ids so
// the caller can record them in _shippedDefaults. Used for both video and
// image lists — the deletion-survives-upgrade contract is identical.
//
// Semantics:
//   - id already in userList             → keep as-is (user customisations intact)
//   - id in shippedIds but not userList  → user explicitly deleted it; skip
//   - id NOT in shippedIds               → genuinely new built-in; add + record
const appendNewlyShippedEntries = (userList, defaultList, shippedIds) => {
  const safeList = Array.isArray(userList) ? userList : [];
  const safeDefaults = Array.isArray(defaultList) ? defaultList : [];
  const userIds = new Set(safeList.map((e) => e?.id).filter((id) => typeof id === 'string'));
  const result = [...safeList];
  const newlyShipped = [];
  for (const def of safeDefaults) {
    if (typeof def?.id !== 'string') continue;
    if (userIds.has(def.id)) continue;       // already present — keep user copy
    if (shippedIds.has(def.id)) continue;    // user deleted it; don't re-add
    result.push(def);
    newlyShipped.push(def.id);
  }
  return { entries: result, newlyShipped };
};
// Existing installs predate the `runtime` field on video entries — fill it
// with 'mlx_video' (the legacy default) for known-legacy ids so the
// dispatch in videoGen/local.js routes them through `python -m
// mlx_video.generate_av` rather than treating undefined as ltx2.
const LEGACY_MLX_VIDEO_IDS = new Set(['ltx2_unified', 'ltx23_unified', 'ltx23_distilled_q4', 'ltx_video']);
const backfillRuntime = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    if (typeof entry.runtime === 'string' && entry.runtime.length > 0) return entry;
    if (LEGACY_MLX_VIDEO_IDS.has(entry.id)) return { ...entry, runtime: 'mlx_video' };
    return entry;
  });
};

// Build the initial shippedIds set for one platform on first encounter
// (no _shippedDefaults field yet).
//
// Pre-snapshot bootstrap: existing installs without _shippedDefaults can't
// distinguish "user explicitly removed this built-in" from "this built-in
// is new in this release". We choose to UNION the user's current ids with
// the current default ids, treating both as "already shipped". That preserves
// any deletions the user made before this feature existed, at the cost of new
// built-in models in this release also being marked as shipped — so they won't
// appear on this install until the user edits data/media-models.json directly.
//
// Trade-off favors data preservation over feature visibility: a user who curated
// their model list won't have it silently re-populated. Users who want the new
// built-ins can delete media-models.json and restart to re-seed from scratch,
// or add the entries manually.
//
// When the platform key is absent from their registry (e.g. the whole `video`
// section is missing), we return an empty set so the defaults are treated as
// genuinely new and get added as on a fresh install.
const bootstrapShippedIds = (userList, defaultList) => {
  if (!Array.isArray(userList)) return new Set(); // missing key → treat as fresh
  const safeDefaults = Array.isArray(defaultList) ? defaultList : [];
  const ids = new Set();
  for (const e of userList) if (typeof e?.id === 'string') ids.add(e.id);
  for (const e of safeDefaults) if (typeof e?.id === 'string') ids.add(e.id);
  return ids;
};

const normalizeRegistry = (parsed) => {
  const safe = isPlainObject(parsed) ? parsed : {};
  const safeVideo = isPlainObject(safe.video) ? safe.video : {};

  // _shippedDefaults tracks which built-in ids have ever been delivered
  // to this install, so we can distinguish "user deleted it" from "genuinely
  // new in this release". Tracked separately for video (per-platform) and
  // image (single list — image entries cover both platforms).
  const shippedVideo = isPlainObject(safe._shippedDefaults?.video) ? safe._shippedDefaults.video : null;
  const isVideoBootstrap = shippedVideo === null;

  const shippedMacosIds = isVideoBootstrap
    ? bootstrapShippedIds(safeVideo.macos, DEFAULT_REGISTRY.video.macos)
    : new Set(arrayOrDefault(shippedVideo.macos, []));
  const shippedWindowsIds = isVideoBootstrap
    ? bootstrapShippedIds(safeVideo.windows, DEFAULT_REGISTRY.video.windows)
    : new Set(arrayOrDefault(shippedVideo.windows, []));

  const macosResult = appendNewlyShippedEntries(
    safeVideo.macos,
    DEFAULT_REGISTRY.video.macos,
    shippedMacosIds,
  );
  const windowsResult = appendNewlyShippedEntries(
    safeVideo.windows,
    DEFAULT_REGISTRY.video.windows,
    shippedWindowsIds,
  );

  const updatedShippedVideo = {
    macos: [...shippedMacosIds, ...macosResult.newlyShipped],
    windows: [...shippedWindowsIds, ...windowsResult.newlyShipped],
  };

  // Image upgrade path. Same shape as video, single list. The flux2 upgrade
  // (upgradeImageEntries) runs first so legacy `broken: 'macos'` entries get
  // promoted to runner-aware ones before the new-entry append step looks at
  // their ids. Skips bootstrap union when the image key was missing entirely
  // (treat as fresh install — let the new entries land).
  const shippedImage = isPlainObject(safe._shippedDefaults?.image) ? safe._shippedDefaults.image : null;
  const isImageBootstrap = shippedImage === null;
  const upgradedImage = backfillKvRepo(backfillEditOnly(backfillCfgDisabled(
    upgradeImageEntries(arrayOrDefault(safe.image, DEFAULT_REGISTRY.image)),
  )));
  // Image bootstrap deliberately uses userIds ONLY (not union with defaults).
  // Image is getting `_shippedDefaults` for the first time in this release, so
  // there's no prior history of deletions to preserve via the union trick the
  // video side uses. Pre-existing installs will pick up the new built-ins
  // (z-image-turbo-*, etc.) on next boot. Subsequent loads use the persisted
  // list so user deletions stick.
  const upgradedImageIds = (Array.isArray(upgradedImage) ? upgradedImage : [])
    .map((e) => e?.id)
    .filter((id) => typeof id === 'string');
  const shippedImageIds = isImageBootstrap
    ? new Set(upgradedImageIds)
    : new Set(arrayOrDefault(shippedImage.list, []));
  const imageResult = appendNewlyShippedEntries(
    upgradedImage,
    DEFAULT_REGISTRY.image,
    shippedImageIds,
  );
  const updatedShippedImage = {
    list: [...shippedImageIds, ...imageResult.newlyShipped],
  };

  return {
    ...DEFAULT_REGISTRY,
    ...safe,
    image: imageResult.entries,
    textEncoders: arrayOrDefault(safe.textEncoders, DEFAULT_REGISTRY.textEncoders),
    video: {
      ...DEFAULT_REGISTRY.video,
      ...safeVideo,
      macos: backfillRuntime(macosResult.entries),
      windows: backfillRuntime(windowsResult.entries),
    },
    _shippedDefaults: {
      ...(safe._shippedDefaults || {}),
      video: updatedShippedVideo,
      image: updatedShippedImage,
    },
  };
};

// Detect drift between `_shippedDefaults` and the user's live list. We
// previously hit a real install (2026-05-09) where `_shippedDefaults.image.list`
// claimed all default ids had been shipped but the user's `image[]` array was
// missing several of them — most likely from a partial editor save or a
// concurrent-write race. The deletion-survives-upgrade contract then
// permanently skipped re-adding those built-ins on every restart. We DON'T
// auto-recover (that would defeat real deletions), but we make the drift
// loud at boot so a user / sysadmin can act on it.
//
// IMPORTANT: this state is structurally indistinguishable from an INTENTIONAL
// deletion — `appendNewlyShippedEntries` skips re-adding ids that are in
// shippedIds but not userList for exactly that reason. There is no "silence
// without re-adding" path today: removing an id from `_shippedDefaults`
// flips it back to "genuinely new built-in" and normalizeRegistry will
// re-append it on next boot. So if the absence is intentional, this log
// fires every restart — users can either live with it, or accept the
// re-add and delete the entry again from the UI. We surface it anyway
// because the silent-skipping behaviour was the original bug.
//
// `kind` is either 'image' (single list at `_shippedDefaults.image.list`)
// or 'video' (per-platform arrays at `_shippedDefaults.video.macos` /
// `_shippedDefaults.video.windows`).
const warnDrift = (kind, platform, shippedIds, defaultIds, presentIds) => {
  const shippedSet = new Set(shippedIds || []);
  const defaultSet = new Set(defaultIds || []);
  const presentSet = new Set(presentIds || []);
  for (const id of shippedSet) {
    if (!defaultSet.has(id)) continue;     // not a current built-in; ignore
    if (presentSet.has(id)) continue;      // present — no drift
    // shippedIds for image lives at `_shippedDefaults.image.list`; for video
    // it's `_shippedDefaults.video.{macos,windows}` directly. Surface the
    // accurate key so a copy-paste from the warning lands in the right place.
    const where = platform ? `${kind}.${platform}` : kind;
    const shippedKey = platform ? `_shippedDefaults.${kind}.${platform}` : `_shippedDefaults.${kind}.list`;
    console.log(`⚠️ media-models drift: built-in "${id}" was shipped but is missing from ${where}[] — if the deletion is intentional this warning will repeat each boot (no silence-without-restore path exists); to restore, either re-add the entry manually or delete ${shippedKey} entirely to re-bootstrap`);
  }
};

export const loadMediaModels = () => {
  if (cached) return cached;
  seedIfMissing();
  // Catch read AND parse failures — both can happen at module import-time
  // (videoGen/imageGen import this synchronously), so an unhandled throw
  // here aborts server startup. Permissions, broken symlink, transient I/O
  // all surface from readFileSync; malformed JSON from JSON.parse.
  let parsed = DEFAULT_REGISTRY;
  let readOk = false;
  try {
    const raw = readFileSync(REGISTRY_FILE, 'utf-8');
    parsed = JSON.parse(raw);
    readOk = true;
  } catch (err) {
    console.log(`⚠️ Failed to load ${REGISTRY_FILE} (${err.message}) — using built-in defaults`);
  }
  // Drift check runs on the RAW parsed file (pre-normalize), because
  // normalizeRegistry uses _shippedDefaults to decide which built-ins to
  // re-add and which to skip. We want to surface the mismatch as it exists
  // on disk, not the post-merge view. Skip when no parsed file at all (the
  // catch above already logged) or when _shippedDefaults isn't populated yet
  // (bootstrap path — no drift is possible).
  if (readOk && isPlainObject(parsed?._shippedDefaults)) {
    const sd = parsed._shippedDefaults;
    if (isPlainObject(sd.image) && Array.isArray(parsed.image)) {
      warnDrift(
        'image',
        null,
        Array.isArray(sd.image.list) ? sd.image.list : [],
        DEFAULT_REGISTRY.image.map((m) => m.id),
        parsed.image.map((m) => m?.id).filter((id) => typeof id === 'string'),
      );
    }
    if (isPlainObject(sd.video) && isPlainObject(parsed.video)) {
      if (Array.isArray(sd.video.macos) && Array.isArray(parsed.video.macos)) {
        warnDrift(
          'video',
          'macos',
          sd.video.macos,
          DEFAULT_REGISTRY.video.macos.map((m) => m.id),
          parsed.video.macos.map((m) => m?.id).filter((id) => typeof id === 'string'),
        );
      }
      if (Array.isArray(sd.video.windows) && Array.isArray(parsed.video.windows)) {
        warnDrift(
          'video',
          'windows',
          sd.video.windows,
          DEFAULT_REGISTRY.video.windows.map((m) => m.id),
          parsed.video.windows.map((m) => m?.id).filter((id) => typeof id === 'string'),
        );
      }
    }
  }
  cached = normalizeRegistry(parsed);
  // Persist _shippedDefaults back to disk whenever it was absent or gained new
  // ids (bootstrap run or a new built-in model shipped in this release). This
  // ensures user deletions survive the next server restart.
  if (readOk) {
    const parsedShippedVideo = isPlainObject(parsed._shippedDefaults?.video)
      ? parsed._shippedDefaults.video
      : null;
    const parsedShippedImage = isPlainObject(parsed._shippedDefaults?.image)
      ? parsed._shippedDefaults.image
      : null;
    const normalizedVideo = cached._shippedDefaults.video;
    const normalizedImage = cached._shippedDefaults.image;
    const videoChanged =
      parsedShippedVideo === null ||
      normalizedVideo.macos.length !== (parsedShippedVideo.macos?.length ?? 0) ||
      normalizedVideo.windows.length !== (parsedShippedVideo.windows?.length ?? 0);
    const imageChanged =
      parsedShippedImage === null ||
      normalizedImage.list.length !== (parsedShippedImage.list?.length ?? 0);
    if (videoChanged || imageChanged) {
      writeFileSync(REGISTRY_FILE, JSON.stringify(cached, null, 2) + '\n');
      console.log(`📝 Updated media model registry _shippedDefaults: ${REGISTRY_FILE}`);
    }
  }
  return cached;
};

// Bust the boot-only cache so the next loadMediaModels() re-reads the file.
// The registry is cached at module scope (videoGen/imageGen import it
// synchronously at boot), so a runtime add/edit/remove must invalidate the
// cache or the change 400s ("Unknown model") until a server restart — the
// exact gotcha called out in issue #2124. Returns the freshly-loaded registry.
export const reloadMediaModels = () => {
  cached = null;
  return loadMediaModels();
};

// Persist a registry object to disk and swap it in as the cache. The cache is
// only replaced AFTER a successful write, so a persist failure leaves the live
// cache untouched (the mutators build an immutable `next` rather than editing
// the shared cache in place). Single-user trust model → no file lock needed.
const persistRegistry = (reg) => {
  ensureDir(REGISTRY_FILE);
  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2) + '\n');
  cached = reg;
  return reg;
};

// A user-added entry (from the "add from HuggingFace" flow) carries
// `source: 'user'`. Shipped built-ins have no `source` (or a non-'user' one
// like 'trained' won't appear here). Only user entries are editable/removable
// through the API — built-ins are read-only (the registry is their source of
// truth + they round-trip through the shipped-defaults upgrade machinery).
export const isUserModelEntry = (entry) => entry?.source === 'user';

// Locate a model entry by id across every list (video macos/windows + image),
// returning `{ entry, list, listKey, idx }` or null. `listKey` ('macos' |
// 'windows' | 'image') lets the mutators rebuild just the affected list
// immutably (no deep clone of the whole registry).
const findModelLocation = (reg, id) => {
  const lists = [
    ['macos', reg.video?.macos],
    ['windows', reg.video?.windows],
    ['image', reg.image],
  ];
  for (const [listKey, list] of lists) {
    if (!Array.isArray(list)) continue;
    const idx = list.findIndex((m) => m?.id === id);
    if (idx >= 0) return { entry: list[idx], list, listKey, idx };
  }
  return null;
};

// Rebuild the registry with one list replaced — shallow everywhere except the
// swapped array, so we neither deep-clone the whole registry nor mutate the
// live cache before the write succeeds.
const withList = (reg, listKey, nextList) =>
  listKey === 'image'
    ? { ...reg, image: nextList }
    : { ...reg, video: { ...reg.video, [listKey]: nextList } };

// Add a user model entry to the registry. `kind` selects the target list:
// 'video' → the current platform's video list; 'image' → the image list.
// Throws on a duplicate id (a repo already added). Persists + hot-reloads.
export const addUserModelEntry = (entry, { kind }) => {
  if (!entry || typeof entry.id !== 'string') {
    throw new ServerError('Model entry must carry a string id', { status: 400, code: 'BAD_MODEL_ENTRY' });
  }
  if (kind !== 'video' && kind !== 'image') {
    throw new ServerError(`Unknown model kind "${kind}" — expected "image" or "video".`, { status: 400, code: 'BAD_MODEL_KIND' });
  }
  const reg = loadMediaModels();
  const listKey = kind === 'video' ? (IS_WIN ? 'windows' : 'macos') : 'image';
  // Conflict-check only the TARGET list, not every list. A shared
  // media-models.json used across a macOS + Windows peer stores a video model
  // per-platform; the same repo must remain addable on the other platform's
  // list even though it already exists on the first — a global scan would
  // wrongly 409 and leave no self-service way to enable it there.
  const current = (listKey === 'image' ? reg.image : reg.video?.[listKey]) || [];
  if (current.some((m) => m?.id === entry.id)) {
    throw new ServerError(
      `A model with id "${entry.id}" is already in the ${kind} registry for this platform (repo already added?). Remove it first to re-add.`,
      { status: 409, code: 'MODEL_ALREADY_EXISTS' },
    );
  }
  persistRegistry(withList(reg, listKey, [...current, entry]));
  console.log(`📝 Added user media model: ${entry.id} (${kind}) → ${entry.repo || '?'}`);
  return entry;
};

// Guard shared by patch/remove: locate a USER entry by id or throw (404 for
// unknown, 403 for a built-in). Returns the `findModelLocation` result.
const requireUserEntry = (reg, id, verb) => {
  const loc = findModelLocation(reg, id);
  if (!loc) throw new ServerError(`Unknown model id: ${id}`, { status: 404, code: 'NOT_FOUND' });
  if (!isUserModelEntry(loc.entry)) {
    throw new ServerError(
      `Model "${id}" is a built-in — built-in models can't be ${verb} through this surface.`,
      { status: 403, code: 'MODEL_READONLY' },
    );
  }
  return loc;
};

// Patch a USER model entry's editable fields (name, steps, guidance). Refuses
// built-ins and unknown ids. Persists + hot-reloads. Returns the updated entry.
const USER_EDITABLE_FIELDS = new Set(['name', 'steps', 'guidance']);
export const patchUserModelEntry = (id, patch) => {
  const reg = loadMediaModels();
  const loc = requireUserEntry(reg, id, 'edited');
  const cleanPatch = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (USER_EDITABLE_FIELDS.has(k) && v !== undefined) cleanPatch[k] = v;
  }
  const updated = { ...loc.entry, ...cleanPatch, id, source: 'user' };
  const nextList = loc.list.map((m, i) => (i === loc.idx ? updated : m));
  persistRegistry(withList(reg, loc.listKey, nextList));
  console.log(`📝 Patched user media model: ${id}`);
  return updated;
};

// Remove a USER model entry. Refuses built-ins and unknown ids. Persists +
// hot-reloads. Returns `{ ok, id }`.
export const removeUserModelEntry = (id) => {
  const reg = loadMediaModels();
  const loc = requireUserEntry(reg, id, 'removed');
  const nextList = loc.list.filter((_, i) => i !== loc.idx);
  persistRegistry(withList(reg, loc.listKey, nextList));
  console.log(`🗑️ Removed user media model: ${id}`);
  return { ok: true, id };
};

const platformBroken = (broken) =>
  broken === true || (typeof broken === 'string' && broken === (IS_WIN ? 'windows' : 'macos'));

export const getVideoModels = () => {
  const reg = loadMediaModels();
  const list = IS_WIN ? (reg.video.windows || []) : (reg.video.macos || []);
  return list.filter((m) => !platformBroken(m.broken));
};

export const getDefaultVideoModelId = () => {
  const reg = loadMediaModels();
  // Note: defaultMacos / defaultWindows may legitimately point at a model
  // flagged `deprecated: true` — the dgrauet (non-deprecated) runtime
  // requires an opt-in venv (`INSTALL_LTX2=1 bash scripts/setup-image-video.sh`),
  // so the shipped default must stay on a model that works out of the box.
  // The UI dropdowns surface dgrauet at the top via the `Legacy` optgroup
  // pattern; user-driven migration > auto-rolling forward.
  const configuredId = IS_WIN ? reg.video.defaultWindows : reg.video.defaultMacos;
  // Validate against the platform's available (non-broken) list — a typo or
  // a model marked broken on this platform would otherwise surface as
  // "Unknown video model" the first time the UI tries to use the default.
  const available = getVideoModels();
  if (available.some((m) => m.id === configuredId)) return configuredId;
  const fallback = available[0]?.id;
  if (fallback) {
    console.log(`⚠️ Unknown default video model "${configuredId}" for ${IS_WIN ? 'windows' : 'macos'}; falling back to "${fallback}"`);
    return fallback;
  }
  console.log(`⚠️ Unknown default video model "${configuredId}" for ${IS_WIN ? 'windows' : 'macos'}; no available models to fall back to`);
  return configuredId;
};

export const getImageModels = () => {
  const reg = loadMediaModels();
  return (reg.image || []).filter((m) => !platformBroken(m.broken));
};

// Map a registry entry to the HuggingFace repo id whose weights need to be
// resident on disk before generation can run. Used by the download-status
// badge on the image/video gen forms.
//
// Most entries already carry `repo` directly. mflux's legacy `dev` / `schnell`
// ids predate the field and resolve to the canonical Black Forest Labs repos
// at runtime via the `mflux-generate` CLI — hardcode those two so the badge
// can probe their HF cache the same way as every other model.
const MFLUX_LEGACY_REPOS = {
  dev: 'black-forest-labs/FLUX.1-dev',
  schnell: 'black-forest-labs/FLUX.1-schnell',
};

export const repoForModel = (model) => {
  if (!model || typeof model !== 'object') return null;
  if (isNonEmptyString(model.repo)) return model.repo;
  if (MFLUX_LEGACY_REPOS[model.id]) return MFLUX_LEGACY_REPOS[model.id];
  return null;
};

// Full list of HF repos a model needs cached on disk before the runner can
// inference. For HiDream entries this includes the separate Llama-3.1 text
// encoder (`textEncoderRepo`) the Diffusers pipeline loads as `text_encoder_4`
// — otherwise the cache-status badge says "Available" while the renderer
// silently kicks off a second multi-GB gated download at start-up. Result is
// `null` when the main repo itself isn't known (model is misconfigured / a
// custom mflux third-party entry).
export const requiredReposForModel = (model) => {
  const main = repoForModel(model);
  if (!main) return null;
  const aux = [];
  if (isNonEmptyString(model?.textEncoderRepo)) aux.push(model.textEncoderRepo);
  return [main, ...aux];
};

// `getTextEncoderRepo()` can return either an HF repo id (`org/name`) or a
// resolved local filesystem path when the registry entry has a `localPath`
// override. Only `org/name` is a valid input to HF-cache inspection /
// download endpoints.
//
// Reject local-path shapes across platforms:
//  - POSIX absolute / home-relative: `/foo/bar`, `~/foo`
//  - Windows drive paths (both backslash and forward-slash style): `C:\…`,
//    `C:/Users/…` — without this check, a Windows install with a
//    forward-slash-style localPath text encoder would be misclassified as
//    an HF repo, triggering bogus cache inspection / download requests.
//  - Windows UNC paths: `\\server\share\…`
//  - Any path containing a backslash (Windows separator)
// Then require exactly one `/` separator — standard HF repo ids are the
// `org/name` shape; zero (`legacy-bare-name`) and multiple (a path) are not.
export const isHfRepoId = (value) => {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (value.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return (value.match(/\//g) || []).length === 1;
};

// Resolve the active text encoder to a path mlx_video can pass via
// --text-encoder-repo. Prefers `localPath` (e.g. an existing LM Studio
// install) when it exists; otherwise returns the HF repo id which mlx_video
// will resolve via the HF cache (downloading on first run).
const FALLBACK_TEXT_ENCODER_REPO = 'mlx-community/gemma-3-12b-it-4bit';
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

export const getTextEncoderRepo = () => {
  const reg = loadMediaModels();
  const id = reg.selectedTextEncoder;
  const entry = (reg.textEncoders || []).find((t) => t.id === id);
  if (!entry) {
    console.log(`⚠️ Unknown selectedTextEncoder "${id}"; falling back to first entry`);
    const firstRepo = reg.textEncoders?.[0]?.repo;
    return isNonEmptyString(firstRepo) ? firstRepo : FALLBACK_TEXT_ENCODER_REPO;
  }
  if (entry.localPath) {
    const expanded = expandHome(entry.localPath);
    if (existsSync(expanded)) return expanded;
  }
  // Spawn args must be non-empty strings — a malformed registry entry
  // (missing/empty `repo`) would otherwise reach mlx_video as undefined and
  // surface as a confusing TypeError or downstream CLI error.
  if (!isNonEmptyString(entry.repo)) {
    console.log(`⚠️ Text encoder "${id}" has no repo; falling back to "${FALLBACK_TEXT_ENCODER_REPO}"`);
    return FALLBACK_TEXT_ENCODER_REPO;
  }
  return entry.repo;
};

export const getTextEncoderEntries = () => {
  const reg = loadMediaModels();
  return (reg.textEncoders || []).map((t) => ({
    id: t.id,
    label: t.label,
    repo: t.repo,
    localPath: t.localPath ? expandHome(t.localPath) : null,
    localAvailable: t.localPath ? existsSync(expandHome(t.localPath)) : false,
    selected: t.id === reg.selectedTextEncoder,
  }));
};
