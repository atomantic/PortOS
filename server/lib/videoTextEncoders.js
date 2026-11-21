/**
 * Swappable text-encoder (prompt conditioner) registry for local video runtimes.
 *
 * MiniMax H3 reads the **unnormalized** hidden state after language layer 49 of its Qwen3-VL-32B conditioner and
 * feeds it to `condition_proj`; layers 50-63, the final norm and `lm_head` are never evaluated. Any checkpoint
 * carrying the same Qwen3-VL embedding + layers 0-49 + vision tower is therefore a drop-in substitute.
 *
 * Entries are pinned upstream artifacts living in code (mirroring `lib/icLoraWeights.js`), not the media-models
 * registry, so no seed/migration is needed and a stale `data/media-models.json` can't reference an unmappable file.
 *
 * `keyPrefixMap`: a ComfyUI-packaged conditioner flattens the transformers namespace (`model.layers.N.`,
 * `visual.`) while the MLX loader matches the HF one (`model.language_model.layers.N.`, `model.visual.`).
 * scripts/ml/generate_minimax_h3.py applies it to every key BEFORE the pinned loader sees them.
 *
 * `finalNormKey`: the pinned loader builds the full module tree (including the never-applied `norm`) and refuses
 * any missing parameter, so for a checkpoint published without the final norm the runner synthesizes a
 * ones-filled `norm.weight` under this key. Absent means the checkpoint ships its own norm.
 *
 * `files` is always a LIST (one repackaged safetensors or the subset of shards carrying the 903 parameters the
 * loader builds). The runner symlinks each into the shim's `text_encoder/` and the loader globs `*.safetensors`.
 * It must stay an explicit pin, not a repo snapshot: these repos also publish quantizations, generation tails and
 * layers past the conditioning depth.
 *
 * COMPATIBILITY RULE (H3): the checkpoint must be Qwen3-VL-32B (hidden 5120, 64 layers, vocab 151936, head_dim
 * 128, same vision geometry), because the shim reuses UPSTREAM's config, tokenizer and processor. Another Qwen
 * generation (e.g. Qwen3.5's linear attention, 248320-token vocab) has no mapping onto this module tree.
 *
 * ---------------------------------------------------------------------------
 * LTX-2.5 (#4320)
 *
 * The 2.5 packs ship a Gemma 4 12B tower under `text_encoder/`, which the pinned fork's
 * `PromptEncoder._text_encoder_source` prefers UNCONDITIONALLY when its `config.json` reports
 * `model_type: "gemma4"`, ignoring `gemma_model_id`. A 2.5 substitution therefore overrides that RESOLUTION
 * rather than passing a repo id (why `ltx2` and `ltx25` share a runner but not a mechanism).
 *
 * The runner links the substitute's shards, `model.safetensors.index.json` and tokenizer/generation configs into
 * one flat directory, writes `config.json` itself and points the pinned loader there. Nothing comes from the
 * pack: a Gemma 4 tower is self-describing.
 *
 * `configOverrides`: the generated `config.json` is the SUBSTITUTE's own config with these keys merged over it
 * (`vision_config` / `audio_config` dropped). Needed because a *unified* Gemma 4 checkpoint publishes
 * `model_type: "gemma4_unified"`, which `Gemma4LanguageModel.load()` hard-rejects. mlx-lm's sanitizer already
 * drops the vision/audio/projector towers; the runner adds one exact-prefix filter for the eleven residual
 * `vision_embedder.*` tensors. Omit it for a text-only checkpoint already reporting `gemma4`. The `quantization`
 * block is NEVER overridden: per-layer group sizes are part of how the weights were packed.
 *
 * COMPATIBILITY RULE (ltx25): Gemma 4 12B at the tower's exact geometry (48 layers, hidden 3840, vocab 262144,
 * head_dim 256, `attention_k_eq_v: true`), since `Gemma4LanguageModel` hard-validates `model_type`, layer count
 * and hidden size and the connector was trained on a 49-hidden-state stack of that width. Gemma 3 has no mapping
 * onto mlx-lm's `gemma4` module tree.
 *
 * `verified`: the coherence gate (2026-08-16, #4320) ran a fixed-seed matrix at 512x320 / 33 frames / 24 fps /
 * 8+3 steps / CFG 3. Both initial candidates (4-bit, 8-bit) stayed broadly coherent but did not improve the
 * target behavior (still an index finger for the requested gesture; the 8-bit fragmented the benign prompt). A
 * third candidate (#4470, Heretic backbone with the stock connector, MXFP8) strict-loaded and produced finite
 * connector inputs but its repeated-seed matrix did not pass, so that is technical evidence, not a behavioral pass.
 *
 * All remain `verified: false`, hidden from `videoTextEncoderOptions` and the download lane (see
 * `isOfferedTextEncoder`), kept as pinned failure records so a later search does not repeat a download or gate.
 * Reachable only once a matrix proves BOTH benign structural coherence and a repeatable improvement.
 */

