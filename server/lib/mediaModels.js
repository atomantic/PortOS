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
 *   - video.mlx[], video.cuda[]: { id, name, repo?, steps, guidance, broken?, disclosure?, hardwareRequirements? }
 *       The two buckets split on RUNTIME FAMILY, not operating system: `mlx`
 *       holds the Apple-MLX runtimes, `cuda` the plain torch+CUDA ones (which
 *       run on Windows AND Linux). They were keyed `macos` / `windows` before
 *       issue #4142; both spellings still load — see lib/mediaModelBuckets.js.
 *       Models may also declare `defaultWidth` / `defaultHeight`,
 *       `resolutionStep`, and `resolutionOptions[]` when their native canvas
 *       differs from the shared Video Gen presets.
 *       `repoFiles[]` (optional) narrows the model's OWN `repo` to an explicit
 *       list of repo-relative POSIX filenames, the way `requiredWeights[].files`
 *       already does for a secondary repo. Absent means "snapshot the whole
 *       repo", which is right for a repo that holds exactly one model. Declare
 *       it when the repo is an AGGREGATE holding more than the runner loads —
 *       `MiniMaxAI/MiniMax-H3` ships three layouts totalling ~498 GB where the
 *       CUDA runner needs ~144 GB of them — since the download, cache-status,
 *       integrity-verify and repair paths all fan out from the same
 *       `modelDownloadTargets()` in routes/videoGen.js and would otherwise pull
 *       and checksum the lot.
 *       `offloadProfile` (optional, `minimax_h3_cuda` only) pins the weight
 *       offload recipe to one of `auto` / `bf16` / `int8-stream` / `int8-lean`
 *       instead of letting the runner size one from the card's own VRAM. Left
 *       absent on the shipped entry deliberately: the registry syncs between
 *       peers and cannot know what GPU is on the other end. Validated in
 *       services/videoGen/local.js against MINIMAX_H3_CUDA_OFFLOAD_PROFILES.
 *       `memoryProfiles` (issue #5420) is the declared, capability-checked
 *       weight-placement table for the two MiniMax H3 entries — each profile's
 *       honest host-RAM and device-VRAM floor, best-first. Declared in
 *       lib/minimaxH3Memory.js and backfilled at load like `disclosure` and
 *       `speedProfiles`; the render path fails closed when no profile fits the
 *       measured machine, and the runners re-select on the same table.
 *       `disclosure` is optional provenance/licensing metadata (issue #3674):
 *       { modelCardUrl?, weightsLicense?: { name, url }, runtimeLicense?: { name, url },
 *         estimatedDownloadGb?, reviewedAt? }. Every key is optional and an
 *       absent key means "not established" — the UI renders it as Unknown
 *       rather than guessing. Canonical fields (repo/revision/runtime/memoryGb/
 *       supportedModes/requiredWeights/repoFiles) are NOT duplicated inside it. Shipped
 *       values live in lib/videoDisclosure.js and are backfilled at load.
 *       `finishModelId` (optional, issue #3696) names the delivery model a
 *       fast draft entry finishes into — declared in lib/videoFinishProfiles.js,
 *       backfilled at load, and validated (invalid edges are dropped, loudly).
 *       `supportedModes` (issue #3737) is resolved for EVERY entry by
 *       getVideoModels() from lib/videoModeProfiles.js's per-runtime table when
 *       the entry doesn't declare its own, so no consumer has to treat "absent"
 *       as "supports everything". A declared list always wins.
 *   - video.defaultMlx / video.defaultCuda: id of the default model
 *     (legacy `defaultMacos` / `defaultWindows` still read)
 *   - image[]: { id, name, steps, guidance, broken?, hardwareRequirements? }
 *   - textEncoders[]: { id, label, repo, localPath? }
 *   - selectedTextEncoder: id of the active text encoder
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { PATHS, expandHome } from './fileUtils.js';
import { isPlainObject } from './objects.js';
import {
  LEGACY_VIDEO_KEYS,
  VIDEO_BUCKETS,
  VIDEO_DEFAULT_KEYS,
  activeVideoBucket,
  matchesVideoBucket,
  readVideoBucket,
  readVideoDefault,
  resolveVideoBucketKey,
} from './mediaModelBuckets.js';
import { RUNNER_FAMILIES } from './runners.js';
import { ServerError } from './errorHandler.js';
import { applyVideoDisclosures } from './videoDisclosure.js';
import { applyVideoFinishProfiles, sanitizeFinishProfiles } from './videoFinishProfiles.js';
import { applyVideoSpeedProfiles, sanitizeSpeedProfiles } from './videoSpeedProfiles.js';
import { applyVideoDraftDecoders, sanitizeDraftDecoders } from './videoDraftDecoders.js';
import { applyMiniMaxH3MemoryProfiles, sanitizeMiniMaxH3MemoryProfiles } from './minimaxH3Memory.js';
import { applyVideoSupportedModes } from './videoModeProfiles.js';
import { LTX25_AUDIO_PROFILE } from './videoDurationProfiles.js';
import {
  captureSystemCapabilities,
  hardwareRequirementsForMediaModel,
  isHardwareCompatible,
  withHardwareCompatibility,
} from './systemCapabilities.js';
// fileUtils.ensureDir is async/Promise-returning; this module needs a
// synchronous version because `loadMediaModels()` is called at import-time
// from videoGen/imageGen modules, which can't await before exporting.

// Allow tests + non-standard deployments to point at a different file
// without monkey-patching PATHS. Defaults to data/media-models.json.
const REGISTRY_FILE = process.env.PORTOS_MEDIA_MODELS_FILE || join(PATHS.data, 'media-models.json');

// Migration 267 and the load-time normalizer share this exact shipped-profile
// contract. The load-time half is essential because route imports can cache the
// registry before bootstrap migrations run; a later registry edit would
// otherwise persist that stale object over the migrated file in the same boot.
// MiniMax H3's canvas contract — a property of the CHECKPOINT, so it is
// identical on the MLX port and the diffusers CUDA path. H3-Base was trained on
// a native 768px short edge; its canvas resolver caps area at 768x1344 and
// rounds each edge to 32px, and these are the exact outputs for the aspect
// ratios MiniMax documents. Both model entries spread this rather than restating
// it — `mediaModels.test.js` asserts they stay identical.
export const MINIMAX_H3_CANVAS = Object.freeze({
  defaultWidth: 1344,
  defaultHeight: 768,
  resolutionStep: 32,
  resolutionOptions: Object.freeze([
    Object.freeze({ label: '1536x672 (21:9 H3 native)', w: 1536, h: 672 }),
    Object.freeze({ label: '1344x768 (16:9 H3 default)', w: 1344, h: 768 }),
    Object.freeze({ label: '1024x768 (4:3 H3 native)', w: 1024, h: 768 }),
    Object.freeze({ label: '768x768 (1:1 H3 native)', w: 768, h: 768 }),
    Object.freeze({ label: '768x1024 (3:4 H3 native)', w: 768, h: 1024 }),
    Object.freeze({ label: '768x1344 (9:16 H3 native)', w: 768, h: 1344 }),
  ]),
});

// H3's video VAE decodes only frame counts on the 17n+5 grid, so every frame
// list PortOS ships is an arithmetic sequence stepping by 17 — the runners
// enforce the same modulus. Generated rather than typed out for the reason
// `shardFiles` below is: a single wrong digit among the ~45 literals these three
// lists would otherwise need is invisible in review and surfaces only as a
// rejected render, and the three lists could silently disagree about the grid.
const h3FrameGrid = (min, max) => {
  const out = [];
  for (let frames = min; frames <= max; frames += 17) out.push(frames);
  return Object.freeze(out);
};

// FastH3 Preview v1's output contract (#5860). It is a distilled MiniMax H3, so
// it inherits H3's 17n+5 VAE frame grid and 32px edge rounding — but NOT H3's
// canvas: the MLX FastH3 entry point is validated at 832x480 (its own default,
// and the resolution upstream's conversion manifest records a passing 124-frame
// generation at), and its docstring documents 1280x720 as the other supported
// request. `resolutionOptions` are presets rather than a whitelist, so a custom
// size still resolves through `resolutionStep`.
export const FASTH3_OUTPUT_PROFILE = Object.freeze({
  frameOptions: h3FrameGrid(107, 362),
  fpsOptions: Object.freeze([24]),
  resolutionStep: 32,
  resolutionOptions: Object.freeze([
    Object.freeze({ label: '832x480 (16:9 FastH3 default)', w: 832, h: 480 }),
    Object.freeze({ label: '1280x720 (16:9 HD)', w: 1280, h: 720 }),
  ]),
});

// The MLX entry's output profile: the shared canvas above PLUS the upgrade
// machinery migration 267 and `upgradeMiniMaxH3OutputControls` key off (the id,
// the repo it was checked against, and the frame list it supersedes). That
// upgrade half is specific to this one registry row, which is why the canvas is
// factored out rather than left tangled with it.
export const MINIMAX_H3_OUTPUT_PROFILE = Object.freeze({
  id: 'minimax_h3_8bit',
  shippedRepo: 'pipenetwork/MiniMax-H3-MLX-8bit',
  oldFrameOptions: h3FrameGrid(124, 362),
  frameOptions: h3FrameGrid(107, 362),
  oldMlxSteps: 8,
  mlxSteps: 9,
  oldMlxSamplerNote: 'MiniMax H3 is CFG-distilled; this profile locks the validated 8-point sigma schedule and does not use CFG.',
  mlxSamplerNote: 'MiniMax H3 is CFG-distilled; this profile locks the MLX reference 9-point sigma schedule (8 DiT forwards) and does not use CFG.',
  ...MINIMAX_H3_CANVAS,
});

// Expand one diffusers sharded-component file set. Written out rather than
// listed literally because these are 14- and 3-way shards whose names differ
// only by index — a hand-typed list is 30+ near-identical lines in which a
// single wrong digit is invisible in review and surfaces only as a failed
// cache resolve mid-render.
const shardFiles = (dir, stem, count) => Array.from(
  { length: count },
  (_, i) => `${dir}/${stem}-${String(i + 1).padStart(5, '0')}-of-${String(count).padStart(5, '0')}.safetensors`,
);

// MiniMax H3 on CUDA loads through diffusers' `MiniMaxH3ModularPipeline`, whose
// `fl2va` workflow reads the `transformer/` partition plus the shared
// conditioner, VAEs, tokenizers and schedulers.
//
// This MUST stay an explicit file list rather than a repo snapshot.
// `MiniMaxAI/MiniMax-H3` is ~498 GB: it ships the diffusers layout enumerated
// here (~144 GB), the `transformer_ref/` partition for the `ref2va` workflow
// PortOS does not expose (~66 GB), and the ORIGINAL non-diffusers `FL2VA/` +
// `Ref2VA/` layouts (~144 GB each) that the MLX port consumes. A snapshot would
// pull 3.5x what the render path can use.
const MINIMAX_H3_CUDA_REPO_FILES = Object.freeze([
  'LICENSE',
  'modular_model_index.json',
  'transformer/config.json',
  'transformer/diffusion_pytorch_model.safetensors.index.json',
  ...shardFiles('transformer', 'diffusion_pytorch_model', 14),
  'text_encoder/config.json',
  'text_encoder/model.safetensors.index.json',
  ...shardFiles('text_encoder', 'model', 14),
  'text_encoder/chat_template.json',
  'text_encoder/merges.txt',
  'text_encoder/preprocessor_config.json',
  'text_encoder/tokenizer.json',
  'text_encoder/tokenizer_config.json',
  'text_encoder/video_preprocessor_config.json',
  'text_encoder/vocab.json',
  'vae/config.json',
  'vae/diffusion_pytorch_model.safetensors.index.json',
  ...shardFiles('vae', 'diffusion_pytorch_model', 3),
  'audio_vae/config.json',
  'audio_vae/diffusion_pytorch_model.safetensors',
  // The Qwen3-VL processor/tokenizer pair the keyframe (image / FFLF) path
  // runs conditioning images through. ~20 MB, so it rides along rather than
  // becoming a second opt-in pull the way a multi-GB component would.
  'processor/chat_template.json',
  'processor/merges.txt',
  'processor/preprocessor_config.json',
  'processor/tokenizer.json',
  'processor/tokenizer_config.json',
  'processor/video_preprocessor_config.json',
  'processor/vocab.json',
  'tokenizer/merges.txt',
  'tokenizer/tokenizer.json',
  'tokenizer/tokenizer_config.json',
  'tokenizer/vocab.json',
  'scheduler/scheduler_config.json',
  'audio_scheduler/scheduler_config.json',
]);

const LTX25_CUDA_REPO_FILES = Object.freeze([
  'diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors',
  'text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors',
  'vae/ltx-2.5-video-vae-bf16.safetensors',
  'vae/ltx-2.5-audio-vae-bf16.safetensors',
  'model_patches/ltx-2.5-duration-head-bf16.safetensors',
  'latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors',
]);

// The diffusers integration's duration window, which is NARROWER than the MLX
// port's at both ends: frames are snapped up to the next 17n+5 and the RESULTING
// duration must land in 5-15 s, so 107 (4.46 s) is under the floor and 362
// (15.08 s) is over the ceiling. Mirrored by MIN_FRAMES / MAX_FRAMES in
// scripts/generate_minimax_h3_cuda.py, which rejects the same values.
const MINIMAX_H3_CUDA_FRAME_OPTIONS = h3FrameGrid(124, 345);

const sameValues = (left, right) => (
  Array.isArray(left)
  && left.length === right.length
  && left.every((value, index) => value === right[index])
);

const upgradeMiniMaxH3DenoisingCountEntry = (entry, profile) => {
  if (!isPlainObject(entry) || entry.id !== profile.id || entry.repo !== profile.shippedRepo) return entry;
  // The MLX port treats `steps` as sigma-grid points, with the terminal zero
  // excluded from transformer evaluation. The old shipped value therefore
  // ran seven forwards, while the reference quality example uses nine grid
  // points for eight forwards. Preserve a hand-tuned sampler contract.
  const samplerIsLegacyShipped = entry.steps === profile.oldMlxSteps
    && (!Object.hasOwn(entry, 'guidance') || entry.guidance === 0)
    && (!Object.hasOwn(entry, 'samplerLocked') || entry.samplerLocked === true)
    && (!Object.hasOwn(entry, 'samplerNote') || entry.samplerNote === profile.oldMlxSamplerNote);
  return samplerIsLegacyShipped
    ? { ...entry, steps: profile.mlxSteps, samplerNote: profile.mlxSamplerNote }
    : entry;
};

export const upgradeMiniMaxH3DenoisingCount = (list) => {
  if (!Array.isArray(list)) return list;
  const profile = MINIMAX_H3_OUTPUT_PROFILE;
  return list.map((entry) => upgradeMiniMaxH3DenoisingCountEntry(entry, profile));
};

export const upgradeMiniMaxH3OutputControls = (list) => {
  if (!Array.isArray(list)) return list;
  const profile = MINIMAX_H3_OUTPUT_PROFILE;
  const withGeometry = list.map((entry) => {
    if (!isPlainObject(entry) || entry.id !== profile.id || entry.repo !== profile.shippedRepo) return entry;
    let next = entry;
    if (sameValues(next.frameOptions, profile.oldFrameOptions)) {
      next = { ...next, frameOptions: [...profile.frameOptions] };
    }
    if (!Object.hasOwn(next, 'defaultWidth') && !Object.hasOwn(next, 'defaultHeight')) {
      next = { ...next, defaultWidth: profile.defaultWidth, defaultHeight: profile.defaultHeight };
    }
    // The step and presets describe one geometry contract. If either side was
    // customized, preserve the pair rather than installing presets that may be
    // off-grid for the user's declared step (or vice versa).
    if (!Object.hasOwn(next, 'resolutionStep') && !Object.hasOwn(next, 'resolutionOptions')) {
      next = {
        ...next,
        resolutionStep: profile.resolutionStep,
        resolutionOptions: profile.resolutionOptions.map((preset) => ({ ...preset })),
      };
    }
    return next;
  });
  return upgradeMiniMaxH3DenoisingCount(withGeometry);
};

// Existing installs already persisted the shipped LTX-2.5 row before its A2V
// duration contract was declared. Backfill only the untouched pinned model and
// only absent keys: a user-repointed fork or an explicit local override remains
// authoritative. Migration 318 persists the same fields, while this load-time
// twin matters on the boot that runs the migration because the registry cache is
// populated before migrations execute.
export const upgradeLtx25AudioControls = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry)
      || entry.id !== LTX25_AUDIO_PROFILE.id
      || entry.repo !== LTX25_AUDIO_PROFILE.repo
      || entry.revision !== LTX25_AUDIO_PROFILE.revision) return entry;
    const missing = ['audioDurationDriven', 'frameStride', 'maxNumFrames']
      .filter((key) => !Object.hasOwn(entry, key));
    return missing.length === 0
      ? entry
      : { ...entry, ...Object.fromEntries(missing.map((key) => [key, LTX25_AUDIO_PROFILE[key]])) };
  });
};

