/**
 * llama-server launcher presets — a target on its own, or a target paired with
 * a speculative-decoding drafter.
 *
 * Server-owned because the paths are only half the story: each preset also
 * carries the Hugging Face repo the GGUF comes from, so PortOS can report
 * "downloaded / not downloaded" per file and fetch the missing ones itself.
 * The client renders this list — it holds no copy of its own, so a preset can
 * never name a path the downloader has no source for.
 *
 * `quant` is a HINT, not a filename: repos rename their builds
 * (`…-Q4_K_M.gguf`, `…-instruct-q4_k_m.gguf`, `….Q4_K_M.gguf`) and a hard-coded
 * filename rots the moment one of them re-uploads — so most entries carry only
 * the hint. `file` is the exception, and it is a PIN rather than a preference:
 * it appears only where the quant tag cannot discriminate the target, so a pin
 * that stops resolving is an error, not a cue to fall back to the hint.
 *
 * Not every preset is a PAIR. A preset whose `specType` drafts with nothing
 * (`none`, any `ngram-*`) carries an empty `draftModel` and is simply the
 * launch line for one checkpoint — which is what makes this list, not the
 * Ollama/LM Studio catalog, the right home for a model whose weights only
 * llama-server can load (Ternary Bonsai 2 below).
 *
 * A file with no published single-file GGUF (the DSpark 8B block ships as a
 * tokenizer-less checkpoint that has to be converted against its target) simply
 * carries no `repo` — the UI then links out to a Hugging Face search instead of
 * offering a Download button that cannot work. Pairs are the ones documented in
 * docs/features/dflash2.md; see also docs/research/2026-08-19-dspark-vs-dflash2.md.
 */

// llama.cpp exposes one `--spec-type` per drafter family. `draft-dspark` merged
// upstream on 2026-07-28 (ggml-org/llama.cpp#25173) and works on a stock
// `brew install llama.cpp`; `draft-dflash` covers DFlash v1, while the DFlash 2
// modules are still an open PR (#27342) and need a from-source build. Hence the
// DSpark presets lead.
export const SPEC_DECODE_PRESETS = Object.freeze([
  {
    id: 'qwen3.8-27b-dspark',
    label: 'Qwen 3.8 27B + DSpark Drafter (Recommended — stock llama.cpp)',
    specType: 'draft-dspark',
    model: {
      path: 'models/Qwen3.8-27B-Q4_K_M.gguf',
      repo: 'ggml-org/Qwen3.8-27B-GGUF',
      quant: 'Q4_K_M',
    },
    draftModel: {
      path: 'models/Qwen3.8-27B-DSpark-BF16.gguf',
      repo: 'erlidev/Qwen3.8-27B-DSpark-GGUF',
      quant: 'BF16',
    },
  },
  {
    id: 'qwen3-8b-dspark',
    label: 'Qwen 3 8B + DSpark Drafter (small target)',
    specType: 'draft-dspark',
    model: {
      path: 'models/Qwen3-8B-Q4_K_M.gguf',
      repo: 'Qwen/Qwen3-8B-GGUF',
      quant: 'Q4_K_M',
    },
    draftModel: {
      path: 'models/dspark_qwen3_8b_block7-bf16.gguf',
    },
  },
  {
    // analogalok's Q2_K DFlash 2 drafter (~700 MB) matches official Q4_K_M
    // acceptance (~93.7%) and returns ~450 MB of VRAM to the KV cache — the
    // difference between a 170k and a 250k window on a 24 GB card once
    // llama-server is also pinned to `--parallel 1`. Pairs with any Qwen3.8-27B
    // target quant, including Unsloth UD-Q4_K_XL.
    // https://huggingface.co/analogalok/Qwen3.8-27B-DFlash2-Q2_K-GGUF
    id: 'qwen3.8-27b-dflash2-q2k',
    label: 'Qwen 3.8 27B + DFlash 2 Q2_K Drafter (max context — needs llama.cpp PR #27342)',
    specType: 'draft-dflash',
    model: {
      path: 'models/Qwen3.8-27B-Q4_K_M.gguf',
      repo: 'ggml-org/Qwen3.8-27B-GGUF',
      quant: 'Q4_K_M',
    },
    draftModel: {
      path: 'models/Qwen3.8-27B-DFlash2-Q2_K.gguf',
      repo: 'analogalok/Qwen3.8-27B-DFlash2-Q2_K-GGUF',
      quant: 'Q2_K',
    },
  },
  {
    id: 'qwen3.8-27b',
    label: 'Qwen 3.8 27B + DFlash 2 Q4_K_M Drafter (needs llama.cpp PR #27342 build)',
    specType: 'draft-dflash',
    model: {
      path: 'models/Qwen3.8-27B-Q4_K_M.gguf',
      repo: 'ggml-org/Qwen3.8-27B-GGUF',
      quant: 'Q4_K_M',
    },
    draftModel: {
      path: 'models/Qwen3.8-27B-DFlash2-Q4_K_M.gguf',
      repo: 'incoai/Qwen3.8-27B-DFlash2-GGUF',
      quant: 'Q4_K_M',
    },
  },
  {
    id: 'muse-glimmer-30b',
    label: 'Muse-Glimmer 30B + DFlash 2 Drafter (needs llama.cpp PR #27342 build)',
    specType: 'draft-dflash',
    model: {
      path: 'models/Muse-Glimmer-30B-Q4_K_M.gguf',
      repo: 'meta-models/Muse-Glimmer-30B-GGUF',
      // Pinned: this repo publishes the target next to its own `dflash-` drafter
      // and `mmproj-` projector, all three carrying the Q4_K_M tag, so the quant
      // hint alone cannot pick the 17 GB target out of the 1.4 GB sidecars.
      file: 'Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf',
      quant: 'Q4_K_M',
    },
    draftModel: {
      path: 'models/Muse-Glimmer-30B-DFlash2-Q4_K_M.gguf',
      repo: 'z-lab/Muse-Glimmer-30B-DFlash2-GGUF',
      quant: 'Q4_K_M',
    },
  },
  {
    // PrismML's ternary pack of Qwen3.8-27B, and the first preset here that
    // speculates with nothing.
    //
    // PQ2_0 over the 1.3 GB smaller PTQ1_0: PQ2_0 is the pack PrismML measures
    // on Apple Silicon and the faster prompt-processing pack on every backend,
    // while PTQ1_0's decode edge is specific to Ada-generation and L4 cards.
    // Either one needs a build of PrismML's llama.cpp fork on PATH, which is
    // what the label warns about — and a launch that starts is NOT evidence the
    // right binary is there, because a stock build accepts a plain ternary Q2_0
    // and then emits garbage. Measurements, build recipe and why this model is
    // absent from the Ollama/LM Studio catalog:
    // docs/research/2026-09-18-ternary-bonsai-2-27b.md
    id: 'ternary-bonsai-2-27b',
    label: 'Ternary Bonsai 2 27B — no drafter (needs a PrismML llama.cpp build)',
    specType: 'none',
    model: {
      path: 'models/Ternary-Bonsai-2-27B-PQ2_0.gguf',
      repo: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
      quant: 'PQ2_0',
    },
    draftModel: { path: '' },
  },
  {
    id: 'custom',
    label: 'Custom GGUF / Manual Paths',
    specType: 'draft-dspark',
    model: { path: '' },
    draftModel: { path: '' },
  },
]);