import { ServerError } from './errorHandler.js';
import { APACHE_2, GEMMA_TERMS } from './videoDisclosure.js';
import { STOCK_TEXT_ENCODER_ID, isStockTextEncoder } from './videoRequestDefaults.js';

// The no-override sentinel and its predicate live in the browser-safe leaf the client form shares.
export { STOCK_TEXT_ENCODER_ID, isStockTextEncoder };

// Every runtime's built-in conditioner option (`STOCK_TEXT_ENCODER_ID`): always present, so the picker never
// renders a single-option select and an omitted `textEncoderId` behaves as stock.

const STOCK_MINIMAX_H3 = Object.freeze({
  id: STOCK_TEXT_ENCODER_ID,
  label: 'Stock — MiniMax H3 Qwen3-VL-32B',
  description: 'The conditioner published inside the H3 checkpoint. Already downloaded with the model.',
  builtIn: true,
});

const STOCK_LTX25 = Object.freeze({
  id: STOCK_TEXT_ENCODER_ID,
  label: 'Stock — LTX-2.5 Gemma 4 12B',
  description: 'The Gemma 4 conditioner packed inside the LTX-2.5 model. Already downloaded with the model.',
  builtIn: true,
});

// Substitutable conditioners, keyed by the runtime whose loader can consume them; absent = no picker.
const TEXT_ENCODERS_BY_RUNTIME = Object.freeze({
  minimax_h3: Object.freeze([
    STOCK_MINIMAX_H3,
    Object.freeze({
      id: 'heretic-bf16',
      label: 'Ultra-Heretic uncensored — Qwen3-VL-32B bf16',
      description:
        'Abliterated Qwen3-VL-32B conditioner (Heretic v1.2.0, attention-targeted) repackaged for H3. '
        + 'Reads prompts the stock conditioner refuses or waters down; the diffusion weights are unchanged.',
      verified: true,
      repo: 'ethanfel/Qwen3-VL-32B-Ultra-Heretic-H3-ComfyUI-INT8-ConvRot',
      revision: 'e8967f6a39ea5b4939a1aff81be3e8706490c0e8',
      files: Object.freeze(['qwen3vl_32b_h3_ultra_uncensored_heretic_bf16.safetensors']),
      // ComfyUI namespace -> the HF namespace the pinned loader matches; applied longest-prefix-first at the runner.
      keyPrefixMap: Object.freeze({
        'model.': 'model.language_model.',
        'visual.': 'model.visual.',
      }),
      // Published without the final norm (`minimax_h3_final_norm: "false"`); synthesized by the runner in THIS
      // file's namespace, so the prefix map rewrites it like any other key.
      finalNormKey: 'model.norm.weight',
      // Exact published size; the one size source for the UI, which formats it.
      sizeBytes: 51506295440,
      // Same shape as VIDEO_MODEL_DISCLOSURES (reuses its license descriptor); `estimatedDownloadGb` omitted because `sizeBytes` is the one size.
      disclosure: Object.freeze({
        modelCardUrl: 'https://huggingface.co/ethanfel/Qwen3-VL-32B-Ultra-Heretic-H3-ComfyUI-INT8-ConvRot',
        weightsLicense: APACHE_2,
        reviewedAt: '2026-08-14',
      }),
    }),
    Object.freeze({
      id: 'huihui-abliterated',
      label: 'Huihui abliterated — Qwen3-VL-32B bf16',
      description:
        'Qwen3-VL-32B-Instruct abliterated by huihui-ai — a different refusal-removal method than the '
        + 'Heretic substitute, so it reads prompts differently again. Upstream checkpoint, not a repack.',
      verified: true,
      repo: 'huihui-ai/Huihui-Qwen3-VL-32B-Instruct-abliterated',
      revision: '5e88d9b37e5dca1e95d434f5c4ddfa9b51b1591c',
      // Upstream shards minus the two holding ONLY layers 50-63 (never built): the 12 below carry all 903
      // parameters. Pinned by name so a repo re-shard fails the cache check instead of changing the pull.
      files: Object.freeze([
        'model-00001-of-00014.safetensors',
        'model-00002-of-00014.safetensors',
        'model-00003-of-00014.safetensors',
        'model-00004-of-00014.safetensors',
        'model-00005-of-00014.safetensors',
        'model-00006-of-00014.safetensors',
        'model-00007-of-00014.safetensors',
        'model-00008-of-00014.safetensors',
        'model-00009-of-00014.safetensors',
        'model-00010-of-00014.safetensors',
        'model-00011-of-00014.safetensors',
        'model-00014-of-00014.safetensors',
      ]),
      // No keyPrefixMap/finalNormKey: upstream HF namespace, and it ships its own
      // `model.language_model.norm.weight` (in shard 14, pulled for that one tensor).
      sizeBytes: 56962931632,
      disclosure: Object.freeze({
        modelCardUrl: 'https://huggingface.co/huihui-ai/Huihui-Qwen3-VL-32B-Instruct-abliterated',
        weightsLicense: APACHE_2,
        reviewedAt: '2026-08-15',
      }),
    }),
  ]),
  // LTX-2.5 (#4320). An ltx25 shim takes EVERYTHING from the substitute, so `files` pins the tokenizer, shard
  // index and generation config alongside the shards; `sizeBytes` is their exact total. All entries are pinned
  // provenance records; `verified: false` keeps non-passing ones out of both public lanes.
  ltx25: Object.freeze([
    STOCK_LTX25,
    Object.freeze({
      id: 'ltx25-abliterated-4bit',
      label: 'Abliterated uncensored — Gemma 4 12B 4-bit',
      description:
        'Abliterated Gemma 4 12B conditioner, text tower only, MLX 4-bit. Retained as a gated '
        + 'candidate record after fixed-seed renders showed no repeatable prompt-following gain.',
      // Failed #4320: coherent, but stock was more literal on two challenges
      // and both conditioners substituted an index finger for the third.
      verified: false,
      repo: 'divinetribe/gemma-4-12B-it-abliterated-4bit-mlx-text',
      revision: '3f123973331780c8702344dad62445ab09436ef3',
      // Already the shape convert_ltx25_to_mlx.py emits (`model_type: "gemma4"`), so no `configOverrides`. Every
      // shard is pinned: a text-only export has no tower to skip.
      files: Object.freeze([
        'config.json',
        'generation_config.json',
        'chat_template.jinja',
        'model-00001-of-00003.safetensors',
        'model-00002-of-00003.safetensors',
        'model-00003-of-00003.safetensors',
        'model.safetensors.index.json',
        'tokenizer.json',
        'tokenizer_config.json',
      ]),
      sizeBytes: 10978240781,
      disclosure: Object.freeze({
        modelCardUrl: 'https://huggingface.co/divinetribe/gemma-4-12B-it-abliterated-4bit-mlx-text',
        weightsLicense: GEMMA_TERMS,
        reviewedAt: '2026-08-15',
      }),
    }),
    Object.freeze({
      id: 'ltx25-heretic-8bit',
      label: 'Heretic uncensored — Gemma 4 12B 8-bit',
      description:
        'Gemma 4 12B abliterated with the Heretic method — the same family as the H3 Ultra-Heretic '
        + 'conditioner, at 8-bit. Retained as a gated candidate record after the fixed-seed gate failed.',
      // Failed #4320: challenge behavior stayed stock-like, the explicit
      // gesture was still an index finger, and the benign kite fragmented.
      verified: false,
      repo: 'culturerevolt/gemma-4-12b-heretic-abliterated-8bit-mlx',
      revision: '86c60c34eb11613fbaae0353e2bfac83a32ce8a3',
      // Published as `gemma4_unified`, which Gemma4LanguageModel.load() hard-rejects; the shim rewrites the type and
      // keeps the substitute's own `quantization` block (group 32, per-layer 64 on MLP projections) verbatim.
      configOverrides: Object.freeze({ model_type: 'gemma4' }),
      // All three shards, none skippable: shard 3 interleaves 233 language keys with 17 audio/vision keys.
      files: Object.freeze([
        'config.json',
        'generation_config.json',
        'chat_template.jinja',
        'model-00001-of-00003.safetensors',
        'model-00002-of-00003.safetensors',
        'model-00003-of-00003.safetensors',
        'model.safetensors.index.json',
        'tokenizer.json',
        'tokenizer_config.json',
      ]),
      sizeBytes: 12964622094,
      disclosure: Object.freeze({
        modelCardUrl: 'https://huggingface.co/culturerevolt/gemma-4-12b-heretic-abliterated-8bit-mlx',
        weightsLicense: GEMMA_TERMS,
        reviewedAt: '2026-08-15',
      }),
    }),
    Object.freeze({
      id: 'ltx25-ltx-heretic-mxfp8',
      label: 'LTX Heretic uncensored — Gemma 4 12B MXFP8',
      description:
        'The Heretic language backbone used by an LTX-2.5-specific conditioner conversion, '
        + 'paired with the model pack\'s original LTX connector. Retained as a gated candidate record '
        + 'after the repeated-seed render matrix showed no target-behavior gain.',
      // Failed #4470: the production technical gate passed, but both fixed
      // seeds regressed on the bite and prop-cigarette prompts and produced no
      // middle-finger improvement. The benign kite remained coherent.
      verified: false,
      repo: 'nightmedia/gemma-4-12B-it-uncensored-heretic-mxfp8-mlx',
      revision: '20c9f4b167e56f3f749ea3e428188a5e7a35318a',
      // Exact MLX quantization of llmfan46's Heretic backbone (the source of DeepNeuralNerd's LTX-2.5 conversion);
      // its ten visual-only `vision_embedder.*` tensors are dropped by the runner's sanitizer.
      configOverrides: Object.freeze({ model_type: 'gemma4' }),
      files: Object.freeze([
        'config.json',
        'generation_config.json',
        'chat_template.jinja',
        'model-00001-of-00003.safetensors',
        'model-00002-of-00003.safetensors',
        'model-00003-of-00003.safetensors',
        'model.safetensors.index.json',
        'tokenizer.json',
        'tokenizer_config.json',
      ]),
      sizeBytes: 12375013657,
      disclosure: Object.freeze({
        modelCardUrl: 'https://huggingface.co/nightmedia/gemma-4-12B-it-uncensored-heretic-mxfp8-mlx',
        weightsLicense: GEMMA_TERMS,
        reviewedAt: '2026-08-17',
      }),
    }),
  ]),
});