const DEFAULT_REGISTRY = {
  _doc: 'PortOS media model registry. Edit to add models, tune defaults, or switch the text encoder. Restart the server to apply changes.',
  video: {
    // `applyVideoDisclosures` attaches the shipped provenance/licensing block
    // (lib/videoDisclosure.js) to each entry, so the seed written on a fresh
    // install, the in-memory defaults, and data.reference/media-models.json all
    // carry the same disclosure without repeating it inline here.
    // `applyVideoFinishProfiles` attaches the shipped draft → delivery
    // `finishModelId` edges (lib/videoFinishProfiles.js) the same way, so the
    // Finish relationship is declared in one place instead of inline here.
    // `applyVideoSpeedProfiles` (lib/videoSpeedProfiles.js) is the third such
    // decorator: it attaches the shipped `speedProfiles` a model offers, pin-
    // guarded on repo AND revision so a re-pointed entry keeps no schedule
    // claim we can't back. `applyVideoDraftDecoders`
    // (lib/videoDraftDecoders.js) is the fourth, attaching the separately
    // downloaded preview-fidelity decoder a model can render drafts on.
    mlx: applyMiniMaxH3MemoryProfiles(applyVideoDraftDecoders(applyVideoSpeedProfiles(applyVideoFinishProfiles(applyVideoDisclosures([
      // notapalindrome's mlx-video-with-audio runtime — single PyPI package,
      // T2V/I2V only, FFLF degrades to last-frame conditioning (one --image arg).
      // LTX-2 Unified (the older 42 GB model) was retired in favour of 2.3 —
      // see RETIRED_VIDEO_MODELS. 2.3 Unified bf16 is the quality ceiling for
      // the mlx_video runtime and is practical on 128 GB unified-memory
      // hardware, while Distilled Q4 is both smaller and better than LTX-2 was,
      // and stays the shipped default because it works on smaller boxes.
      { id: 'ltx23_unified',      name: 'LTX-2.3 Unified Beta (~48 GB, bf16 quality ceiling)', repo: 'notapalindrome/ltx23-mlx-av',    runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4 (~22 GB)',   repo: 'notapalindrome/ltx23-mlx-av-q4', runtime: 'mlx_video', steps: 25, guidance: 3.0 },
      // dgrauet's ltx-2-mlx runtime — true KeyframeInterpolationPipeline,
      // native video Extend, audio→video. Requires a separate venv synced
      // via `INSTALL_LTX2=1 bash scripts/setup-image-video.sh`.
      { id: 'ltx23_dgrauet_q4',   name: 'LTX-2.3 dgrauet Q4 (~16 GB, true keyframes)', repo: 'dgrauet/ltx-2.3-mlx-q4', runtime: 'ltx2', steps: 8, guidance: 3.0 },
      { id: 'ltx23_dgrauet_q8',   name: 'LTX-2.3 dgrauet Q8 (~25 GB, true keyframes)', repo: 'dgrauet/ltx-2.3-mlx-q8', runtime: 'ltx2', steps: 8, guidance: 3.0 },
      // LTX-2.5 Q8 on MrMofer's ltx25 fork of dgrauet/ltx-2-mlx. The 2.3 pin
      // cannot load these weights; INSTALL_LTX25 provisions a sibling venv.
      {
        id: 'ltx25_mlx_q8',
        name: 'LTX-2.5 MLX Q8 (~68 GB, Apple Silicon)',
        repo: 'MrMofer/ltx-2.5-mlx-q8',
        revision: 'f1b56e7dc89f71a9af2cddac787b89ed22a8b7fc',
        runtime: 'ltx25',
        // A2V accepts an optional frame-one image. PortOS probes a direct audio
        // upload and rounds its full duration up to the LTX 8n+1 grid. 1017 is
        // the highest legal count under the route's 1024-frame single-pass cap.
        audioDurationDriven: true,
        frameStride: 8,
        maxNumFrames: 1017,
        steps: 8,
        guidance: 3.0,
      },
      // MiniMax H3 joint video+audio through PipeNetwork's pinned MLX port.
      // The quantized DiT is one HF snapshot; the released conditioner + VAEs
      // are an exact selective file set from MiniMax's upstream snapshot. Both
      // downloads are explicit in Video Gen, and render-time resolution is
      // cache-only. The server-owned disclosure attaches the mandatory,
      // versioned territory/license acceptance gate.
      {
        id: 'minimax_h3_8bit',
        name: 'MiniMax H3 MLX 8-bit (joint video + audio, ~103 GB download, 128 GB RAM)',
        repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
        revision: '3ac52081470b0488921c3ec3ba84a39097bf2361',
        runtime: 'minimax_h3',
        // H3 is an fl2va model: it conditions on up to two keyframes anchored
        // at the first / last latent frame. 'image' anchors one at 'first',
        // 'fflf' anchors both.
        supportedModes: ['text', 'image', 'fflf'],
        // The upstream model supports 4-15 seconds. H3's VAE snaps duration
        // UP to a 17n+5 frame grid, so 4s becomes 107 frames and the port's
        // recommended 5s default becomes 124. Keep the shortest recommended
        // run as the default: dense attention already makes it a multi-hour
        // render on current Apple Silicon.
        defaultFrames: 124,
        frameOptions: [...MINIMAX_H3_OUTPUT_PROFILE.frameOptions],
        fpsOptions: [24],
        // The checkpoint's canvas contract, shared verbatim with the CUDA entry.
        ...MINIMAX_H3_CANVAS,
        resolutionOptions: MINIMAX_H3_CANVAS.resolutionOptions.map((preset) => ({ ...preset })),
        memoryGb: 128,
        steps: MINIMAX_H3_OUTPUT_PROFILE.mlxSteps,
        guidance: 0,
        samplerLocked: true,
        samplerNote: MINIMAX_H3_OUTPUT_PROFILE.mlxSamplerNote,
        supportsNegativePrompt: false,
        supportsTiling: false,
        supportsDisableAudio: false,
        requiredWeights: [{
          repo: 'MiniMaxAI/MiniMax-H3',
          revision: '6818f6c32d12b210915e44ad56a4228c2608f160',
          files: [
            'LICENSE',
            'FL2VA/model_index.json',
            'FL2VA/audio_vae/config.json',
            'FL2VA/audio_vae/metadata.json',
            'FL2VA/audio_vae/model.safetensors',
            'FL2VA/text_encoder/config.json',
            'FL2VA/text_encoder/model-00001-of-00014.safetensors',
            'FL2VA/text_encoder/model-00002-of-00014.safetensors',
            'FL2VA/text_encoder/model-00003-of-00014.safetensors',
            'FL2VA/text_encoder/model-00004-of-00014.safetensors',
            'FL2VA/text_encoder/model-00005-of-00014.safetensors',
            'FL2VA/text_encoder/model-00006-of-00014.safetensors',
            'FL2VA/text_encoder/model-00007-of-00014.safetensors',
            'FL2VA/text_encoder/model-00008-of-00014.safetensors',
            'FL2VA/text_encoder/model-00009-of-00014.safetensors',
            'FL2VA/text_encoder/model-00010-of-00014.safetensors',
            'FL2VA/text_encoder/model-00011-of-00014.safetensors',
            // The pinned port truncates Qwen3-VL at layer 50. Index shards
            // 12/13 contain only layers 53-63 and are intentionally omitted;
            // shard 14 remains necessary for the final norm tensor.
            'FL2VA/text_encoder/model-00014-of-00014.safetensors',
            'FL2VA/text_encoder/model.safetensors.index.json',
            // Keyframe conditioning runs each image through the Qwen3-VL
            // processor (AutoProcessor reads the `processor/` directory, not
            // `tokenizer/`) before the vision tower, whose weights already ride
            // along in shard 14. ~11 MB total, so it stays in the base download
            // rather than becoming a second opt-in pull.
            'FL2VA/processor/chat_template.json',
            'FL2VA/processor/merges.txt',
            'FL2VA/processor/preprocessor_config.json',
            'FL2VA/processor/tokenizer.json',
            'FL2VA/processor/tokenizer_config.json',
            'FL2VA/processor/video_preprocessor_config.json',
            'FL2VA/processor/vocab.json',
            'FL2VA/tokenizer/merges.txt',
            'FL2VA/tokenizer/tokenizer.json',
            'FL2VA/tokenizer/tokenizer_config.json',
            'FL2VA/tokenizer/vocab.json',
            'FL2VA/video_vae/config.json',
            'FL2VA/video_vae/source/config.json',
            'FL2VA/video_vae/source/model.safetensors',
          ],
        }],
      },
      // MiniMax H3 Ref2VA through the signed mere.run native runtime. The
      // checkpoint accepts at most 15 seconds of reference audio per call;
      // PortOS chains those windows and remuxes the exact source audio so the
      // user-facing mode has no arbitrary duration cap.
      {
        id: 'minimax_h3_ref2va_8bit',
        name: 'MiniMax H3 Ref2VA MLX 8-bit (image + arbitrary-length audio, ~71 GB, 128 GB RAM)',
        repo: 'Sawfwair/MiniMax-H3-Ref2VA-MLX-8bit',
        revision: '61dc387ef1a7166425cdacd63c2340598dcc364f',
        runtime: 'minimax_h3_ref2va',
        supportedModes: ['a2v'],
        requiresSourceImageForA2v: true,
        audioDurationDriven: true,
        arbitraryLengthAudio: true,
        maxReferenceAudioSeconds: 15,
        defaultFrames: 124,
        frameOptions: [...MINIMAX_H3_OUTPUT_PROFILE.frameOptions],
        fpsOptions: [24],
        defaultWidth: 512,
        defaultHeight: 320,
        resolutionStep: 32,
        resolutionOptions: [
          { label: '512x320 (draft)', w: 512, h: 320 },
          { label: '768x480', w: 768, h: 480 },
          { label: '1024x640', w: 1024, h: 640 },
          { label: '768x768 (1:1)', w: 768, h: 768 },
        ],
        memoryGb: 128,
        steps: 9,
        guidance: 0,
        samplerLocked: true,
        samplerNote: 'MiniMax H3 Ref2VA is CFG-distilled. PortOS renders audio in up-to-15-second continuity-linked windows, then restores the exact source audio over the final video.',
        supportsNegativePrompt: false,
        supportsTiling: false,
        supportsDisableAudio: false,
      },
      // Wan 2.2 through pinned MLX-Gen. Generation is cache-only: PortOS owns
      // the explicit base/adaptor downloads and uses the saved HF token.
      {
        id: 'wan22_ti2v_5b',
        name: 'Wan 2.2 TI2V 5B Q8 (~17 GiB download, text + image)',
        repo: 'AbstractFramework/wan2.2-ti2v-5b-diffusers-8bit',
        revision: '6875952a110b6bdbcfc00d72b1d89a8e02ab0fc3',
        runtime: 'wan22',
        supportedModes: ['text', 'image'],
        frameStride: 4,
        fpsOptions: [16, 20, 24],
        memoryGb: 24,
        steps: 25,
        guidance: 5.0,
        flowShift: 3.0,
        solver: 'unipc',
      },
      {
        id: 'wan22_t2v_a14b',
        name: 'Wan 2.2 T2V A14B Q8 (~40 GiB download, 64+ GB RAM)',
        repo: 'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit',
        revision: '39ee5f1f630789956f29f40b5c2c6d48c6e9a798',
        runtime: 'wan22',
        supportedModes: ['text'],
        frameStride: 4,
        fpsOptions: [16, 20, 24],
        memoryGb: 48,
        steps: 20,
        guidance: 4.0,
        guidance2: 3.0,
        flowShift: 3.0,
        solver: 'unipc',
      },
      {
        id: 'wan22_i2v_a14b',
        name: 'Wan 2.2 I2V A14B Q8 (~40 GiB download, 64+ GB RAM)',
        repo: 'AbstractFramework/wan2.2-i2v-a14b-diffusers-8bit',
        revision: '1a17fbea2649c576de844e08e79fe56296751efa',
        runtime: 'wan22',
        supportedModes: ['image'],
        frameStride: 4,
        fpsOptions: [16, 20, 24],
        memoryGb: 48,
        steps: 20,
        guidance: 3.5,
        guidance2: 3.5,
        flowShift: 3.0,
        solver: 'unipc',
      },
      {
        id: 'wan22_t2v_a14b_lightning',
        name: 'Wan 2.2 T2V A14B Lightning Q8 (~40 GiB download, 64+ GB RAM, 4-step)',
        repo: 'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit',
        revision: '39ee5f1f630789956f29f40b5c2c6d48c6e9a798',
        runtime: 'wan22',
        supportedModes: ['text'],
        frameStride: 4,
        fpsOptions: [16, 20, 24],
        memoryGb: 48,
        steps: 4,
        guidance: 1.0,
        guidance2: 1.0,
        flowShift: 5.0,
        solver: 'euler',
        samplerLocked: true,
        requiredWeights: [{
          repo: 'lightx2v/Wan2.2-Lightning',
          revision: '18bccf8884ec0a078eed79785eb4ef13ea16ce1e',
          files: [
            'Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1/high_noise_model.safetensors',
            'Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1/low_noise_model.safetensors',
          ],
          targetRoles: ['high_noise_transformer', 'low_noise_transformer'],
        }],
      },
      {
        id: 'wan22_i2v_a14b_lightning',
        name: 'Wan 2.2 I2V A14B Lightning Q8 (~40 GiB download, 64+ GB RAM, 4-step)',
        repo: 'AbstractFramework/wan2.2-i2v-a14b-diffusers-8bit',
        revision: '1a17fbea2649c576de844e08e79fe56296751efa',
        runtime: 'wan22',
        supportedModes: ['image'],
        frameStride: 4,
        fpsOptions: [16, 20, 24],
        memoryGb: 48,
        steps: 4,
        guidance: 1.0,
        guidance2: 1.0,
        flowShift: 5.0,
        solver: 'euler',
        samplerLocked: true,
        requiredWeights: [{
          repo: 'lightx2v/Wan2.2-Lightning',
          revision: '18bccf8884ec0a078eed79785eb4ef13ea16ce1e',
          files: [
            'Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/high_noise_model.safetensors',
            'Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/low_noise_model.safetensors',
          ],
          targetRoles: ['high_noise_transformer', 'low_noise_transformer'],
        }],
      },
      // FastVideo FastMetal models — Hao AI Lab's distilled DMD2 Wan models
      // with affine INT8 quantization on Apple Silicon MLX.
      {
        id: 'fastmetal_1_3b_qad',
        name: 'FastMetal 1.3B QAD (~3.5 GB download, 8+ GB RAM, 3-step)',
        repo: 'FastVideo/FastMetal-1.3B-QAD',
        runtime: 'fastvideo',
        supportedModes: ['text'],
        defaultWidth: 832,
        defaultHeight: 480,
        defaultFrames: 81,
        memoryGb: 8,
        steps: 3,
        guidance: 1.0,
        samplerLocked: true,
        samplerNote: 'FastMetal models are DMD2-distilled 3-step models with affine INT8 quantization.',
      },
      {
        id: 'fastmetal_5b_qad',
        name: 'FastMetal 5B QAD (~10 GB download, 16+ GB RAM, 3-step)',
        repo: 'FastVideo/FastMetal-5B-QAD',
        runtime: 'fastvideo',
        supportedModes: ['text'],
        defaultWidth: 1280,
        defaultHeight: 720,
        defaultFrames: 81,
        memoryGb: 16,
        steps: 3,
        guidance: 1.0,
        samplerLocked: true,
        samplerNote: 'FastMetal models are DMD2-distilled 3-step models with affine INT8 quantization.',
      },
      {
        id: 'fastmetal_14b_qad',
        name: 'FastMetal 14B QAD (~25 GB download, 36+ GB RAM, 3-step)',
        repo: 'FastVideo/FastMetal-14B-QAD',
        runtime: 'fastvideo',
        supportedModes: ['text'],
        defaultWidth: 1280,
        defaultHeight: 720,
        defaultFrames: 81,
        memoryGb: 36,
        steps: 3,
        guidance: 1.0,
        samplerLocked: true,
        samplerNote: 'FastMetal models are DMD2-distilled 3-step models with affine INT8 quantization.',
      },
      // FastH3 Preview v1 Dense / Data-Free, packed for MLX (#5860). Same
      // `fastvideo` venv and checkout as FastMetal above, but a different entry
      // script and argv shape — `fastvideoFamily` is what routes it, see
      // buildFastVideoArgs. Text-to-video-WITH-AUDIO: the runner muxes H.264 at
      // a fixed 24 fps with 32 kHz stereo AAC, which is why `fpsOptions` offers
      // that one value rather than letting the form ask for a rate the entry
      // script has no flag to accept.
      // The DiT arrives pre-quantized, so nothing is converted on first render.
      {
        id: 'fasth3_dense_datafree_mlx_int4',
        name: 'FastH3 Preview v1 Dense Data-Free MLX INT4 (video + audio, ~89 GB download, 36+ GB RAM, 4-step)',
        repo: 'MrMofer/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree-MLX-INT4',
        revision: '4c8c3e54da8cd667b5db10f6074b4cb9b7559f15',
        runtime: 'fastvideo',
        fastvideoFamily: 'fasth3',
        supportedModes: ['text'],
        defaultWidth: 832,
        defaultHeight: 480,
        defaultFrames: 124,
        frameOptions: [...FASTH3_OUTPUT_PROFILE.frameOptions],
        fpsOptions: [...FASTH3_OUTPUT_PROFILE.fpsOptions],
        resolutionStep: FASTH3_OUTPUT_PROFILE.resolutionStep,
        resolutionOptions: FASTH3_OUTPUT_PROFILE.resolutionOptions.map((preset) => ({ ...preset })),
        memoryGb: 36,
        steps: 4,
        guidance: 1.0,
        samplerLocked: true,
        samplerNote: 'FastH3 Preview v1 is a 4-step DMD2 model. This export is dense-attention only — it does not support VSA. Renders video with audio at a fixed 24 fps.',
        // mlx_fasth3.py takes no --negative-prompt, exposes no way to mute the
        // joint audio track, and PortOS never passes it a tiling flag. Declaring
        // each `false` is what removes the control from the form rather than
        // offering a knob whose value is silently dropped at the argv boundary.
        supportsNegativePrompt: false,
        supportsTiling: false,
        supportsDisableAudio: false,
      },
    ]))))),
    cuda: applyMiniMaxH3MemoryProfiles(applyVideoDraftDecoders(applyVideoSpeedProfiles(applyVideoFinishProfiles(applyVideoDisclosures([
      { id: 'ltx_video', name: 'LTX-Video 0.9.5 — T2V + I2V (~9.5 GB, auto-downloads)', runtime: 'cuda_video', steps: 25, guidance: 3.0 },
      {
        id: 'ltx25_cuda_distilled',
        name: 'LTX-2.5 CUDA Distilled (joint video + audio, ~72 GB download, streamed)',
        repo: 'Lightricks/LTX-2.5',
        revision: 'bf86adedf518142442575d1ce2e767b7d01c8c76',
        repoFiles: [...LTX25_CUDA_REPO_FILES],
        runtime: 'ltx25_cuda',
        supportedModes: ['text', 'image'],
        defaultFrames: 121,
        resolutionStep: 64,
        fpsOptions: [24],
        steps: 8,
        guidance: 1.0,
        samplerLocked: true,
        samplerNote: 'LTX-2.5 Distilled uses the official fixed 8-step, CFG-free schedule.',
        supportsNegativePrompt: false,
        supportsTiling: false,
        supportsDisableAudio: true,
        requiresHfToken: true,
        hardwareRequirements: { minMemoryGb: 64, minVramGb: 16, minCudaComputeCapability: 8 },
      },
      {
        id: 'wan22_cuda_ti2v_5b',
        name: 'Wan 2.2 TI2V 5B CUDA (high quality, ~34 GB download, text-to-video)',
        repo: 'Wan-AI/Wan2.2-TI2V-5B-Diffusers',
        revision: 'b8fff7315c768468a5333511427288870b2e9635',
        runtime: 'wan22_cuda',
        supportedModes: ['text'],
        defaultWidth: 1280,
        defaultHeight: 704,
        resolutionStep: 16,
        defaultFrames: 121,
        frameStride: 4,
        fpsOptions: [24],
        steps: 50,
        guidance: 5,
        supportsNegativePrompt: true,
        supportsTiling: false,
        hardwareRequirements: { minMemoryGb: 32, minVramGb: 24, minCudaComputeCapability: 8 },
      },
      // MiniMax H3 on NVIDIA, through diffusers' MiniMaxH3ModularPipeline —
      // the same joint video+audio model the MLX list runs on Apple Silicon, so it
      // shares H3's canvas grid, its fixed 24 fps, its locked CFG-distilled
      // sampler and the same license gate. Generation is cache-only: PortOS
      // owns the explicit file-list download (see MINIMAX_H3_CUDA_REPO_FILES —
      // never a snapshot of this repo) and the runtime is provisioned only
      // after the user selects Install in Video Gen.
      {
        id: 'minimax_h3_cuda',
        name: 'MiniMax H3 CUDA int8 (joint video + audio, ~144 GB download, 24 GB VRAM + 96 GB RAM)',
        repo: 'MiniMaxAI/MiniMax-H3',
        revision: '42ed227ee7df40d41602854ae760620d6eb651fe',
        repoFiles: [...MINIMAX_H3_CUDA_REPO_FILES],
        runtime: 'minimax_h3_cuda',
        supportedModes: ['text', 'image', 'fflf'],
        defaultFrames: 124,
        frameOptions: [...MINIMAX_H3_CUDA_FRAME_OPTIONS],
        fpsOptions: [24],
        ...MINIMAX_H3_CANVAS,
        resolutionOptions: MINIMAX_H3_CANVAS.resolutionOptions.map((preset) => ({ ...preset })),
        // HOST RAM, not VRAM: at int8 the transformer's blocks and the
        // conditioner's leaves are streamed from CPU memory, so ~75 GB of the
        // weights are resident off-GPU for the whole render. The card itself
        // needs ~24 GB, and the runner steps down to a leaner offload profile
        // on a smaller one (see scripts/generate_minimax_h3_cuda.py).
        memoryGb: 96,
        steps: 8,
        guidance: 0,
        samplerLocked: true,
        samplerNote: 'MiniMax H3 is CFG-distilled; this profile locks the validated 8-point sigma schedule and does not use CFG.',
        supportsNegativePrompt: false,
        supportsTiling: false,
        supportsDisableAudio: false,
      },
    ]))))),
    defaultMlx: 'ltx23_distilled_q4',
    defaultCuda: 'ltx_video',
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
// assume `reg.video.mlx`. We also coerce array-shaped fields back to the
// defaults when the user's JSON is parseable but wrong-shape (e.g.
// `image: {}` or `video.mlx: "ltx"`) — otherwise getImageModels /
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
// 'ltx2_unified' is retired (see RETIRED_VIDEO_MODELS) but stays here: an
// install that re-pointed its entry at a fork keeps that entry, and it still
// needs the runtime backfill.
const LEGACY_MLX_VIDEO_IDS = new Set(['ltx2_unified', 'ltx23_unified', 'ltx23_distilled_q4']);
const backfillRuntime = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    if (typeof entry.runtime === 'string' && entry.runtime.length > 0) return entry;
    if (LEGACY_MLX_VIDEO_IDS.has(entry.id)) return { ...entry, runtime: 'mlx_video' };
    return entry;
  });
};

