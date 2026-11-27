/** Shipped image and video catalog entries, weight pins, and model profiles. */

import { MOSS_IMAGE_MODEL_ID, MINIMAX_H3_IMAGE_MODEL_ID } from '../imageRuntimeRemedies.js';
import { flux2RepoRevision, diffusersRepoRevision } from '../runners.js';
import { applyVideoDisclosures } from '../videoDisclosure.js';
import { applyVideoFinishProfiles } from '../videoFinishProfiles.js';
import { applyVideoSpeedProfiles } from '../videoSpeedProfiles.js';
import { applyMiniMaxH3MemoryProfiles } from '../minimaxH3Memory.js';

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
// full frame range: the MLX pipeline hard-refuses anything outside 5-15 s at its
// fixed 24 fps ("H3 generates 5-15 s at 24 fps", resolve_geometry in
// fastvideo/mlx_runtime/minimax_h3_pipeline.py), so the grid is clamped to
// 120..360 frames. The unclamped 107..362 this shipped with put a too-short AND
// a too-long value at the two ends of the picker, each of which reached the
// runtime and raised instead of rendering.
// canvas: the MLX FastH3 entry point is validated at 832x480 (its own default,
// and the resolution upstream's conversion manifest records a passing 124-frame
// generation at), and its docstring documents 1280x720 as the other supported
// request. `resolutionOptions` are presets rather than a whitelist, so a custom
// size still resolves through `resolutionStep`.
export const FASTH3_OUTPUT_PROFILE = Object.freeze({
  frameOptions: h3FrameGrid(124, 345),
  fpsOptions: Object.freeze([24]),
  resolutionStep: 32,
  resolutionOptions: Object.freeze([
    Object.freeze({ label: '832x480 (16:9 FastH3 default)', w: 832, h: 480 }),
    Object.freeze({ label: '1280x720 (16:9 HD)', w: 1280, h: 720 }),
  ]),
});

// The upstream FastH3 source snapshot (#5860 follow-up). FastVideo's own MLX
// repos publish a model card and a conversion manifest but still no weights, so
// the checkpoint PortOS points at is the bf16 diffusers snapshot the converter
// documents as its input: one repo, whose `transformer/` becomes an MLX DiT on
// this machine. That is a per-format local step, not a per-format download —
// the three rows below share ONE snapshot and differ only in the format the
// helper converts it to, which is the knob that maps to the user's RAM.
export const FASTH3_SOURCE_REPO = 'FastVideo/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree';
export const FASTH3_SOURCE_REVISION = 'f624f08c6c279ab43534c003e556fc5b295b6558';
const FASTH3_SOURCE_FORMATS = Object.freeze([
  Object.freeze({ format: 'int8', memoryGb: 48, label: 'INT8 (highest fidelity)' }),
  Object.freeze({ format: 'int6', memoryGb: 42, label: 'INT6 (upstream default)' }),
  Object.freeze({ format: 'int4', memoryGb: 36, label: 'INT4 (smallest)' }),
]);

const FASTH3_SOURCE_ENTRIES = FASTH3_SOURCE_FORMATS.map(({ format, memoryGb, label }) => ({
  id: `fasth3_dense_datafree_${format}`,
  name: `FastH3 Preview v1 Dense Data-Free — MLX ${label} (video + audio, ~144 GB download, ${memoryGb}+ GB RAM, 4-step)`,
  repo: FASTH3_SOURCE_REPO,
  revision: FASTH3_SOURCE_REVISION,
  runtime: 'fastvideo',
  fastvideoFamily: 'fasth3',
  fastvideoMlxFormat: format,
  supportedModes: ['text'],
  defaultWidth: 832,
  defaultHeight: 480,
  defaultFrames: 124,
  frameOptions: [...FASTH3_OUTPUT_PROFILE.frameOptions],
  fpsOptions: [...FASTH3_OUTPUT_PROFILE.fpsOptions],
  resolutionStep: FASTH3_OUTPUT_PROFILE.resolutionStep,
  resolutionOptions: FASTH3_OUTPUT_PROFILE.resolutionOptions.map((preset) => ({ ...preset })),
  memoryGb,
  steps: 4,
  guidance: 1.0,
  samplerLocked: true,
  samplerNote: `FastH3 Preview v1 is a 4-step DMD2 model. This is FastVideo's own dense-attention checkpoint — it does not support VSA, whose routing weights the MLX runtime drops. The first render converts its transformer to an MLX ${format.toUpperCase()} DiT (a few minutes, once), after which the 66 GB bf16 transformer can be deleted. Renders video with audio at a fixed 24 fps.`,
  // Same argv boundary as the repack row below: mlx_fasth3.py has no
  // --negative-prompt, no way to mute the joint audio track, and PortOS never
  // hands it a tiling flag.
  supportsNegativePrompt: false,
  supportsTiling: false,
  supportsDisableAudio: false,
}));

