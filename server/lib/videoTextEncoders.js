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
 */

import { ServerError } from './errorHandler.js';
import { APACHE_2 } from './videoDisclosure.js';

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
      repo: 'ethanfel/Qwen3-VL-32B-Ultra-Heretic-H3-ComfyUI-INT8-ConvRot',
      revision: 'e8967f6a39ea5b4939a1aff81be3e8706490c0e8',
      file: 'qwen3vl_32b_h3_ultra_uncensored_heretic_bf16.safetensors',
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
  ]),
});

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
export const videoTextEncoderOptions = (model) => TEXT_ENCODERS_BY_RUNTIME[model?.runtime] || [];

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
    .filter((entry) => !entry.builtIn)
    .map((entry) => [entry.id, entry]),
).values()];

/** Resolve a downloadable conditioner by id for the download/repair routes. */
export const downloadableVideoTextEncoder = (id) =>
  downloadableVideoTextEncoders().find((entry) => entry.id === id) || null;

/**
 * The client-facing projection of an option — exactly what the picker renders,
 * nothing more.
 *
 * Deliberately drops `keyPrefixMap` / `finalNormKey` (loader mechanics that
 * would only invite a client-side reimplementation of the remap), `revision`,
 * and `file`: the client never addresses the weight by path — it passes the
 * option's `id` and the server resolves the rest. `repo` stays because the
 * download badge names it in its tooltip.
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