// `ltx_video` is the legacy diffusers CUDA helper, not an MLX runtime. It
// shipped in the CUDA bucket before the bucket names made that mismatch
// obvious, so correct an untouched persisted entry during the same early load
// that still precedes migrations. A custom repo is deliberately left alone.
const upgradeLegacyCudaLtxRuntime = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => (
    isPlainObject(entry)
      && entry.id === 'ltx_video'
      && (entry.runtime === undefined || entry.runtime === 'mlx_video')
      && entry.repo === undefined
      ? { ...entry, runtime: 'cuda_video' }
      : entry
  ));
};

export const upgradeLtx25CudaMemoryFloor = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => (
    isPlainObject(entry)
      && entry.id === 'ltx25_cuda_distilled'
      && entry.repo === 'Lightricks/LTX-2.5'
      && entry.hardwareRequirements?.minMemoryGb === 32
      ? { ...entry, hardwareRequirements: { ...entry.hardwareRequirements, minMemoryGb: 64 } }
      : entry
  ));
};

// Built-in video models that were delivered to installs and have since been
// withdrawn. Dropping an id from DEFAULT_REGISTRY is NOT enough on its own: the
// user's persisted list is what the pickers read, and appendNewlyShippedEntries
// only ever adds. This is the load-time twin of the retirement migrations (247
// for ltx2_unified, 315 for hunyuan_video) — and it is the load-bearing half,
// because the registry is cached at import time, BEFORE bootstrapServices()
// runs migrations, and
// persistRegistry writes the whole cached object back on the next registry
// edit. Without this the migration's deletion is undone by the same boot that
// applied it.
//
// `replacement` repoints a `defaultMlx`/`defaultCuda` that named the
// retired model. getDefaultVideoModelId() would otherwise fall back to the
// first available entry, which is not necessarily the intended successor.
//
// Preservation guard mirrors backfillKvRepo: an entry whose `repo` no longer
// matches the shipped one is a fork the user pointed at deliberately, so it
// stays — that is also the escape hatch for anyone who wants a retired model
// back.
//
// Exported so the matching retirement migration can assert it froze the same
// id/repo/replacement — a typo in either copy would otherwise turn one half of
// the retirement into a silent no-op with every test still green.
export const RETIRED_VIDEO_MODELS = Object.freeze({
  ltx2_unified: Object.freeze({
    shippedRepo: 'notapalindrome/ltx2-mlx-av',
    replacement: 'ltx23_distilled_q4',
  }),
  hunyuan_video: Object.freeze({
    shippedRepo: 'tencent/HunyuanVideo',
    replacement: 'fastmetal_1_3b_qad',
  }),
});

