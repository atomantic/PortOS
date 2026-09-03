/**
 * Video Gen disclosure facts — provenance/licensing metadata for the shipped
 * video models, plus the execution/policy scope of each render backend.
 *
 * Two related concerns, one module, because both answer the same user
 * question: "what actually happens, and under whose terms, when I hit
 * Generate?" (issue #3674).
 *
 * Rules this module exists to enforce:
 *   - Every value is a FACT from a primary upstream source (the HuggingFace
 *     model card's declared license metadata, the runtime project's LICENSE,
 *     the pinned revision's file listing). Nothing is inferred from a display
 *     name or a repository slug.
 *   - A fact we could not establish is OMITTED, never guessed. The UI renders
 *     "Unknown" for an absent key — that's the intended, honest outcome
 *     (custom/user-added models have no disclosure at all).
 *   - Backend disclosures describe execution and policy scope only. They are
 *     NOT a ranking: no "uncensored"/"safe"/"unrestricted" labels, and the
 *     absence of a PortOS prompt filter is never a promise about output.
 *
 * Canonical fields (`repo`, `revision`, `runtime`, `memoryGb`,
 * `supportedModes`, `requiredWeights`) stay on the registry entry itself and
 * are deliberately NOT duplicated here.
 */

import { ServerError } from './errorHandler.js';

// Every shipped disclosure was checked against its upstream source on this
// date. Bump it (and re-check) whenever an entry below changes.
export const VIDEO_DISCLOSURE_REVIEWED_AT = '2026-09-02';

