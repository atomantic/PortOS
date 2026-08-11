/**
 * Minimal safetensors header reader + FLUX.2 size-variant detector.
 *
 * Used by the LoRA service to tell a Klein-4B LoRA (transformer hidden dim
 * 3072) apart from a Klein-9B LoRA (hidden dim 4096) so the picker can hide
 * weights that diffusers would reject at load time with a tensor-shape
 * mismatch (which `scripts/lora_utils.py` swallows, producing a silent
 * base render). The Civitai `baseModel` string distinguishes the two too,
 * but self-trained / hand-dropped LoRAs have no sidecar — the file header is
 * the only ground truth there.
 *
 * Safetensors layout: bytes[0..8) = little-endian u64 header length N, then
 * bytes[8..8+N) = a UTF-8 JSON object mapping tensor name → { dtype, shape,
 * data_offsets } (plus an optional `__metadata__` key). We read ONLY that
 * header — never the multi-hundred-MB tensor payload that follows.
 */

import { open } from 'fs/promises';

// Sanity bound: a real safetensors header is a few KB to low-MB. Anything
// past this is a corrupt/garbage length we refuse to allocate for.
const MAX_HEADER_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Read and parse the JSON header of a safetensors file. Returns the parsed
 * object (tensor-name → descriptor) or `null` if the file is missing,
 * truncated, or doesn't look like safetensors. Never throws.
 */