/**
 * `true` when an entry may be offered to a render at all. Only A/B-verified substitutes ship, and "not yet
 * checked" must not collapse into "fine", so `verified` is REQUIRED on every non-built-in entry (absence fails
 * closed). Applies to both lanes: an unverified entry is neither a picker option nor a download target.
 */
const isOfferedTextEncoder = (entry) => !!entry.builtIn || entry.verified === true;

/**
 * Every conditioner option a model can render with, stock first (`[]` for a runtime with no table). Deliberately
 * NOT filtered to "more than one option": that is a presentation rule, and folding it in would change what the
 * SERVER believes a model supports; the picker owns hide-when-no-choice.
 */
export const videoTextEncoderOptions = (model) =>
  (TEXT_ENCODERS_BY_RUNTIME[model?.runtime] || []).filter(isOfferedTextEncoder);

/** Every runtime this build declares conditioners for — what parity/shape tests enumerate. */
export const videoTextEncoderRuntimes = () => Object.keys(TEXT_ENCODERS_BY_RUNTIME);

/** Resolve one option by id, or `null` when the model can't render with it. */
export const videoTextEncoderOption = (model, id) =>
  videoTextEncoderOptions(model).find((entry) => entry.id === id) || null;

/**
 * `true` when this model can actually render with `id` — i.e. the id names one
 * of its runtime's substitutable conditioners. Non-throwing, so the request
 * path can reject early (releasing staged uploads on its own terms) while the
 * service path uses `resolveVideoTextEncoder` below.
 */