// License descriptors reused across entries. `url` points at the primary text
// of the license, or at the model card when the card declares a custom license
// without publishing a distinct document.
// Exported for lib/videoTextEncoders.js, whose substitutable conditioners carry
// the same `disclosure` shape — a license-text correction here has to reach
// both tables, which a second inline literal would prevent.
export const APACHE_2 = { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' };
// Every Gemma derivative stays under Google's Gemma Terms of Use, which travel
// with the weights — a repacker's card that declares Apache-2.0 is relicensing
// something it cannot, so the ltx25 conditioners in lib/videoTextEncoders.js
// disclose THIS rather than whatever their card happens to say.
export const GEMMA_TERMS = { name: 'Gemma Terms of Use', url: 'https://ai.google.dev/gemma/terms' };
// Compatibility-only disclosure facts retained for migration 237. The model
// and runtime are no longer shipped, but deleting these would break upgrades
// whose pending migration still imports the historical disclosure table.
const TENCENT_HUNYUAN_WEIGHTS = {
  name: 'Tencent Hunyuan Community License',
  url: 'https://huggingface.co/tencent/HunyuanVideo/blob/main/LICENSE',
};
const MINIMAX_H3_LICENSE_URL = 'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/6818f6c32d12b210915e44ad56a4228c2608f160/LICENSE';
const MINIMAX_H3_WEIGHTS = {
  name: 'MiniMax H3 Community License',
  url: MINIMAX_H3_LICENSE_URL,
};

// Runtime (inference code) licenses, keyed by the registry's `runtime` value.
// Distinct from the weights license — a permissively-licensed runtime does not
// relicense the weights it loads, and vice versa.
const RUNTIME_LICENSE = {
  // PyPI `mlx-video-with-audio` (the package scripts/setup-image-video.sh
  // installs — NOT the unrelated PyPI `mlx_video`).
  mlx_video: { name: 'MIT', url: 'https://pypi.org/project/mlx-video-with-audio/' },
  ltx2: { name: 'MIT', url: 'https://github.com/dgrauet/ltx-2-mlx/blob/main/LICENSE' },
  ltx25: { name: 'MIT', url: 'https://github.com/MrMoferFRAN/ltx-2-mlx/blob/57952288076766abe27dda3a774b2c24f7346977/LICENSE' },
  ltx25_cuda: { name: 'Apache-2.0', url: 'https://github.com/Lightricks/LTX-2/blob/v1.2.0/LICENSE' },
  wan22_cuda: { name: 'Apache-2.0', url: 'https://github.com/huggingface/diffusers/blob/main/LICENSE' },
  wan22: { name: 'MIT', url: 'https://github.com/lpalbou/mlx-gen/blob/main/LICENSE' },
  minimax_h3: {
    name: 'Apache-2.0',
    url: 'https://github.com/PipeNetwork/minimax-h3-mlx/blob/fcd9e9b79a1d6018d91ac477c0968de1fa067e49/LICENSE',
  },
  minimax_h3_ref2va: {
    name: 'Apache-2.0',
    url: 'https://github.com/sawfwair/mere-run/blob/v0.47.0/LICENSE',
  },
  // The diffusers CUDA path executes no vendored source — the license that
  // governs the inference code is diffusers' own.
  cuda_video: { name: 'Apache-2.0', url: 'https://github.com/huggingface/diffusers/blob/main/LICENSE' },
  minimax_h3_cuda: { name: 'Apache-2.0', url: 'https://github.com/huggingface/diffusers/blob/main/LICENSE' },
  // Historical runtime license consumed only by the retired model disclosure.
  hunyuan: {
    name: 'Tencent Hunyuan Community License',
    url: 'https://github.com/gaurav-nelson/HunyuanVideo_MLX/blob/main/LICENSE.txt',
  },
  fastvideo: {
    name: 'Apache-2.0',
    url: 'https://github.com/hao-ai-lab/FastVideo/blob/main/LICENSE',
  },
};

// Informational territory facts for ModelDisclosure — not an execution gate.
// The license is use-as-acceptance; PortOS surfaces the exclusions and the
// license link rather than blocking download or generate.
//
// Shared verbatim by every MiniMax H3 entry — the MLX port and the CUDA path
// load the same weights under the same license. Sharing the OBJECT (rather
// than repeating its fields) keeps the `id` identical if an older client
// still writes `acceptedModelTerms`.
const MINIMAX_H3_TERMS_GATE = Object.freeze({
  id: 'minimax-h3-community-license-2026-08-02',
  title: 'MiniMax H3 eligibility and terms',
  summary: 'MiniMax grants use only in its Applicable Territory. The license excludes the European Union, United Kingdom, Republic of Korea, and United States of America.',
  acknowledgement: 'I confirm I am in the Applicable Territory and agree to the MiniMax H3 Community License and its Acceptable Use Policy.',
  licenseUrl: MINIMAX_H3_LICENSE_URL,
  excludedTerritories: Object.freeze([
    'European Union',
    'United Kingdom',
    'Republic of Korea',
    'United States of America',
  ]),
});

const LTX_2X_WEIGHTS = {
  name: 'LTX-2.x Community License',
  url: 'https://github.com/Lightricks/LTX-2/blob/main/LICENSE.md',
};

const hfModelCard = (repo) => `https://huggingface.co/${repo}`;

// A model card that declares `license: other` with no `license_name` /
// `license_link` — the only honest rendering is "custom, read the card".
const customLicense = (repo) => ({ name: 'Custom — see model card', url: hfModelCard(repo) });

/**
 * Shipped disclosure metadata, keyed by registry entry id.
 *
 * `shippedRepo` is the fork-preservation guard (same contract as
 * `backfillKvRepo` in mediaModels.js): the disclosure is only attached when the
 * entry still points at the repo these facts were checked against. A user who
 * re-pointed `repo` at a fork keeps "Unknown" rather than inheriting upstream's
 * license and size claims.
 *
 * `estimatedDownloadGb` is what PortOS's own download path actually pulls, in
 * decimal GB (10^9 bytes), summed from the HuggingFace file listing at the
 * entry's pinned revision (or `main` when unpinned) — which can exceed the
 * resident-memory figure in a model's display name. That is the whole repo
 * snapshot for most entries, but only the enumerated files for an entry that
 * narrows its repo with `repoFiles` (or adds one with `requiredWeights`), so
 * quote the file set the entry actually declares rather than the repo total.
 * Lightning entries include their `requiredWeights` LoRA files.
 */
export const VIDEO_MODEL_DISCLOSURES = Object.freeze({
  minimax_h3_ref2va_8bit: {
    shippedRepo: 'Sawfwair/MiniMax-H3-Ref2VA-MLX-8bit',
    disclosure: {
      modelCardUrl: hfModelCard('Sawfwair/MiniMax-H3-Ref2VA-MLX-8bit'),
      weightsLicense: MINIMAX_H3_WEIGHTS,
      runtimeLicense: RUNTIME_LICENSE.minimax_h3_ref2va,
      estimatedDownloadGb: 70.9,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
    termsGate: MINIMAX_H3_TERMS_GATE,
  },
  minimax_h3_8bit: {
    shippedRepo: 'pipenetwork/MiniMax-H3-MLX-8bit',
    disclosure: {
      modelCardUrl: hfModelCard('pipenetwork/MiniMax-H3-MLX-8bit'),
      weightsLicense: MINIMAX_H3_WEIGHTS,
      runtimeLicense: RUNTIME_LICENSE.minimax_h3,
      // 35.302 GB quantized transformer + 67.996 GB selective upstream
      // conditioner / video VAE / audio VAE files, plus the ~0.011 GB
      // Qwen3-VL processor the keyframe (image / FFLF) path reads.
      estimatedDownloadGb: 103.3,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
    termsGate: MINIMAX_H3_TERMS_GATE,
  },
  minimax_h3_cuda: {
    shippedRepo: 'MiniMaxAI/MiniMax-H3',
    disclosure: {
      modelCardUrl: hfModelCard('MiniMaxAI/MiniMax-H3'),
      weightsLicense: MINIMAX_H3_WEIGHTS,
      runtimeLicense: RUNTIME_LICENSE.minimax_h3_cuda,
      // The bf16 diffusers components the fl2va workflow loads: 66.28 GB
      // transformer + 66.73 GB Qwen3-VL conditioner + 10.42 GB video VAE +
      // 0.61 GB audio VAE, plus ~0.02 GB of tokenizer / processor / scheduler
      // configs. NOT the repo total — `MiniMaxAI/MiniMax-H3` is 498 GB because
      // it also ships the `Ref2VA` partition and the original non-diffusers
      // `FL2VA/` layout, which is why this entry pulls an explicit file list.
      estimatedDownloadGb: 144.1,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
    termsGate: MINIMAX_H3_TERMS_GATE,
  },
  ltx23_unified: {
    shippedRepo: 'notapalindrome/ltx23-mlx-av',
    disclosure: {
      modelCardUrl: hfModelCard('notapalindrome/ltx23-mlx-av'),
      // Model card declares no license — omitted, renders as Unknown.
      runtimeLicense: RUNTIME_LICENSE.mlx_video,
      estimatedDownloadGb: 53.5,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  ltx23_distilled_q4: {
    shippedRepo: 'notapalindrome/ltx23-mlx-av-q4',
    disclosure: {
      modelCardUrl: hfModelCard('notapalindrome/ltx23-mlx-av-q4'),
      // Model card declares no license — omitted, renders as Unknown.
      runtimeLicense: RUNTIME_LICENSE.mlx_video,
      estimatedDownloadGb: 22.8,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  ltx23_dgrauet_q4: {
    shippedRepo: 'dgrauet/ltx-2.3-mlx-q4',
    disclosure: {
      modelCardUrl: hfModelCard('dgrauet/ltx-2.3-mlx-q4'),
      weightsLicense: customLicense('dgrauet/ltx-2.3-mlx-q4'),
      runtimeLicense: RUNTIME_LICENSE.ltx2,
      estimatedDownloadGb: 59.7,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  ltx23_dgrauet_q8: {
    shippedRepo: 'dgrauet/ltx-2.3-mlx-q8',
    disclosure: {
      modelCardUrl: hfModelCard('dgrauet/ltx-2.3-mlx-q8'),
      weightsLicense: customLicense('dgrauet/ltx-2.3-mlx-q8'),
      runtimeLicense: RUNTIME_LICENSE.ltx2,
      estimatedDownloadGb: 87.5,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  ltx25_mlx_q8: {
    shippedRepo: 'MrMofer/ltx-2.5-mlx-q8',
    disclosure: {
      modelCardUrl: hfModelCard('MrMofer/ltx-2.5-mlx-q8'),
      weightsLicense: LTX_2X_WEIGHTS,
      runtimeLicense: RUNTIME_LICENSE.ltx25,
      // Hugging Face usedStorage for the pinned snapshot (decimal GB).
      estimatedDownloadGb: 67.7,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  ltx25_cuda_distilled: {
    shippedRepo: 'Lightricks/LTX-2.5',
    disclosure: {
      modelCardUrl: hfModelCard('Lightricks/LTX-2.5'),
      weightsLicense: LTX_2X_WEIGHTS,
      runtimeLicense: RUNTIME_LICENSE.ltx25_cuda,
      estimatedDownloadGb: 71.1,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  wan22_cuda_ti2v_5b: {
    shippedRepo: 'Wan-AI/Wan2.2-TI2V-5B-Diffusers',
    disclosure: {
      modelCardUrl: hfModelCard('Wan-AI/Wan2.2-TI2V-5B-Diffusers'),
      weightsLicense: APACHE_2,
      runtimeLicense: RUNTIME_LICENSE.wan22_cuda,
      estimatedDownloadGb: 34.2,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  wan22_ti2v_5b: {
    shippedRepo: 'AbstractFramework/wan2.2-ti2v-5b-diffusers-8bit',
    disclosure: {
      modelCardUrl: hfModelCard('AbstractFramework/wan2.2-ti2v-5b-diffusers-8bit'),
      weightsLicense: APACHE_2,
      runtimeLicense: RUNTIME_LICENSE.wan22,
      estimatedDownloadGb: 18.2,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  wan22_t2v_a14b: {
    shippedRepo: 'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit',
    disclosure: {
      modelCardUrl: hfModelCard('AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit'),
      weightsLicense: APACHE_2,
      runtimeLicense: RUNTIME_LICENSE.wan22,
      estimatedDownloadGb: 42.4,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  wan22_i2v_a14b: {
    shippedRepo: 'AbstractFramework/wan2.2-i2v-a14b-diffusers-8bit',
    disclosure: {
      modelCardUrl: hfModelCard('AbstractFramework/wan2.2-i2v-a14b-diffusers-8bit'),
      weightsLicense: APACHE_2,
      runtimeLicense: RUNTIME_LICENSE.wan22,
      estimatedDownloadGb: 42.4,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  wan22_t2v_a14b_lightning: {
    shippedRepo: 'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit',
    disclosure: {
      modelCardUrl: hfModelCard('AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit'),
      weightsLicense: APACHE_2,
      runtimeLicense: RUNTIME_LICENSE.wan22,
      // Base snapshot (42.4) + the two lightx2v/Wan2.2-Lightning LoRA files.
      estimatedDownloadGb: 44.9,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  wan22_i2v_a14b_lightning: {
    shippedRepo: 'AbstractFramework/wan2.2-i2v-a14b-diffusers-8bit',
    disclosure: {
      modelCardUrl: hfModelCard('AbstractFramework/wan2.2-i2v-a14b-diffusers-8bit'),
      weightsLicense: APACHE_2,
      runtimeLicense: RUNTIME_LICENSE.wan22,
      // Base snapshot (42.4) + the two lightx2v/Wan2.2-Lightning LoRA files.
      estimatedDownloadGb: 44.9,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  // Historical entry retained for migration 237; not present in the catalog.
  hunyuan_video: {
    shippedRepo: 'tencent/HunyuanVideo',
    disclosure: {
      modelCardUrl: hfModelCard('tencent/HunyuanVideo'),
      weightsLicense: TENCENT_HUNYUAN_WEIGHTS,
      runtimeLicense: RUNTIME_LICENSE.hunyuan,
      estimatedDownloadGb: 39.8,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  // The FastMetal repos bundle their own text encoder and VAE beside the MLX
  // DiT, so the download is several times the DiT-only size. The 1.3B and 5B
  // rows declare no `repoFiles` and pull the whole snapshot; the 14B row does
  // (#5871), dropping the duplicated `ema/` DiT, so its figure is the narrowed
  // pull rather than the 42.3 GB the full snapshot would cost.
  fastmetal_1_3b_qad: {
    shippedRepo: 'FastVideo/FastMetal-1.3B-QAD',
    disclosure: {
      modelCardUrl: hfModelCard('FastVideo/FastMetal-1.3B-QAD'),
      weightsLicense: APACHE_2,
      runtimeLicense: RUNTIME_LICENSE.fastvideo,
      estimatedDownloadGb: 13.4,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  fastmetal_5b_qad: {
    shippedRepo: 'FastVideo/FastMetal-5B-QAD',
    disclosure: {
      modelCardUrl: hfModelCard('FastVideo/FastMetal-5B-QAD'),
      weightsLicense: APACHE_2,
      runtimeLicense: RUNTIME_LICENSE.fastvideo,
      estimatedDownloadGb: 19.5,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  fastmetal_14b_qad: {
    shippedRepo: 'FastVideo/FastMetal-14B-QAD',
    disclosure: {
      modelCardUrl: hfModelCard('FastVideo/FastMetal-14B-QAD'),
      weightsLicense: APACHE_2,
      runtimeLicense: RUNTIME_LICENSE.fastvideo,
      estimatedDownloadGb: 27.1,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
  // FastVideo's own FastH3 Dense / Data-Free snapshot — the checkpoint the
  // repack below is converted FROM, so same weights, same license, same
  // territory gate. The three rows share one 144 GB download: the format in the
  // id names a LOCAL conversion of the snapshot's transformer/, not a separate
  // repo, which is why they all quote the same figure.
  ...Object.fromEntries(['int8', 'int6', 'int4'].map((format) => [`fasth3_dense_datafree_${format}`, {
    shippedRepo: 'FastVideo/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree',
    disclosure: {
      modelCardUrl: hfModelCard('FastVideo/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree'),
      weightsLicense: MINIMAX_H3_WEIGHTS,
      runtimeLicense: RUNTIME_LICENSE.fastvideo,
      estimatedDownloadGb: 144.0,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
    termsGate: MINIMAX_H3_TERMS_GATE,
  }])),
  // FastH3 Preview v1 Dense / Data-Free, packed for MLX. Same MiniMax H3
  // weights lineage as the entries above — its `conversion_manifest.json`
  // names FastVideo/…-Dense-DataFree @ f624f08c as the source — so it carries
  // the same license and the same territory gate. The repo is self-contained:
  // the quantized DiT ships beside the vae / audio_vae / text_encoder /
  // tokenizer the MLX pipeline loads, which is why the whole snapshot is the
  // download figure.
  fasth3_dense_datafree_mlx_int4: {
    shippedRepo: 'MrMofer/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree-MLX-INT4',
    disclosure: {
      modelCardUrl: hfModelCard('MrMofer/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree-MLX-INT4'),
      weightsLicense: MINIMAX_H3_WEIGHTS,
      runtimeLicense: RUNTIME_LICENSE.fastvideo,
      estimatedDownloadGb: 89.3,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
    termsGate: MINIMAX_H3_TERMS_GATE,
  },
  // Legacy CUDA entry. It carries no `repo` because its diffusers helper
  // resolves LTX-Video 0.9.5 directly, so its weights license stays Unknown.
  ltx_video: {
    shippedRepo: null,
    disclosure: {
      runtimeLicense: RUNTIME_LICENSE.cuda_video,
      reviewedAt: VIDEO_DISCLOSURE_REVIEWED_AT,
    },
  },
});

// Deep-freeze the nested disclosure objects so a consumer can't mutate the
// shared descriptors (`APACHE_2`, `RUNTIME_LICENSE.*`, …) through one entry and corrupt every
// other entry that reuses them.
for (const spec of Object.values(VIDEO_MODEL_DISCLOSURES)) {
  for (const value of Object.values(spec.disclosure)) {
    if (value && typeof value === 'object') Object.freeze(value);
  }
  Object.freeze(spec.disclosure);
  if (spec.termsGate) {
    Object.freeze(spec.termsGate.excludedTerritories);
    Object.freeze(spec.termsGate);
  }
  Object.freeze(spec);
}

/**
 * Attach shipped disclosure metadata to a video model list.
 *
 * Preservation contract (mirrors migration 237):
 *   - `'disclosure' in entry`     → user/existing value wins, untouched.
 *   - entry id not shipped        → custom model, left as-is (Unknown in UI).
 *   - `repo` differs from shipped → forked weights, left as-is.
 *
 * Returns a new array; never mutates the input entries.
 */
export const applyVideoDisclosures = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return entry;
    const spec = VIDEO_MODEL_DISCLOSURES[entry.id];
    if (!spec) return entry;
    if (spec.shippedRepo !== null && entry.repo !== spec.shippedRepo) return entry;
    return {
      ...entry,
      ...(!('disclosure' in entry) ? { disclosure: spec.disclosure } : {}),
      // A shipped restricted model cannot silently lose its required gate
      // through an old/user-edited registry entry. Forked repos are excluded by
      // the guard above because PortOS has not established their terms.
      ...(spec.termsGate ? { termsGate: spec.termsGate } : {}),
    };
  });
};

// The exact reviewed-license id a model requires, or null when it is ungated.
export const videoModelTermsGateId = (model) => {
  const required = model?.termsGate?.id;
  return typeof required === 'string' && required.length > 0 ? required : null;
};

/**
 * The install's persisted acknowledgements (`settings.videoGen.acceptedModelTerms`).
 *
 * Acceptance is an install-wide fact about the operator, not a property of one
 * request or one browser: the same person drives the Video Gen page, the music
 * video director board, and every scheduled/agent render. Persisting it here is
 * what lets a single acknowledgement authorize all of them — see the
 * `POST /api/video-gen/model-terms` route.
 *
 * Returns a de-duplicated array of non-empty strings; anything else on disk is
 * ignored rather than trusted.
 */
export const acceptedVideoModelTerms = (settings) => {
  const stored = settings?.videoGen?.acceptedModelTerms;
  if (!Array.isArray(stored)) return [];
  return [...new Set(stored.filter((id) => typeof id === 'string' && id.length > 0))];
};

// Exact-id comparison keeps acceptance scoped to one reviewed license version:
// acknowledging one license must never authorize a later revision of it, or an
// unrelated restricted model. The install's recorded acknowledgements
// (`acceptedVideoModelTerms`) are the ONLY authorization — there is no
// per-request "I accept" a caller can assert, so every authorized render traces
// back to a recorded acknowledgement and withdrawing one takes effect
// everywhere, including work already sitting in the queue.
export const isVideoModelTermsAccepted = (model, acceptedKeys) => {
  const required = videoModelTermsGateId(model);
  if (required === null) return true;
  return Array.isArray(acceptedKeys) && acceptedKeys.includes(required);
};

/**
 * The rejection every gated code path throws, so the wording (and the way out
 * of it) can't drift between the download route, request preparation, and the
 * render itself.
 *
 * A render can be started from surfaces that have no acknowledgement UI of
 * their own — and from producers with no UI at all, whose only channel to the
 * user is this message on a failed job. So the message must name where the
 * acknowledgement lives, not just state that one is missing.
 */
export const videoModelTermsError = (model, action = 'generation') => new ServerError(
  `${model?.name || 'This model'} requires acknowledgement of its territory restrictions, `
  + `Community License, and Acceptable Use Policy before ${action}. `
  + 'Accept it on the Video Gen page (Media → Video) — one acknowledgement authorizes every render on this install.',
  { status: 403, code: 'VIDEO_MODEL_TERMS_ACCEPTANCE_REQUIRED' },
);

/**
 * Execution + policy scope for each Video Gen render backend. Server-owned so
 * the client never has to author (or drift on) the wording.
 *
 * `execution` is the machine-readable discriminator ('local' | 'hosted');
 * `facts` are the sentences the UI renders verbatim.
 */
export const VIDEO_BACKEND_DISCLOSURES = Object.freeze([
  Object.freeze({
    id: 'local',
    label: 'Local',
    execution: 'local',
    summary: 'Inference runs on this PortOS machine.',
    facts: Object.freeze([
      'This render path does not send your prompt or source media to a hosted inference provider.',
      'PortOS applies no model-level prompt filter on this path. That is a statement about PortOS, not a guarantee about what a model will produce.',
      'The model weights license and the runtime license still apply, as do any other terms you are bound by.',
    ]),
    links: Object.freeze([]),
  }),
  Object.freeze({
    id: 'grok',
    label: 'Grok',
    execution: 'hosted',
    provider: 'xAI',
    summary: 'Inference is submitted to xAI and leaves this machine.',
    facts: Object.freeze([
      'Your prompt and any source image are sent to xAI to render the clip.',
      "xAI's terms, retention behavior, and enforcement apply independently of PortOS.",
      'Renders count against your Grok plan.',
    ]),
    links: Object.freeze([
      Object.freeze({ label: 'xAI legal terms', url: 'https://x.ai/legal' }),
      Object.freeze({ label: 'xAI API documentation', url: 'https://docs.x.ai/docs' }),
    ]),
  }),
]);

export const videoBackendDisclosure = (backendId) =>
  VIDEO_BACKEND_DISCLOSURES.find((b) => b.id === backendId) || null;