/**
 * `--spec-type` implementations worth suggesting in the launcher, each with the
 * one-line note the picker shows. Surfaced on the llama-server status payload so
 * the client renders this list rather than keeping a copy that can rot.
 *
 * Deliberately a SUGGESTION list, not a vocabulary: `draft-dflash` /
 * `draft-dspark` exist only in particular builds (see the note above the
 * presets), and a from-source llama.cpp can carry implementations that never
 * land upstream. The field therefore stays free text — what PortOS actually
 * reasons about is the `draft-` prefix, which is what decides whether a drafter
 * GGUF is required. Reference: llama.cpp `docs/speculative.md`.
 */
export const SPEC_TYPE_SUGGESTIONS = Object.freeze([
  { id: 'none', note: 'Speculative decoding off' },
  { id: 'draft-dspark', note: 'DSpark drafter — needs a drafter GGUF' },
  { id: 'draft-dflash', note: 'DFlash drafter — needs a drafter GGUF' },
  { id: 'draft-simple', note: 'Any smaller model as drafter — needs a drafter GGUF' },
  { id: 'draft-mtp', note: 'Multi-token-prediction drafter — needs a drafter GGUF' },
  { id: 'ngram-map-k', note: 'Drafts from repeated n-grams already in context — no drafter' },
  { id: 'ngram-map-k4v', note: '4-token-key n-gram map — no drafter' },
  { id: 'ngram-simple', note: 'Longest-match n-gram lookup — no drafter' },
  { id: 'ngram-mod', note: 'Modulo-hashed n-gram lookup — no drafter' },
  { id: 'ngram-cache', note: 'Persistent n-gram cache — no drafter' },
]);

/**
 * Split a `--spec-type` field into its implementations. llama.cpp accepts a
 * comma-separated list and runs them together — mixing a drafter-based entry
 * with a drafter-free one (`draft-dflash,ngram-map-k`) is the documented way to
 * cover both patterns in one server.
 * @param {string|null|undefined} value
 * @returns {string[]}
 */
export const parseSpecTypes = (value) =>
  String(value ?? '').split(',').map((type) => type.trim()).filter(Boolean);

/**
 * Whether one implementation needs a `--model-draft` GGUF.
 *
 * The `draft-` prefix is llama.cpp's own naming split: `draft-*` speculates with
 * a second model, every `ngram-*` speculates by pattern-matching the tokens
 * already in the context window and needs no weights at all. Keyed on the prefix
 * rather than a fixed list so a fork's new drafter type is classified correctly
 * without a PortOS release.
 * @param {string} type
 */
export const isDraftSpecType = (type) => String(type).startsWith('draft-');

// The preset the launcher mounts on, and the roles a download request may name.
export const DEFAULT_SPEC_PRESET_ID = 'qwen3.8-27b-dspark';
export const SPEC_MODEL_ROLES = Object.freeze(['model', 'draftModel']);

export const findSpecDecodePreset = (id) =>
  SPEC_DECODE_PRESETS.find((preset) => preset.id === id) || null;

/**
 * The download source for one preset role, or null when the preset has no
 * published GGUF for it (`custom`, or a drafter that ships safetensors only).
 */
export const specDecodeSource = (presetId, role) => {
  const entry = findSpecDecodePreset(presetId)?.[role];
  return entry?.repo && entry?.path ? entry : null;
};

// Where to send a user whose preset has no automatic source. Searching by the
// filename (minus its extension) is what actually finds these — the drafter
// repos are named after the file, not the target model.
export const hfSearchUrl = (path) =>
  `https://huggingface.co/models?search=${encodeURIComponent(String(path).split('/').pop().replace(/\.gguf$/i, ''))}`;