export const supportsVideoTextEncoder = (model, id) => {
  const option = videoTextEncoderOption(model, id);
  return !!option && !option.builtIn;
};

/** The 400 both the request path and the service path raise for a bad id. */
export const videoTextEncoderUnsupportedError = (model, id) => {
  const offered = videoTextEncoderOptions(model).map((entry) => entry.id);
  return new ServerError(
    offered.length > 0
      ? `Model "${model?.id}" has no text encoder "${id}" (offers ${offered.join(', ')}).`
      : `Model "${model?.id}" does not support a substitute text encoder.`,
    { status: 400, code: 'VIDEO_TEXT_ENCODER_UNSUPPORTED' },
  );
};

/**
 * Resolve a requested conditioner for a render, or throw a 400 naming what the
 * model actually offers. Returns `null` for the stock choice so the caller can
 * branch on "no override" without a second predicate.
 */
export const resolveVideoTextEncoder = (model, id) => {
  if (isStockTextEncoder(id)) return null;
  const option = videoTextEncoderOption(model, id);
  if (!option || option.builtIn) throw videoTextEncoderUnsupportedError(model, id);
  return option;
};

/**
 * Every downloadable conditioner across all runtimes, deduped by id — what the
 * /models/status lane and the download/repair routes enumerate. The built-in
 * options are excluded: they ride the model's own download.
 */