// FastH3 Omni (Ref2VA): a reference-conditioned PDD student that turns a prompt
// plus ordered image references (up to 9, including the first-frame input) into
// one joint video + audio clip. FastVideo's MLX runtime needs five pinned pieces
// the export alone does not carry: the BF16 export (the model repo), the base
// snapshot's text encoder / tokenizer / processor / audio VAE, the LightVAE
// reference encoder and the FastH3 quality decoder. Each is an exact file list,
// not a snapshot: the QAD repo also holds ~75 GB of CUDA transformer variants
// the MLX path cannot read.
const FASTH3_OMNI_BASE_REPO = 'FastVideo/FastH3-Omni-NVFP4-QAD';
const FASTH3_OMNI_MAX_IMAGES = 9;
const FASTH3_OMNI_MAX_VIDEOS = 3;
const FASTH3_OMNI_MAX_AUDIOS = 3;
const FASTH3_OMNI_BASE_FILES = Object.freeze([
  'audio_vae/config.json',
  'audio_vae/diffusion_pytorch_model.safetensors',
  'processor/chat_template.json',
  'processor/merges.txt',
  'processor/preprocessor_config.json',
  'processor/tokenizer.json',
  'processor/tokenizer_config.json',
  'processor/video_preprocessor_config.json',
  'processor/vocab.json',
  'text_encoder/chat_template.json',
  'text_encoder/config.json',
  'text_encoder/merges.txt',
  'text_encoder/model.safetensors.index.json',
  ...[1, 2, 3, 4].map((i) => `text_encoder/model-0000${i}-of-00004.safetensors`),
  'text_encoder/preprocessor_config.json',
  'text_encoder/tokenizer.json',
  'text_encoder/tokenizer_config.json',
  'text_encoder/video_preprocessor_config.json',
  'text_encoder/vocab.json',
  'tokenizer/merges.txt',
  'tokenizer/tokenizer.json',
  'tokenizer/tokenizer_config.json',
  'tokenizer/vocab.json',
  'vae/config.json',
]);

