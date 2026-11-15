/**
 * Swappable text-encoder (prompt conditioner) registry for local video runtimes.
 *
 * MiniMax H3 does not use its Qwen3-VL-32B conditioner as a language model: the
 * DiT reads the **unnormalized** hidden state after language layer 49 and feeds
 * it straight into `condition_proj`. Layers 50-63, the final norm and `lm_head`
 * are never evaluated. That makes the conditioner unusually easy to substitute —
 * any checkpoint carrying the same Qwen3-VL embedding + layers 0-49 + vision
 * tower produces a drop-in conditioning signal, and swapping it changes how the
 * model *reads* a prompt without touching the diffusion weights at all.
 *
 * This module is the single source of truth for which substitutions PortOS
 * ships. Entries are pinned upstream artifacts rather than user-tunable config,
 * so they live in code (mirroring `lib/icLoraWeights.js`) instead of the
 * media-models registry — no seed file, no migration, and no way for a stale
 * `data/media-models.json` to reference a file the runner can't map.
 *
 * The one non-obvious field is `keyPrefixMap`. A ComfyUI-packaged conditioner
 * flattens the transformers namespace (`model.layers.N.…` / `visual.…`) while
 * the MLX port's loader matches the HF namespace (`model.language_model.layers.N.…`
 * / `model.visual.…`). The map is applied by scripts/generate_minimax_h3.py to
 * every checkpoint key BEFORE the pinned loader sees it, so a repackaged file
 * loads with no change to (and no fork of) the pinned runtime source.
 *
 * `finalNormKey` exists for the same reason: the pinned loader instantiates the
 * full module tree (including `norm`, which it deliberately never applies) and
 * refuses to load with any parameter missing. A conditioner published without
 * the final norm — correct, since H3 reads the state before it — would trip
 * that check, so the runner synthesizes a ones-filled `norm.weight` under this
 * key. Absent means "the checkpoint ships its own norm".
 *
 * `files` is always a LIST, because a substitute is either one repackaged
 * safetensors or the subset of an upstream model's shards that actually carries
 * the 903 parameters the loader builds. The runner symlinks every entry into the
 * shim's `text_encoder/` and the loader globs `*.safetensors` there, so a
 * multi-shard checkpoint needs no index file and no loader change — but the list
 * must stay an explicit pin rather than a repo snapshot, since these repos also
 * publish quantizations, generation tails and (for a full upstream checkpoint)
 * the layers past the conditioning depth that H3 never evaluates.
 *
 * COMPATIBILITY RULE for a new entry: the checkpoint must be Qwen3-VL-32B —
 * same `text_config` (hidden 5120, 64 layers, vocab 151936, head_dim 128) and
 * the same vision geometry, because the shim reuses UPSTREAM's config,
 * tokenizer and processor. A different Qwen generation is not a substitute
 * however similar its conditioning width looks: Qwen3.5's linear-attention
 * layers, 248320-token vocabulary and separate tokenizer have no mapping onto
 * the module tree this loader builds, and no key remap can create one.
 *
 * ---------------------------------------------------------------------------
 * LTX-2.5 (#4320)
 *
 * The 2.5 packs condition through a Gemma 4 12B tower that ships INSIDE the
 * pack under `text_encoder/`, and the pinned fork's
 * `PromptEncoder._text_encoder_source` prefers that local directory
 * UNCONDITIONALLY whenever its `config.json` reports `model_type: "gemma4"` —
 * `gemma_model_id` (the `--gemma` flag the 2.3 runtime uses) is ignored. So a
 * 2.5 substitution overrides that RESOLUTION rather than passing a repo id,
 * which is why `ltx2` and `ltx25` share a runner but not a mechanism.
 *
 * The substitution is again a shim directory, but of a different shape than
 * H3's: the runner links the substitute's shards, its
 * `model.safetensors.index.json` and its tokenizer/generation configs into one
 * flat directory and writes `config.json` itself, then points the pinned
 * loader at that directory. Nothing comes from the pack, because unlike H3
 * (where the vision geometry and processor must stay upstream's) a Gemma 4
 * tower is self-describing.
 *
 * `configOverrides` is the one field this runtime adds: the shim's generated
 * `config.json` is the SUBSTITUTE's own config with these keys merged over it
 * (`vision_config` / `audio_config` are dropped either way, so what remains is
 * the `model_type` + `text_config` + `quantization` triple the fork's
 * `convert_ltx25_to_mlx.py --step text-encoder` emits). It exists because a
 * *unified* Gemma 4 checkpoint publishes `model_type: "gemma4_unified"`, which
 * `Gemma4LanguageModel.load()` hard-rejects. mlx-lm's
 * `gemma4.Model.sanitize()` already discards the `vision_tower.*` /
 * `audio_tower.*` / `multi_modal_projector.*` towers at load; the runner adds
 * one exact-prefix filter for the eleven residual `vision_embedder.*` tensors
 * found by the real strict-load gate. Omit the field entirely for a text-only
 * checkpoint that already reports `gemma4`; the `quantization` block is NEVER
 * overridden, because per-layer group-size overrides are part of how the
 * weights were packed and a mismatched group size dequantizes to noise.
 *
 * COMPATIBILITY RULE for a new ltx25 entry: the checkpoint must be Gemma 4 12B
 * at the LTX-2.5 tower's exact geometry — 48 layers, hidden 3840, vocab 262144,
 * head_dim 256, `attention_k_eq_v: true` — because `Gemma4LanguageModel`
 * hard-validates `model_type`, the layer count and the hidden size on load, and
 * the pack's connector was trained against a 49-hidden-state stack of that
 * width. A different Gemma generation is not a substitute: Gemma 3's tokenizer,
 * vocabulary and layer count have no mapping onto the module tree mlx-lm's
 * `gemma4` builds.
 *
 * `verified` — COHERENCE GATE COMPLETED 2026-08-16 (#4320). Both initial candidates
 * strict-loaded and produced finite connector inputs on the pinned runtime,
 * then rendered a fixed-seed matrix at 512x320 / 33 frames / 24 fps / 8+3
 * steps / CFG 3: one benign motion prompt plus staged-bite, explicit-gesture
 * and prop-cigarette challenges. The 4-bit tower stayed broadly coherent but
 * did not improve the target behavior: stock described the staged bite and
 * cigarette more literally, while both produced an index finger for the
 * requested middle-finger gesture. The 8-bit tower was likewise stock-like on
 * all three challenges, still produced an index finger, and fragmented the
 * benign prompt's single kite into several red objects.
 *
 * Both therefore remain `verified: false`, hidden from
 * `videoTextEncoderOptions` and the download lane (see
 * `isOfferedTextEncoder`). They stay declared as pinned failure records so a
 * later candidate search does not repeat either download or gate.
 *
 * #4470 adds a third, still-gated candidate from the exact Heretic language
 * backbone used by DeepNeuralNerd's LTX-2.5-specific ComfyUI conversion. That
 * conversion keeps LTX's projection weights; PortOS already loads the pinned
 * pack's connector separately, so the equivalent MLX artifact is the same
 * language tower paired with that stock connector. Its three-shard MXFP8 export
 * preserves all 48 language layers and the checkpoint's quantization metadata,
 * while the existing narrow unified-checkpoint sanitizer removes only its
 * residual `vision_embedder.*` tensors. The 2026-08-17 production preflight
 * removed exactly ten such tensors, strict-loaded with zero missing or extra
 * language keys, and produced finite connector inputs for all four controlled
 * prompts. The full repeated-seed visual matrix did not complete, so this is
 * technical compatibility evidence, not a behavioral pass. It remains
 * unreachable until that matrix proves BOTH benign structural coherence and a
 * repeatable target-behavior improvement.
 */