export const readSafetensorsHeader = async (path) => {
  let handle = null;
  try {
    handle = await open(path, 'r');
    const lenBuf = Buffer.alloc(8);
    const { bytesRead } = await handle.read(lenBuf, 0, 8, 0);
    if (bytesRead < 8) return null;
    // readBigUInt64LE → Number is safe for any realistic header length (well
    // under 2^53); the MAX_HEADER_BYTES guard rejects anything absurd.
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > MAX_HEADER_BYTES) return null;
    const jsonBuf = Buffer.alloc(headerLen);
    const { bytesRead: jsonRead } = await handle.read(jsonBuf, 0, headerLen, 8);
    if (jsonRead < headerLen) return null;
    const parsed = JSON.parse(jsonBuf.toString('utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Missing file, partial write, non-safetensors blob, malformed JSON —
    // all map to "can't determine" so callers fall back gracefully.
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
};

// FLUX.2 denoiser hidden dims. Klein-4B = 3072, Klein-9B = 4096. LoRA tensors
// project off those dims, so the values surface both directly (e.g. img_in)
// and ×4 in the fused MLP/attention-out linears (12288 / 16384) — match both.
const DIMS_9B = new Set([4096, 16384]);
const DIMS_4B = new Set([3072, 12288]);

/**
 * Inspect a parsed safetensors header and classify it as a FLUX.2 Klein
 * `'4b'` / `'9b'` LoRA, or `null` when it can't be determined.
 *
 * Only transformer-block tensors are considered. Text-encoder tensors are
 * skipped on purpose: T5-XXL's own hidden dim is 4096, so a 4B LoRA that also
 * trains the text encoder would otherwise be mis-flagged as 9B.
 */
export const detectFlux2VariantFromHeader = (header) => {
  if (!header || typeof header !== 'object') return null;
  let saw9b = false;
  let saw4b = false;
  for (const [name, desc] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    // FLUX denoiser blocks are named `*single_transformer_blocks*` /
    // `*transformer_blocks*` (diffusers) — the discriminating tensors. Skip
    // everything else (VAE, text encoders, misc).
    if (!/transformer_blocks/.test(name)) continue;
    const shape = desc?.shape;
    if (!Array.isArray(shape)) continue;
    for (const dim of shape) {
      if (DIMS_9B.has(dim)) saw9b = true;
      else if (DIMS_4B.has(dim)) saw4b = true;
    }
  }
  // A well-formed LoRA is one variant or the other, never both. If a malformed
  // file somehow shows both, refuse to guess.
  if (saw9b && !saw4b) return '9b';
  if (saw4b && !saw9b) return '4b';
  return null;
};

/**
 * Convenience: read a file and classify it in one call. Returns `'4b'` /
 * `'9b'` / `null`.
 */
export const detectFlux2Variant = async (path) =>
  detectFlux2VariantFromHeader(await readSafetensorsHeader(path));

/**
 * LoRA safetensors key layouts.
 *
 * Downloaded LoRAs ship in several mutually incompatible key conventions, and
 * a runtime that fuses one layout silently no-ops (or renders noise) on
 * another. The layout is fully determined by the tensor names in the header,
 * so we classify it once at install time instead of discovering it as an
 * opaque failure deep inside a Python render.
 *
 * - `bare`      — module paths with no wrapper prefix:
 *                 `transformer_blocks.0.attn1.to_k.lora_A.weight`
 * - `comfyui`   — the same paths under a `diffusion_model.` prefix (what
 *                 ComfyUI-targeted LTX-2 / WAN LoRAs ship as). The LTX-2 MLX
 *                 loader strips that prefix itself, so it is fusable.
 * - `diffusers` — PEFT/diffusers wrapper prefixes (`transformer.`,
 *                 `base_model.model.`, `unet.`, `text_encoder…`). Fusable for
 *                 diffusers-based image runners, NOT for the LTX-2 video
 *                 loader (whose keys carry no such prefix).
 * - `kohya`     — kohya_ss / LyCORIS training output: `lora_down.weight` +
 *                 `lora_up.weight` pairs (usually with `lora_unet_…`
 *                 underscore-flattened module names and per-module `alpha`
 *                 scalars). Never fusable by an `lora_A`/`lora_B` reader.
 * - `not_a_lora`— header parsed fine but holds no LoRA tensors at all (a full
 *                 checkpoint, a VAE, an embedding).
 *
 * `null` (rather than a member of this map) is the "couldn't determine"
 * sentinel — an unreadable/corrupt/non-safetensors file. Callers must NOT
 * treat it as `not_a_lora`.
 */
export const LORA_KEY_LAYOUTS = Object.freeze({
  BARE: 'bare',
  COMFYUI: 'comfyui',
  DIFFUSERS: 'diffusers',
  KOHYA: 'kohya',
  NOT_A_LORA: 'not_a_lora',
});

export const LORA_KEY_LAYOUT_VALUES = Object.freeze(Object.values(LORA_KEY_LAYOUTS));

/**
 * Is `layout` one of the layouts this module actually knows? Callers that read
 * a layout back out of persisted state (a LoRA sidecar) must validate before
 * trusting it — an unrecognized string would otherwise fall through
 * `videoLoraLayoutIssue`'s known cases and get reported as "no LoRA tensors".
 */
export const isKnownLoraKeyLayout = (layout) => LORA_KEY_LAYOUT_VALUES.includes(layout);

// `lora_A` / `lora_B` (diffusers/PEFT rank pair) anywhere in a dotted key.
// Case-insensitive: some trainers emit lowercase `lora_a`/`lora_b` (upstream's
// own LTX trainer normalizes exactly that spelling on export), and treating
// those as "no rank tensors" would misreport a usable LoRA as `not_a_lora`.
const LORA_AB_RE = /(^|\.)lora_(A|B)(\.|$)/i;
// kohya/LyCORIS rank pair. Also matched under a `diffusion_model.` prefix —
// real-world LTX-2 LoRAs ship `diffusion_model.<path>.lora_down.weight`, which
// looks ComfyUI-shaped but is NOT fusable by an lora_A/lora_B reader.
const LORA_DOWN_UP_RE = /(^|\.)lora_(down|up)(\.|$)/i;
// kohya's underscore-flattened module namespace (`lora_unet_…`, `lora_te1_…`).
const KOHYA_PREFIX_RE = /^lora_(unet|te\d*)_/i;
// diffusers / PEFT wrapper prefixes.
const DIFFUSERS_PREFIX_RE = /^(transformer|base_model|unet|text_encoder\w*)\./;

/**
 * Classify the LoRA key layout of a parsed safetensors header. Returns one of
 * `LORA_KEY_LAYOUTS`, or `null` when the header is missing/unparsable.
 *
 * Mixed files exist (a kohya LoRA that also ships a `diffusion_model.`-prefixed
 * copy of the same deltas), so each tensor votes and the winner is the most
 * common layout. Ties resolve toward the least-fusable layout — refusing a
 * render with a clear reason beats emitting noise.
 */
export const classifyLoraKeyLayoutFromHeader = (header) => {
  if (!header || typeof header !== 'object') return null;
  const counts = {
    [LORA_KEY_LAYOUTS.KOHYA]: 0,
    [LORA_KEY_LAYOUTS.DIFFUSERS]: 0,
    [LORA_KEY_LAYOUTS.COMFYUI]: 0,
    [LORA_KEY_LAYOUTS.BARE]: 0,
  };
  for (const name of Object.keys(header)) {
    if (name === '__metadata__') continue;
    if (KOHYA_PREFIX_RE.test(name) || LORA_DOWN_UP_RE.test(name)) {
      counts[LORA_KEY_LAYOUTS.KOHYA] += 1;
      continue;
    }
    // Everything below needs an actual rank tensor — bare `alpha` scalars and
    // non-LoRA tensors carry no layout signal of their own.
    if (!LORA_AB_RE.test(name)) continue;
    if (name.startsWith('diffusion_model.')) counts[LORA_KEY_LAYOUTS.COMFYUI] += 1;
    else if (DIFFUSERS_PREFIX_RE.test(name)) counts[LORA_KEY_LAYOUTS.DIFFUSERS] += 1;
    else counts[LORA_KEY_LAYOUTS.BARE] += 1;
  }
  // Object.keys order here is the tie-break order (least fusable first).
  let winner = null;
  let best = 0;
  for (const [layout, n] of Object.entries(counts)) {
    if (n > best) {
      best = n;
      winner = layout;
    }
  }
  return winner || LORA_KEY_LAYOUTS.NOT_A_LORA;
};

/**
 * Convenience: read a file and classify its LoRA key layout in one call.
 * Returns a `LORA_KEY_LAYOUTS` value, or `null` when the file can't be read.
 */
export const classifyLoraKeyLayout = async (path) =>
  classifyLoraKeyLayoutFromHeader(await readSafetensorsHeader(path));

// Layouts the LTX-2 MLX loader can actually fuse. Its fuser pairs
// `<module>.lora_A.weight` with `<module>.lora_B.weight` after stripping a
// leading `diffusion_model.` — so bare and ComfyUI-prefixed files work, and
// nothing else does.
const VIDEO_FUSABLE_LAYOUTS = new Set([LORA_KEY_LAYOUTS.BARE, LORA_KEY_LAYOUTS.COMFYUI]);

/**
 * Why a layout can't be fused into the LTX-2 video transformer, as a
 * user-facing phrase — or `null` when it is fusable. `null` layout (couldn't
 * classify) is deliberately permissive: an unreadable header is not evidence
 * of an unusable file, and the caller already checked the file exists.
 */
export const videoLoraLayoutIssue = (layout) => {
  if (layout == null || VIDEO_FUSABLE_LAYOUTS.has(layout)) return null;
  if (layout === LORA_KEY_LAYOUTS.KOHYA) {
    return 'it uses the kohya/LyCORIS key layout (lora_down/lora_up + alpha), which the LTX-2 loader cannot fuse — it only reads lora_A/lora_B pairs. Re-export it in the ComfyUI (diffusion_model.*) layout, or pick a LoRA published for ComfyUI';
  }
  if (layout === LORA_KEY_LAYOUTS.DIFFUSERS) {
    return 'it uses the diffusers/PEFT key layout, whose alpha/rank scale is not stored in the file — applying it to the video transformer would be guesswork. Use a LoRA published for ComfyUI (diffusion_model.*) instead';
  }
  return 'it contains no LoRA tensors at all — this looks like a checkpoint or embedding, not a LoRA';
};