const FASTH3_OMNI_ENTRY = {
  id: 'fasth3_omni_int6',
  name: 'FastH3 Omni — MLX INT6 + VSA (reference images → video + audio, ~92 GB download, 48+ GB RAM, 8-step)',
  repo: 'FastVideo/FastVideo-FastH3-Omni-8-Step-V1',
  revision: '53e0d26a1691aa473b6262d8196a8feb2c297df0',
  runtime: 'fastvideo',
  fastvideoFamily: 'fasth3omni',
  fastvideoMlxFormat: 'int6',
  fastvideoVsa: true,
  maxReferenceImages: FASTH3_OMNI_MAX_IMAGES,
  maxReferenceVideos: FASTH3_OMNI_MAX_VIDEOS,
  maxReferenceAudios: FASTH3_OMNI_MAX_AUDIOS,
  // The runtime's validate_references also rejects more than 12 references in total.
  maxReferenceTotal: 12,
  requiredWeights: [
    {
      role: 'base',
      repo: FASTH3_OMNI_BASE_REPO,
      revision: 'f01e6a23ac6066aa9eb622cf94b6259442e70ec2',
      files: FASTH3_OMNI_BASE_FILES,
    },
    {
      role: 'vaeDecoder',
      repo: 'FastVideo/FastH3-NVFP4-VAE-Decoder',
      revision: 'bd0c248f2a0f57ca643b3df2ac1f375fa55101fb',
      files: ['quality-36L/decoder-nvfp4.safetensors'],
    },
    {
      role: 'vaeEncoder',
      repo: 'lightx2v/LightVAE',
      revision: '4925ea978147b9de492d7a5fd4f9c6d1854ca1cc',
      files: ['lightvae-lite-h3-encoder.safetensors'],
    },
  ],
  // Reference-conditioned only: the model has no text-only workflow, and the
  // first-frame input is the first of the ordered references.
  supportedModes: ['image'],
  defaultWidth: 832,
  defaultHeight: 480,
  defaultFrames: 124,
  frameOptions: [...FASTH3_OUTPUT_PROFILE.frameOptions],
  fpsOptions: [...FASTH3_OUTPUT_PROFILE.fpsOptions],
  resolutionStep: FASTH3_OUTPUT_PROFILE.resolutionStep,
  resolutionOptions: FASTH3_OUTPUT_PROFILE.resolutionOptions.map((preset) => ({ ...preset })),
  memoryGb: 48,
  steps: 8,
  guidance: 1.0,
  samplerLocked: true,
  samplerNote: 'FastH3 Omni is an 8-step distilled reference-to-video+audio model: the input image, up to 8 more reference images, up to 3 reference clips and up to 3 voice clips condition the clip, with 80% sparse attention. First use converts the BF16 transformer to an MLX INT6 DiT locally (a few minutes, once), after which the 66 GB BF16 transformer can be deleted. Renders video with audio at a fixed 24 fps.',
  supportsNegativePrompt: false,
  supportsTiling: false,
  supportsDisableAudio: false,
};

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
// MiniMax H3-Image renders on its own transformer + 2D VAE plus the H3 video
// repo's Qwen3-VL conditioner (byte-identical blobs). Both repos are
// aggregates, so both are pinned to exact file lists: the image repo also
// ships a diffusers layout, and the conditioner skips text-encoder shards
// 12-13 (layers 53-63, past the layer-50 readout) like the video entries do.
const MINIMAX_H3_IMAGE_REPO_FILES = Object.freeze([
  'LICENSE', 'model_index.json', 'pdd_config.json', 'pdd_fused_heads.safetensors',
  'transformer/config.json', 'transformer/model.safetensors.index.json',
  ...Array.from({ length: 12 }, (_, i) => `transformer/model-${String(i + 1).padStart(5, '0')}-of-00012.safetensors`),
  'vae/config.json', 'vae/diffusion_pytorch_model.safetensors',
]);
const MINIMAX_H3_CONDITIONER_FILES = Object.freeze([
  'FL2VA/text_encoder/config.json', 'FL2VA/text_encoder/model.safetensors.index.json',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14].map(n => `FL2VA/text_encoder/model-${String(n).padStart(5, '0')}-of-00014.safetensors`),
  ...['chat_template.json', 'merges.txt', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
    'video_preprocessor_config.json', 'vocab.json'].map(f => `FL2VA/processor/${f}`),
  ...['merges.txt', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json'].map(f => `FL2VA/tokenizer/${f}`),
]);

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
// scripts/ml/generate_minimax_h3_cuda.py, which rejects the same values.
const MINIMAX_H3_CUDA_FRAME_OPTIONS = h3FrameGrid(124, 345);

// FastMetal 14B ships its MLX DiT TWICE — `mlx_dit.safetensors` at the repo
// root and an `ema/` copy of the same 14.14 GB tensor. The render path reads
// only the root one: scripts/ml/generate_fastvideo.py defaults `mlx_checkpoint`
// to the model root for the fastmetal family and ALWAYS forwards it, so
// mlx_wan_prompt_to_video.py takes `resolve_mlx_checkpoint`'s explicit branch
// and loads `mlx_dit.json` + `mlx_dit.safetensors` from that one directory.
// Nothing on that path names `ema/` — the `ema/*` entries in the entry
// script's own `allow_patterns` belong to its download helper, which PortOS
// bypasses by passing an explicit `--model-root`.
//
// Enumerating the loaded set therefore drops 14.14 GB from the pull without
// changing a single byte the render path reads.
//
// Listed rather than expressed as an "everything but ema/" exclusion because
// `repoFiles` is the only narrowing the download path has (see
// `modelDownloadTargets`), and an explicit list is also what the cache
// completeness check verifies. `.gitattributes` and `README.md` are omitted:
// nothing loads them, and a file in this list that upstream later drops would
// read as an incomplete download.
const FASTMETAL_14B_REPO_FILES = Object.freeze([
  'model_index.json',
  'mlx_dit.json',
  'mlx_dit.safetensors',
  'scheduler/scheduler_config.json',
  'text_encoder/config.json',
  'text_encoder/model.safetensors.index.json',
  ...shardFiles('text_encoder', 'model', 5),
  'tokenizer/special_tokens_map.json',
  'tokenizer/spiece.model',
  'tokenizer/tokenizer.json',
  'tokenizer/tokenizer_config.json',
  'vae/config.json',
  'vae/diffusion_pytorch_model.safetensors',
]);