import { ServerError } from './errorHandler.js';
import { APACHE_2, GEMMA_TERMS } from './videoDisclosure.js';

// Every runtime's built-in conditioner option. Selected by default and always
// present, so the picker never renders a single-option select and a render that
// omits `textEncoderId` behaves exactly as it did before this feature existed.
export const STOCK_TEXT_ENCODER_ID = 'stock';

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

// Substitutable conditioners, keyed by the runtime whose loader can consume
// them. A runtime absent from this table has no picker at all.
const TEXT_ENCODERS_BY_RUNTIME = Object.freeze({
  minimax_h3: Object.freeze([
    STOCK_MINIMAX_H3,
    Object.freeze({
      id: 'heretic-bf16',
      label: 'Ultra-Heretic uncensored — Qwen3-VL-32B bf16',
      description:
        'Abliterated Qwen3-VL-32B conditioner (Heretic v1.2.0, attention-targeted) repackaged for H3. '
        + 'Reads prompts the stock conditioner refuses or waters down; the diffusion weights are unchanged.',
      // A/B-rendered against the stock conditioner at fixed seed in #4081.
      verified: true,
      repo: 'ethanfel/Qwen3-VL-32B-Ultra-Heretic-H3-ComfyUI-INT8-ConvRot',
      revision: 'e8967f6a39ea5b4939a1aff81be3e8706490c0e8',
      files: Object.freeze(['qwen3vl_32b_h3_ultra_uncensored_heretic_bf16.safetensors']),
      // ComfyUI namespace -> the HF namespace the pinned MLX loader matches.
      // Longest-prefix-first is applied at the runner, so these two disjoint
      // rules can be declared in any order.
      keyPrefixMap: Object.freeze({
        'model.': 'model.language_model.',
        'visual.': 'model.visual.',
      }),
      // Published without the final norm (`minimax_h3_final_norm: "false"` in
      // its safetensors metadata) — synthesized by the runner in THIS file's
      // own namespace, so the prefix map above rewrites it like any other key.
      finalNormKey: 'model.norm.weight',
      // The exact published size of THIS file. Single source of truth for every
      // size the UI shows — the picker formats it rather than carrying a second,
      // driftable "~N GB" literal.
      sizeBytes: 51506295440,
      // Same shape as VIDEO_MODEL_DISCLOSURES, and rendered by the same
      // FactLink affordance — reusing that module's license descriptor rather
      // than restating the Apache text URL. `estimatedDownloadGb` is omitted on
      // purpose: `sizeBytes` above is the one size, and the UI formats it.
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
      // The upstream shard layout, minus the two shards that hold ONLY language
      // layers 50-63 — parameters the loader never builds (H3 conditions on the
      // state after layer 49). Verified against this revision's
      // model.safetensors.index.json: the 12 shards below carry all 903
      // parameters the port instantiates, and shards 12 + 13 carry none of them.
      // Pinned by name rather than snapshotted so a repo re-shard can't silently
      // change what gets pulled — it fails the cache check instead.
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
      // No keyPrefixMap and no finalNormKey: this is the upstream Hugging Face
      // namespace the pinned loader already matches, and it ships its own
      // `model.language_model.norm.weight` (in shard 14, which is why that shard
      // is pulled for one tensor rather than synthesized).
      sizeBytes: 56962931632,
      disclosure: Object.freeze({
        modelCardUrl: 'https://huggingface.co/huihui-ai/Huihui-Qwen3-VL-32B-Instruct-abliterated',
        weightsLicense: APACHE_2,
        reviewedAt: '2026-08-15',
      }),
    }),
  ]),
  // LTX-2.5 (#4320). Unlike H3's, an ltx25 shim takes EVERYTHING from the
  // substitute — a Gemma 4 tower is self-describing — so `files` pins the
  // tokenizer, the shard index and the generation config alongside the shards
  // themselves. All of them are inputs to the shim the runner builds, and
  // `sizeBytes` is their exact published total.
  //
  // The first two substitutes failed the 2026-08-16 coherence/behavior gate
  // described in the docblock. The LTX-specific follow-up failed the two-seed
  // gate in #4470. All remain pinned provenance records, while
  // `verified: false` keeps every non-passing entry out of both public lanes.
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
      // Already the exact shape convert_ltx25_to_mlx.py emits — its config.json
      // reports `model_type: "gemma4"` — so no `configOverrides`. Every shard is
      // pinned: this is a text-only export with no tower the loader skips, so
      // there is no shard to leave out the way the huihui H3 entry does.
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
      // Published as `gemma4_unified`, which Gemma4LanguageModel.load()
      // hard-rejects. The shim rewrites the type, mlx-lm's sanitizer discards
      // its main vision/audio towers, and the runner removes the eleven residual
      // `vision_embedder.*` tensors found by the strict-load gate. It keeps the
      // substitute's own `quantization` block (group 32 with per-layer 64
      // overrides on the MLP projections) verbatim.
      configOverrides: Object.freeze({ model_type: 'gemma4' }),
      // All three shards, none skippable: shard 3 interleaves 233 language keys
      // with 17 audio/vision keys, so dropping it to save the towers would take
      // the tail of the language stack with it.
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
      // Exact MLX quantization of llmfan46's Heretic backbone — the same source
      // named by DeepNeuralNerd's LTX-2.5 conversion. The unified checkpoint
      // carries ten visual-only `vision_embedder.*` tensors; the runner's
      // narrow sanitizer drops those while strict-loading every language key.
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
 * `true` when an entry may be offered to a render at all.
 *
 * A substitute is only shippable once it has been A/B-rendered against the
 * runtime's stock conditioner (see the `verified` note in the docblock), and
 * "not yet checked" must not collapse into "fine" — so the flag is REQUIRED on
 * every non-built-in entry and absence fails closed. Applied to both lanes:
 * an unverified entry is neither offered to the picker (so route validation
 * rejects its id) nor listed as a download target (so its tens of GB can't be
 * pulled for something no render can select).
 */
const isOfferedTextEncoder = (entry) => !!entry.builtIn || entry.verified === true;

/**
 * Every conditioner option a model can render with, stock first — `[]` for a
 * runtime this build has no conditioner table for.
 *
 * Deliberately NOT filtered down to "more than one option": that is a
 * presentation rule, and folding it in here would quietly change what the
 * SERVER believes a model supports (and empty the "offers …" list in the error
 * below) for a reason that is only about how a `<select>` looks. The picker
 * owns the hide-when-there-is-no-real-choice check.
 */
export const videoTextEncoderOptions = (model) =>
  (TEXT_ENCODERS_BY_RUNTIME[model?.runtime] || []).filter(isOfferedTextEncoder);

/** Every runtime this build declares conditioners for — what parity/shape tests enumerate. */
export const videoTextEncoderRuntimes = () => Object.keys(TEXT_ENCODERS_BY_RUNTIME);

/** Resolve one option by id, or `null` when the model can't render with it. */
export const videoTextEncoderOption = (model, id) =>
  videoTextEncoderOptions(model).find((entry) => entry.id === id) || null;

/**
 * `true` when `id` is absent or names the runtime's built-in conditioner —
 * i.e. the render needs no override plumbing at all. A model with no
 * substitutions accepts only the stock id (and absence).
 */
export const isStockTextEncoder = (id) => !id || id === STOCK_TEXT_ENCODER_ID;

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
// Deduped by id, not merely flattened: the table is keyed by RUNTIME, so one
// conditioner can legitimately be offered by two of them — and a duplicate here
// would mean two download targets and two status rows for one file.
export const downloadableVideoTextEncoders = () => [...new Map(
  Object.values(TEXT_ENCODERS_BY_RUNTIME).flat()
    .filter((entry) => !entry.builtIn && isOfferedTextEncoder(entry))
    .map((entry) => [entry.id, entry]),
).values()];

/**
 * Every substitute this build DECLARES, verified or not — the unfiltered table,
 * flattened.
 *
 * Exists so the shape invariants (pinned 40-hex revision, safe repo-relative
 * file list, exact `sizeBytes`, model card) are enforced on an entry the moment
 * it is written down, rather than only once someone flips `verified`. The render
 * and download paths must NOT use this: they go through `videoTextEncoderOptions`
 * / `downloadableVideoTextEncoders`, which apply the gate.
 */
export const declaredVideoTextEncoders = () => Object.values(TEXT_ENCODERS_BY_RUNTIME)
  .flat().filter((entry) => !entry.builtIn);

/** Resolve a downloadable conditioner by id for the download/repair routes. */
export const downloadableVideoTextEncoder = (id) =>
  downloadableVideoTextEncoders().find((entry) => entry.id === id) || null;

/**
 * The client-facing projection of an option — exactly what the picker renders,
 * nothing more.
 *
 * An allowlist, not a blocklist, so a new loader-mechanics field is invisible to
 * the client by default. It deliberately drops `keyPrefixMap` / `finalNormKey` /
 * `configOverrides` (mechanics that would only invite a client-side
 * reimplementation), `verified` (an entry that isn't offered never reaches the
 * client at all), `revision`, and `files`: the client never addresses the weight
 * by path — it passes the option's `id` and the server resolves the rest. `repo`
 * stays because the download badge names it in its tooltip.
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