// Deduped by id: the table is keyed by RUNTIME, so one conditioner can be offered by two, and a duplicate would
// mean two download targets for one file.
export const downloadableVideoTextEncoders = () => [...new Map(
  Object.values(TEXT_ENCODERS_BY_RUNTIME).flat()
    .filter((entry) => !entry.builtIn && isOfferedTextEncoder(entry))
    .map((entry) => [entry.id, entry]),
).values()];

/**
 * Every substitute this build DECLARES, verified or not, so the shape invariants (pinned 40-hex revision, safe
 * repo-relative files, exact `sizeBytes`, model card) are enforced when an entry is written, not only when
 * `verified` flips. Render and download paths must NOT use this; they apply the gate.
 */
export const declaredVideoTextEncoders = () => Object.values(TEXT_ENCODERS_BY_RUNTIME)
  .flat().filter((entry) => !entry.builtIn);

/** Resolve a downloadable conditioner by id for the download/repair routes. */
export const downloadableVideoTextEncoder = (id) =>
  downloadableVideoTextEncoders().find((entry) => entry.id === id) || null;

/**
 * The client-facing projection of an option: an allowlist, so a new loader-mechanics field is invisible to the
 * client by default. Drops `keyPrefixMap` / `finalNormKey` / `configOverrides`, `verified`, `revision` and
 * `files` (the client passes the option's `id`; the server resolves the rest). `repo` stays for the badge tooltip.
 */
export const publicTextEncoderOption = (entry) => ({
  id: entry.id,
  label: entry.label,
  description: entry.description,
  builtIn: !!entry.builtIn,
  ...(entry.repo ? { repo: entry.repo } : {}),
  ...(entry.sizeBytes ? { sizeBytes: entry.sizeBytes } : {}),
  ...(entry.disclosure ? { disclosure: entry.disclosure } : {}),
});

/**
 * The client-facing option list for a model — what `decorateVideoModel`
 * attaches to every registry entry.
 */
export const publicVideoTextEncoderOptions = (model) =>
  videoTextEncoderOptions(model).map(publicTextEncoderOption);