// The three shipped FastMetal rows quote a download size in their DISPLAY NAME
// that is only the MLX DiT, while the entries pull a whole-repo snapshot that
// also carries a bundled T5 text encoder and VAE — so a user reading "~3.5 GB"
// was handed a 13.4 GB pull (#5871). #5860 corrected `estimatedDownloadGb` in
// the disclosure panel; the name is the number the user reads BEFORE opening
// that panel, so it is what these profiles correct.
//
// `oldName` / `oldEstimatedDownloadGb` are the exact superseded SHIPPED values:
// each rewrite fires only when the persisted value still matches one of them, so
// a user's own rename or hand-tuned estimate survives untouched. Same shape as
// MINIMAX_H3_OUTPUT_PROFILE's upgrade half — keyed on (id, shipped repo, prior
// shipped value).
//
// `oldEstimatedDownloadGb` carries TWO generations because #5860 shipped no
// migration: an install that persisted its disclosure before it still reads the
// DiT-only figure, and one that seeded after reads the whole-snapshot figure the
// 14B row no longer pulls.
export const FASTMETAL_DOWNLOAD_SIZE_PROFILES = Object.freeze([
  Object.freeze({
    id: 'fastmetal_1_3b_qad',
    shippedRepo: 'FastVideo/FastMetal-1.3B-QAD',
    oldName: 'FastMetal 1.3B QAD (~3.5 GB download, 8+ GB RAM, 3-step)',
    name: 'FastMetal 1.3B QAD (~13.4 GB download, 8+ GB RAM, 3-step)',
    oldEstimatedDownloadGb: Object.freeze([3.5]),
    estimatedDownloadGb: 13.4,
  }),
  Object.freeze({
    id: 'fastmetal_5b_qad',
    shippedRepo: 'FastVideo/FastMetal-5B-QAD',
    oldName: 'FastMetal 5B QAD (~10 GB download, 16+ GB RAM, 3-step)',
    name: 'FastMetal 5B QAD (~19.5 GB download, 16+ GB RAM, 3-step)',
    oldEstimatedDownloadGb: Object.freeze([10.2]),
    estimatedDownloadGb: 19.5,
  }),
  // The 14B repo ships the DiT twice — `mlx_dit.safetensors` and an `ema/` copy
  // of it, 14.14 GB each — and the entry script loads only the root one, so
  // `repoFiles` drops the `ema/` half. That makes this row's honest number the
  // narrowed 27.1 GB pull rather than the 42.3 GB whole snapshot. Every name
  // here quotes its `estimatedDownloadGb` verbatim — the whole bug was the two
  // disagreeing, so they are not allowed to round apart.
  Object.freeze({
    id: 'fastmetal_14b_qad',
    shippedRepo: 'FastVideo/FastMetal-14B-QAD',
    oldName: 'FastMetal 14B QAD (~25 GB download, 36+ GB RAM, 3-step)',
    name: 'FastMetal 14B QAD (~27.1 GB download, 36+ GB RAM, 3-step)',
    oldEstimatedDownloadGb: Object.freeze([25.4, 42.3]),
    estimatedDownloadGb: 27.1,
    repoFiles: FASTMETAL_14B_REPO_FILES,
  }),
]);

// Immutable commits of the community FLUX.3 Klein MLX conversions. They are
// third-party repos, so the render loads the verified local snapshot of exactly
// this commit instead of letting mflux follow a mutable `main`.
const flux3Repo = (bits) => `mflux-community/flux-3-image-klein-mflux-q${bits}`;
export const FLUX3_KLEIN_REVISIONS = Object.freeze({
  [flux3Repo(4)]: '79c0034de040c460e9685bf0127f40af042a2abe',
  [flux3Repo(6)]: 'ace05578b60f0185b0c1212d23fb13616d88d6c7',
  [flux3Repo(8)]: '7e46237dea3999a9792959f5e000aeb1b9f9e7df',
});