const isRetired = (entry) => {
  if (!isPlainObject(entry) || typeof entry.id !== 'string') return false;
  const spec = RETIRED_VIDEO_MODELS[entry.id];
  // `spec &&` is load-bearing, not defensive: several entries (the Windows
  // `ltx_video`) carry no `repo` at all, and without the guard an absent spec
  // would compare `undefined === undefined` and retire every one of them.
  return Boolean(spec) && entry.repo === spec.shippedRepo;
};

const dropRetiredEntries = (list) => (
  Array.isArray(list) ? list.filter((entry) => !isRetired(entry)) : list
);

// Repoint a platform default that named a model this load just retired. Falls
// through to the original id when the successor isn't installed either — then
// getDefaultVideoModelId()'s "unknown default → first available" warning is the
// honest outcome, rather than naming a model this install doesn't have.
const resolveRetiredDefault = (configuredId, entries) => {
  const replacement = RETIRED_VIDEO_MODELS[configuredId]?.replacement;
  if (!replacement) return configuredId;
  if (entries.some((entry) => entry?.id === configuredId)) return configuredId; // fork kept it
  return entries.some((entry) => entry?.id === replacement) ? replacement : configuredId;
};

// Build the initial shippedIds set for one bucket on first encounter
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
// When the bucket key is absent from their registry (e.g. the whole `video`
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
  // new in this release". Tracked separately for video (per-bucket) and
  // image (single list — image entries cover both buckets).
  const shippedVideo = isPlainObject(safe._shippedDefaults?.video) ? safe._shippedDefaults.video : null;
  const isVideoBootstrap = shippedVideo === null;

  // Every read goes through readVideoBucket / readVideoDefault so a registry
  // still keyed `macos` / `windows` (any install written before #4142) resolves
  // exactly as it did before. The OUTPUT below is canonical-only.
  const shippedIdsFor = (bucket) => (isVideoBootstrap
    ? bootstrapShippedIds(readVideoBucket(safeVideo, bucket), DEFAULT_REGISTRY.video[bucket])
    : new Set(arrayOrDefault(readVideoBucket(shippedVideo, bucket), [])));

  const shippedIds = Object.fromEntries(VIDEO_BUCKETS.map((b) => [b, shippedIdsFor(b)]));
  const bucketResults = Object.fromEntries(VIDEO_BUCKETS.map((bucket) => [bucket, appendNewlyShippedEntries(
    readVideoBucket(safeVideo, bucket),
    DEFAULT_REGISTRY.video[bucket],
    shippedIds[bucket],
  )]));

  const updatedShippedVideo = Object.fromEntries(VIDEO_BUCKETS.map((bucket) => [
    bucket, [...shippedIds[bucket], ...bucketResults[bucket].newlyShipped],
  ]));

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

  // applyVideoDisclosures is the load-time twin of migration 237: installs
  // that persisted their registry before `disclosure` existed pick it up
  // here without waiting for the migration, and both paths share the same
  // preservation guards (user value wins, forked repo keeps Unknown).
  // dropRetiredEntries is the same arrangement for the retirement migrations,
  // and runs
  // FIRST so a withdrawn model isn't handed a disclosure or a Finish edge on
  // its way out. sanitizeFinishProfiles runs LAST (after the backfill and
  // after the user's own entries are merged in) so an edge that points at a
  // model this install deleted — or a hand-edited typo — is dropped with a
  // warning instead of surfacing a Finish button targeting nothing.
  const videoEntries = (entries, { upgradeLegacyCudaLtx = false } = {}) => {
    const normalized = backfillRuntime(upgradeLtx25AudioControls(
      upgradeMiniMaxH3OutputControls(dropRetiredEntries(entries)),
    ));
    const upgraded = upgradeLegacyCudaLtx
      ? upgradeLtx25CudaMemoryFloor(upgradeLegacyCudaLtxRuntime(normalized))
      : normalized;
    const decorated = sanitizeFinishProfiles(applyVideoFinishProfiles(applyVideoDisclosures(upgraded)));
    // applyVideoSpeedProfiles is the load-time twin of migration 295, and
    // sanitizeSpeedProfiles is its sibling of sanitizeFinishProfiles: a
    // hand-edited profile with a NaN step count would otherwise reach the
    // picker and spawn a broken render, so it is warned about and stripped.
    const withSpeed = sanitizeSpeedProfiles(applyVideoSpeedProfiles(decorated));
    // applyVideoDraftDecoders + sanitizeDraftDecoders (lib/videoDraftDecoders.js)
    // are the same arrangement for the preview-fidelity decode (#5423). The
    // sanitizer matters more here than elsewhere: a hand-edited decoder pointed
    // at a runtime whose builder emits no draft flags would render on the FULL
    // decoder while the history record claimed a draft one, so it is warned
    // about and stripped rather than allowed to make a false claim.
    const withDraftDecode = sanitizeDraftDecoders(applyVideoDraftDecoders(withSpeed));
    // applyMiniMaxH3MemoryProfiles is the load-time twin of migration 317, and
    // its sanitizer the sibling of the two above: a hand-edited profile with a
    // NaN memory floor would otherwise make every capacity comparison false and
    // refuse H3 renders on a machine that can run them, so it is warned about
    // and stripped.
    return sanitizeMiniMaxH3MemoryProfiles(applyMiniMaxH3MemoryProfiles(withDraftDecode));
  };
  const normalizedBuckets = Object.fromEntries(
    VIDEO_BUCKETS.map((bucket) => [bucket, videoEntries(bucketResults[bucket].entries, {
      upgradeLegacyCudaLtx: bucket === 'cuda',
    })]),
  );

  // Spread the user's own `video` keys but NOT the legacy bucket spellings: the
  // canonical keys below already carry those lists, and leaving both on the
  // object would persist two spellings of the same bucket into a file users
  // hand-edit — a later edit to the stale copy would silently do nothing.
  const carriedVideo = Object.fromEntries(
    Object.entries(safeVideo).filter(([key]) => !LEGACY_VIDEO_KEYS.includes(key)),
  );

  return {
    ...DEFAULT_REGISTRY,
    ...safe,
    image: imageResult.entries,
    textEncoders: arrayOrDefault(safe.textEncoders, DEFAULT_REGISTRY.textEncoders),
    video: {
      ...DEFAULT_REGISTRY.video,
      ...carriedVideo,
      ...normalizedBuckets,
      ...Object.fromEntries(VIDEO_BUCKETS.map((bucket) => [
        VIDEO_DEFAULT_KEYS[bucket],
        resolveRetiredDefault(
          readVideoDefault(safeVideo, bucket) ?? DEFAULT_REGISTRY.video[VIDEO_DEFAULT_KEYS[bucket]],
          normalizedBuckets[bucket],
        ),
      ])),
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
// `where` and `shippedKey` are the two on-disk paths the warning quotes, and
// both are resolved by the CALLER rather than assembled here: image keeps its
// ids at `_shippedDefaults.image.list` while video keeps them at
// `_shippedDefaults.video.{mlx,cuda}`, and either half of a pre-#4142 registry
// may still be spelled `macos` / `windows` (migration 242 can write a canonical
// snapshot onto a legacy-keyed `video`). A copy-paste out of this warning has to
// land on a key that actually exists in the user's file.
const warnDrift = ({ where, shippedKey }, shippedIds, defaultIds, presentIds) => {
  const shippedSet = new Set(shippedIds || []);
  const defaultSet = new Set(defaultIds || []);
  const presentSet = new Set(presentIds || []);
  for (const id of shippedSet) {
    if (!defaultSet.has(id)) continue;     // not a current built-in; ignore
    if (presentSet.has(id)) continue;      // present — no drift
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
        { where: 'image', shippedKey: '_shippedDefaults.image.list' },
        Array.isArray(sd.image.list) ? sd.image.list : [],
        DEFAULT_REGISTRY.image.map((m) => m.id),
        parsed.image.map((m) => m?.id).filter((id) => typeof id === 'string'),
      );
    }
    // Only the CURRENT machine's video bucket is worth warning about. The
    // pickers, downloads, and every edit path read one bucket's array
    // (`getVideoModels`), so drift in the other one is invisible and
    // unactionable here — and because the warning has no silence-without-
    // restore path, a CUDA box would print the MLX rows on every single
    // boot forever with nothing the user can usefully do about them. The
    // machine that actually runs that bucket still gets the warning.
    const driftBucket = activeVideoBucket();
    const shippedDrift = readVideoBucket(sd.video, driftBucket);
    const presentDrift = readVideoBucket(parsed.video, driftBucket);
    if (
      isPlainObject(sd.video) &&
      isPlainObject(parsed.video) &&
      Array.isArray(shippedDrift) &&
      Array.isArray(presentDrift)
    ) {
      warnDrift(
        {
          where: `video.${resolveVideoBucketKey(parsed.video, driftBucket)}`,
          shippedKey: `_shippedDefaults.video.${resolveVideoBucketKey(sd.video, driftBucket)}`,
        },
        shippedDrift,
        DEFAULT_REGISTRY.video[driftBucket].map((m) => m.id),
        presentDrift.map((m) => m?.id).filter((id) => typeof id === 'string'),
      );
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
    // A pre-#4142 bucket spelling still on disk counts as a change: the
    // normalized object is canonical-only, so the file has to be rewritten once
    // or the two spellings diverge the next time anything edits the registry.
    // (Migration 270 performs the same rename; this is its load-time twin, for
    // the same reason applyVideoDisclosures mirrors migration 237.)
    const carriesLegacyKeys = (obj) => isPlainObject(obj)
      && LEGACY_VIDEO_KEYS.some((key) => Object.hasOwn(obj, key));
    const videoChanged =
      parsedShippedVideo === null ||
      carriesLegacyKeys(parsed.video) ||
      carriesLegacyKeys(parsedShippedVideo) ||
      VIDEO_BUCKETS.some((bucket) => (
        normalizedVideo[bucket].length !== (readVideoBucket(parsedShippedVideo, bucket)?.length ?? 0)
      ));
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

// Locate a model entry by id, returning `{ entry, list, listKey, idx }` or null.
// Scans the CURRENT machine's video bucket + the image list — NOT the other
// bucket's video list. The other bucket's rows aren't visible to
// getVideoModels()/the render path on this install, and scanning both would
// make patch/remove ambiguous when a shared media-models.json (an MLX box and a
// CUDA box syncing as peers) legitimately holds the same custom id in both
// buckets — a remove(id) meant for the CUDA row would hit the MLX row first.
// `listKey` ('mlx' | 'cuda' | 'image') lets the mutators rebuild just that list.
// The registry passed in is always post-normalizeRegistry, so its bucket keys
// are canonical.
const findModelLocation = (reg, id) => {
  const videoKey = activeVideoBucket();
  const lists = [
    [videoKey, reg.video?.[videoKey]],
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
// 'video' → the current machine's video bucket; 'image' → the image list.
// Throws on a duplicate id (a repo already added). Persists + hot-reloads.
export const addUserModelEntry = (entry, { kind }) => {
  if (!entry || typeof entry.id !== 'string') {
    throw new ServerError('Model entry must carry a string id', { status: 400, code: 'BAD_MODEL_ENTRY' });
  }
  if (kind !== 'video' && kind !== 'image') {
    throw new ServerError(`Unknown model kind "${kind}" — expected "image" or "video".`, { status: 400, code: 'BAD_MODEL_KIND' });
  }
  const reg = loadMediaModels();
  const listKey = kind === 'video' ? activeVideoBucket() : 'image';
  // Conflict-check against the ACTIVE-on-this-install lists — the current
  // machine's video bucket + the image list — via findModelLocation (which
  // scopes to exactly those). This rejects a collision between the current
  // video list and the image list (both mutable through the same :id-only
  // PATCH/DELETE, so a dup would make one row unaddressable), while still
  // allowing the same custom video id to be added on the OTHER bucket's list
  // of a shared media-models.json (that list isn't scanned, so no false 409).
  if (findModelLocation(reg, entry.id)) {
    throw new ServerError(
      `A model with id "${entry.id}" is already in this install's registry (repo already added?). Remove it first to re-add.`,
      { status: 409, code: 'MODEL_ALREADY_EXISTS' },
    );
  }
  const current = (listKey === 'image' ? reg.image : reg.video?.[listKey]) || [];
  // Also reject a duplicate REPO in the target list — the same weights under a
  // different id (e.g. the UI placeholder `notapalindrome/ltx23-mlx-av-q4`,
  // already shipped as the built-in `ltx23_distilled_q4`) would otherwise add a
  // second pickable row for identical weights. Only meaningful when the entry
  // carries a repo.
  if (typeof entry.repo === 'string' && entry.repo.trim()
    && current.some((m) => typeof m?.repo === 'string' && m.repo === entry.repo)) {
    throw new ServerError(
      `The HuggingFace repo "${entry.repo}" is already in this install's ${kind} registry (possibly as a built-in). It's already available in the model picker.`,
      { status: 409, code: 'MODEL_REPO_ALREADY_EXISTS' },
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

// `broken` is either `true` (broken everywhere) or the name of the ONE bucket
// it's broken on. Pre-#4142 entries spell that name `macos` / `windows`, so
// matchesVideoBucket accepts both spellings for the active bucket.
const platformBroken = (broken) =>
  broken === true || matchesVideoBucket(broken, activeVideoBucket());

// `supportedModes` is resolved HERE rather than in normalizeRegistry (#3737):
// deriving on read covers the load path, the user-model mutators (which bypass
// normalizeRegistry) and peer-synced entries in one place, and keeps the derived
// list out of data/media-models.json — a persisted copy would read back as a
// *declared* list that no later correction to VIDEO_RUNTIME_MODES could reach.
/**
 * Every pinned file group a model needs resolvable in the HF cache.
 *
 * Two shapes, and a caller that checks only one gets the other wrong: a
 * selective row pins its subset with `repoFiles` against its OWN repo (the H3
 * CUDA entry, whose base repo is ~498 GB and whose diffusers layout is ~144 GB
 * of it), while a row that composes weights from a SECOND repo pins them in
 * `requiredWeights` (the H3 MLX entry's upstream FL2VA checkpoint). Checking
 * `requiredWeights` alone reports a half-downloaded CUDA model as complete.
 *
 * An empty result means "the base snapshot is the whole answer".
 */
export const requiredModelCacheGroups = (model) => {
  const groups = [];
  if (Array.isArray(model?.repoFiles)) {
    groups.push({ repo: model.repo, revision: model.revision, files: model.repoFiles });
  }
  if (Array.isArray(model?.requiredWeights)) groups.push(...model.requiredWeights);
  return groups;
};

export const getVideoModels = () => {
  const reg = loadMediaModels();
  const bucket = activeVideoBucket();
  const capabilities = captureSystemCapabilities();
  const list = readVideoBucket(reg.video, bucket) || [];
  return applyVideoSupportedModes(list.filter((m) => !platformBroken(m.broken))).map((model) => (
    withHardwareCompatibility(
      model,
      capabilities,
      hardwareRequirementsForMediaModel(model, { kind: 'video', bucket }),
    )
  ));
};

export const getDefaultVideoModelId = (capabilities = captureSystemCapabilities()) => {
  const reg = loadMediaModels();
  // Note: defaultMlx / defaultCuda may legitimately point at a model
  // flagged `deprecated: true` — the dgrauet (non-deprecated) runtime
  // requires an opt-in venv (`INSTALL_LTX2=1 bash scripts/setup-image-video.sh`),
  // so the shipped default must stay on a model that works out of the box.
  // The UI dropdowns surface dgrauet at the top via the `Legacy` optgroup
  // pattern; user-driven migration > auto-rolling forward.
  const bucket = activeVideoBucket();
  const configuredId = readVideoDefault(reg.video, bucket);
  // Validate against the bucket's available (non-broken) list — a typo or
  // a model marked broken on this bucket would otherwise surface as
  // "Unknown video model" the first time the UI tries to use the default.
  const available = getVideoModels().map((model) => withHardwareCompatibility(
    model,
    capabilities,
    model.hardwareRequirements,
  ));
  const compatible = available.filter((model) => isHardwareCompatible(model.hardwareCompatibility));
  if (compatible.some((m) => m.id === configuredId)) return configuredId;
  const fallback = compatible[0]?.id;
  if (fallback) {
    console.log(`⚠️ Default video model "${configuredId}" is unavailable or unknown for ${bucket}; falling back to "${fallback}"`);
    return fallback;
  }
  console.log(`⚠️ Default video model "${configuredId}" is unavailable or unknown for ${bucket}; no available models to fall back to`);
  return configuredId;
};

export const getImageModels = () => {
  const reg = loadMediaModels();
  const capabilities = captureSystemCapabilities();
  return (reg.image || [])
    .filter((m) => !platformBroken(m.broken))
    .map((model) => withHardwareCompatibility(
      model,
      capabilities,
      hardwareRequirementsForMediaModel(model, { kind: 'image' }),
    ));
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