export const DEFAULT_REGISTRY = {
  _doc: 'PortOS media model registry. Edit to add models, tune defaults, or switch the text encoder. Restart the server to apply changes.',
  video: {
    // `applyVideoDisclosures` attaches the shipped provenance/licensing block
    // (lib/videoDisclosure.js) to each entry, so the seed written on a fresh
    // install and the in-memory defaults carry the same disclosure without repeating it inline here.
    // `applyVideoFinishProfiles` attaches the shipped draft → delivery
    // `finishModelId` edges (lib/videoFinishProfiles.js) the same way, so the
    // Finish relationship is declared in one place instead of inline here.
    // `applyVideoSpeedProfiles` (lib/videoSpeedProfiles.js) is the third such
    // decorator: it attaches the shipped `speedProfiles` a model offers, pin-
    // guarded on repo AND revision so a re-pointed entry keeps no schedule
    // claim we can't back.
    mlx: applyMiniMaxH3MemoryProfiles(applyVideoSpeedProfiles(applyVideoFinishProfiles(applyVideoDisclosures([
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
        steps: 30,
        guidance: 3.0,
      },
      // MiniMax H3 joint video+audio through PipeNetwork's pinned MLX port.
      // The quantized DiT is one HF snapshot; the released conditioner + VAEs
      // are an exact selective file set from MiniMax's upstream snapshot. Both
      // downloads are explicit in Video Gen, and render-time resolution is
      // cache-only.
      ...[
        { bits: 8, revision: '3ac52081470b0488921c3ec3ba84a39097bf2361' },
        { bits: 6, revision: '58ea790a856734132293164b8305c8bb80bee6fe' },
        { bits: 4, revision: '95a0e7d97f23f8b0029afea9411f13535262d935' },
      ].map(({ bits, revision }) => ({
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
        id: `minimax_h3_${bits}bit`,
        name: `MiniMax H3 MLX ${bits}-bit (reference quality, very slow, 128 GB RAM)`,
        repo: `pipenetwork/MiniMax-H3-MLX-${bits}bit`,
        revision,
      })),
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
      // with affine INT8 quantization on Apple Silicon MLX. The download size
      // in each name is the WHOLE snapshot (bundled T5 text encoder and VAE
      // included), not the MLX DiT alone — see FASTMETAL_DOWNLOAD_SIZE_PROFILES.
      {
        id: 'fastmetal_1_3b_qad',
        name: 'FastMetal 1.3B QAD (~13.4 GB download, 8+ GB RAM, 3-step)',
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
        name: 'FastMetal 5B QAD (~19.5 GB download, 16+ GB RAM, 3-step)',
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
        name: 'FastMetal 14B QAD (~27.1 GB download, 36+ GB RAM, 3-step)',
        repo: 'FastVideo/FastMetal-14B-QAD',
        // Drops the duplicated `ema/` DiT the entry script never loads (#5871).
        repoFiles: [...FASTMETAL_14B_REPO_FILES],
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
      // FastVideo's own FastH3 Dense / Data-Free snapshot, converted to MLX on
      // this machine. Listed before the third-party repack below because it is
      // the upstream checkpoint the repack is derived from.
      ...FASTH3_SOURCE_ENTRIES,
      // Convert the official V2 snapshot locally, retaining its VSA routing weights.
      ...FASTH3_SOURCE_ENTRIES.filter((entry) => entry.fastvideoMlxFormat !== 'int4').map((entry) => ({
        ...entry,
        id: `fasth3_v2_${entry.fastvideoMlxFormat}`,
        name: `FastH3 8-Step V2 — MLX ${entry.fastvideoMlxFormat.toUpperCase()} + VSA (quality, local conversion)`,
        repo: 'FastVideo/FastVideo-FastH3-8-Step-V2',
        revision: '3da2ddfe1954d9cda4c05b643dc0f26007a655c5',
        fastvideoVsa: true,
        supportedModes: ['text'],
        steps: 8,
        samplerNote: 'Quality option: 8 steps with 80% sparse attention, reference implementation. Requires an updated FastVideo runtime with VSA support. INT6 and INT8 share one ~147.9 GB source download; first use converts the DiT locally with routing weights retained. Not a real-time model.',
      })),
      // FastH3 Omni reference-to-video+audio (FastVideo PR #2000).
      structuredClone(FASTH3_OMNI_ENTRY),
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
    ])))),
    cuda: applyMiniMaxH3MemoryProfiles(applyVideoSpeedProfiles(applyVideoFinishProfiles(applyVideoDisclosures([
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
        // on a smaller one (see scripts/ml/generate_minimax_h3_cuda.py).
        memoryGb: 96,
        steps: 8,
        guidance: 0,
        samplerLocked: true,
        samplerNote: 'MiniMax H3 is CFG-distilled. Quality keeps the stock 8-point sigma schedule with no CFG; an explicit LightX2V speed profile owns its complete schedule.',
        supportsNegativePrompt: false,
        supportsTiling: false,
        supportsDisableAudio: false,
      },
    ])))),
    defaultMlx: 'fastmetal_5b_qad',
    defaultCuda: 'ltx_video',
  },
  image: [
    {
      id: MOSS_IMAGE_MODEL_ID, name: 'MOSS Image SFT Preview (Swift/MLX bf16, 27.2 GB download, 48+ GB RAM)',
      runner: 'moss-swift', repo: 'OpenMOSS-Team/MOSS-Image-SFT',
      revision: 'fc5de0d56fc910cbca6f6625a70f5f582b26deb1',
      steps: 50, guidance: 3, quantization: 'bf16', supportsImg2Img: false, supportsLoras: false,
      hardwareRequirements: { platforms: ['darwin'], architectures: ['arm64'], requiresAppleSilicon: true, minMemoryGb: 48 },
      license: 'apache-2.0', licenseUrl: 'https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT/blob/fc5de0d56fc910cbca6f6625a70f5f582b26deb1/LICENSE',
    },
    {
      id: MINIMAX_H3_IMAGE_MODEL_ID, name: 'MiniMax H3-Image (MLX bf16, up to 16 refs, 4K, 69 GB download, 128 GB RAM)',
      runner: 'minimax-h3-image', repo: 'MiniMaxAI/MiniMax-H3-Image',
      revision: '492fd8c4eca666f1085f57e30738c1e0d86b3439', repoFiles: MINIMAX_H3_IMAGE_REPO_FILES,
      requiredWeights: [{ repo: 'MiniMaxAI/MiniMax-H3', revision: '6818f6c32d12b210915e44ad56a4228c2608f160', files: MINIMAX_H3_CONDITIONER_FILES }],
      steps: 6, guidance: 0, cfgDisabled: true, samplerLocked: true, quantization: 'bf16',
      supportsImg2Img: false, supportsLoras: false, supportsNegativePrompt: false,
      maxReferenceImages: 16,
      hardwareRequirements: { platforms: ['darwin'], architectures: ['arm64'], requiresAppleSilicon: true, minMemoryGb: 96 },
      license: 'minimax-h3-image-community-license',
      licenseUrl: 'https://huggingface.co/MiniMaxAI/MiniMax-H3-Image',
    },
    // The community conversions contain all components and are ungated. Their
    // availability does not certify acceptance of BFL's upstream terms.
    ...[4, 6, 8].map(bits => ({
      id: `flux3-klein-q${bits}`, name: `FLUX.3 Klein Q${bits} (MLX, 32+ GB RAM)`,
      runner: 'flux3', repo: flux3Repo(bits), revision: FLUX3_KLEIN_REVISIONS[flux3Repo(bits)],
      steps: 16, guidance: 0, cfgDisabled: true, quantization: `q${bits}`,
      supportsImg2Img: false, supportsLoras: false, supportsNegativePrompt: false,
      license: 'flux-kommunity-license',
      licenseUrl: 'https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/main/LICENSE.md',
      disclosure: 'FLUX Kommunity License v1.0: non-commercial use, with a commercial-output exception for qualifying users below US$5M annualized revenue, subject to the full terms, output review/filtering and required AI disclosures. Community weights are ungated; access does not verify upstream acceptance. Write a full scene caption (or use Refine). Edits accept up to 10 reference images; init-image strength, negative prompts and LoRAs are unavailable.',
    })),
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
      revision: flux2RepoRevision('Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic'),
      tokenizerRepo: 'black-forest-labs/FLUX.2-klein-4B',
      tokenizerRevision: flux2RepoRevision('black-forest-labs/FLUX.2-klein-4B'),
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
      revision: flux2RepoRevision('Disty0/FLUX.2-klein-9B-SDNQ-4bit-dynamic-svd-r32'),
      // KV repo's tokenizer is the same Qwen3 tokenizer as the base 9B repo,
      // but the multi-reference editing path in scripts/ml/flux2_macos.py probes
      // HF auth against this value — pinning to the KV repo means accepting
      // its license once enables both single-ref + multi-ref renders.
      tokenizerRepo: 'black-forest-labs/FLUX.2-klein-9B-kv',
      tokenizerRevision: flux2RepoRevision('black-forest-labs/FLUX.2-klein-9B-kv'),
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
      revision: flux2RepoRevision('aydin99/FLUX.2-klein-4B-int8'),
      basePipelineRepo: 'black-forest-labs/FLUX.2-klein-4B',
      basePipelineRevision: flux2RepoRevision('black-forest-labs/FLUX.2-klein-4B'),
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
      revision: flux2RepoRevision('black-forest-labs/FLUX.2-klein-9B'),
      // Multi-reference editing loads this `-kv` sibling repo instead of the
      // base 9B (its transformer is tuned for the K/V reference-editing task).
      // The plain text/i2i bf16 path stays on `repo`. Same FLUX.2-klein
      // license — accept once at huggingface.co. Threaded to the runner as
      // `--kv-repo`; see scripts/ml/flux2_macos.py.
      kvRepo: 'black-forest-labs/FLUX.2-klein-9B-kv',
      kvRevision: flux2RepoRevision('black-forest-labs/FLUX.2-klein-9B-kv'),
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
      revision: diffusersRepoRevision('HiDream-ai/HiDream-I1-Full'),
      pipelineClass: 'HiDreamImagePipeline',
      textEncoderRepo: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      textEncoderRevision: diffusersRepoRevision('meta-llama/Meta-Llama-3.1-8B-Instruct'),
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
      revision: diffusersRepoRevision('HiDream-ai/HiDream-I1-Fast'),
      pipelineClass: 'HiDreamImagePipeline',
      textEncoderRepo: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      textEncoderRevision: diffusersRepoRevision('meta-llama/Meta-Llama-3.1-8B-Instruct'),
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
      revision: diffusersRepoRevision('Qwen/Qwen-Image'),
      pipelineClass: 'QwenImagePipeline',
      steps: 30,
      guidance: 4.0,
    },
    {
      id: 'qwen-image-edit',
      name: 'Qwen-Image-Edit (20B, image-to-image + text-rewrite)',
      runner: 'qwen',
      repo: 'Qwen/Qwen-Image-Edit',
      revision: diffusersRepoRevision('Qwen/Qwen-Image-Edit'),
      pipelineClass: 'QwenImageEditPipeline',
      steps: 30,
      guidance: 4.0,
      // QwenImageEditPipeline requires a source `image` arg — a text-only
      // submission crashes deep inside diffusers. `editOnly` lets the route
      // reject (and the UI gate) a render with no init image up-front.
      editOnly: true,
    },
    // Qwen 2.1 unifies generation/editing in a new RGBA pipeline. Its
    // research license differs from the original Apache-licensed Qwen models.
    {
      id: 'qwen-image-2.1',
      name: 'Qwen-Image 2.1 (7B DiT, generation + editing, research license)',
      runner: 'qwen',
      repo: 'Qwen/Qwen-Image-2.1',
      revision: diffusersRepoRevision('Qwen/Qwen-Image-2.1'),
      pipelineClass: 'QwenImage21Pipeline',
      steps: 40,
      guidance: 1.0,
      cfgDisabled: true,
      licenseUrl: 'https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE',
    },
    // z-image runner — Apache 2.0, ungated, reuses the FLUX.2 venv. Turbo
    // distillation runs ~8 steps with CFG disabled (guidance 1.0).
    {
      id: 'z-image-turbo-bf16',
      name: 'Z-Image-Turbo (bf16, ~13 GB)',
      runner: 'z-image',
      repo: 'Tongyi-MAI/Z-Image-Turbo',
      revision: diffusersRepoRevision('Tongyi-MAI/Z-Image-Turbo'),
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
      revision: diffusersRepoRevision('baidu/ERNIE-Image'),
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
      revision: diffusersRepoRevision('baidu/ERNIE-Image-Turbo'),
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

// The shipped default registry, cloned so a caller (a migration adding a new
// shipped row to an existing install) can never mutate the in-memory defaults.
export const getShippedMediaRegistry = () => structuredClone(DEFAULT_REGISTRY);
