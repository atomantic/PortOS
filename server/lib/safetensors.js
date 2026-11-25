/**
 * Minimal safetensors header reader + FLUX.2 size-variant detector.
 *
 * Used by the LoRA service to tell a Klein-4B LoRA (transformer hidden dim 3072) from Klein-9B (4096) so the picker hides weights diffusers would reject with a tensor-shape mismatch (which `scripts/ml/lora_utils.py` swallows into a silent base render). Civitai's `baseModel` also distinguishes them, but self-trained/hand-dropped LoRAs have no sidecar; the file header is the only ground truth. Layout: bytes[0..8) = little-endian u64 header length N, then bytes[8..8+N) = UTF-8 JSON (tensor name → { dtype, shape, data_offsets }, plus optional `__metadata__`). Only that header is read, never the tensor payload.
 */

import { open } from 'fs/promises';

// Sanity bound: a real header is a few KB to low-MB; anything past this is a corrupt length we refuse to allocate for.
const MAX_HEADER_BYTES = 100 * 1024 * 1024; // 100 MB

/** Read and parse a safetensors JSON header (tensor-name → descriptor); `null` if the file is missing, truncated, or not safetensors. Never throws. */
export const readSafetensorsHeader = async (path) => {
  let handle = null;
  try {
    handle = await open(path, 'r');
    const lenBuf = Buffer.alloc(8);
    const { bytesRead } = await handle.read(lenBuf, 0, 8, 0);
    if (bytesRead < 8) return null;
    // readBigUInt64LE → Number is safe for any realistic length; MAX_HEADER_BYTES rejects absurd ones.
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > MAX_HEADER_BYTES) return null;
    const jsonBuf = Buffer.alloc(headerLen);
    const { bytesRead: jsonRead } = await handle.read(jsonBuf, 0, headerLen, 8);
    if (jsonRead < headerLen) return null;
    const parsed = JSON.parse(jsonBuf.toString('utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Missing file, partial write, non-safetensors blob or malformed JSON all mean "can't determine".
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
};

// FLUX.2 denoiser hidden dims (Klein-4B = 3072, Klein-9B = 4096). LoRA tensors project off those dims, so they appear directly (e.g. img_in) and ×4 in fused MLP/attention-out linears (12288 / 16384).
const DIMS_9B = new Set([4096, 16384]);
const DIMS_4B = new Set([3072, 12288]);

/**
 * Classify a parsed safetensors header as a FLUX.2 Klein `'4b'` / `'9b'` LoRA, or `null` when undeterminable. Only transformer-block tensors count: T5-XXL's own hidden dim is 4096,
 * so a 4B LoRA that also trains the text encoder would be mis-flagged as 9B.
 */
export const detectFlux2VariantFromHeader = (header) => {
  if (!header || typeof header !== 'object') return null;
  let saw9b = false;
  let saw4b = false;
  for (const [name, desc] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    // FLUX denoiser blocks are `*single_transformer_blocks*` / `*transformer_blocks*` (diffusers); skip VAE, text encoders, misc.
    if (!/transformer_blocks/.test(name)) continue;
    const shape = desc?.shape;
    if (!Array.isArray(shape)) continue;
    for (const dim of shape) {
      if (DIMS_9B.has(dim)) saw9b = true;
      else if (DIMS_4B.has(dim)) saw4b = true;
    }
  }
  // A well-formed LoRA is one variant, never both; a malformed file showing both is not guessed.
  if (saw9b && !saw4b) return '9b';
  if (saw4b && !saw9b) return '4b';
  return null;
};

/**
 * LoRA safetensors key layouts. Downloaded LoRAs ship in mutually incompatible key conventions and a runtime that fuses one layout silently no-ops (or renders noise) on another;
 * the tensor names determine it, so it is classified once at install time instead of failing opaquely in a Python render.
 *
 * - `bare`: module paths with no wrapper prefix (`transformer_blocks.0.attn1.to_k.lora_A.weight`).
 * - `comfyui`: the same under a `diffusion_model.` prefix (ComfyUI-targeted LTX-2 / WAN LoRAs); the LTX-2 MLX loader strips it, so it is fusable.
 * - `diffusers`: PEFT/diffusers prefixes (`transformer.`, `base_model.model.`, `unet.`, `text_encoder…`); fusable for diffusers image runners, NOT the LTX-2 video loader.
 * - `kohya`: kohya_ss / LyCORIS `lora_down.weight` + `lora_up.weight` pairs (usually `lora_unet_…` flattened names, per-module `alpha`); never fusable by a `lora_A`/`lora_B` reader.
 * - `not_a_lora`: header parsed but holds no LoRA tensors (a checkpoint, VAE, embedding).
 *
 * `null` (not a member of this map) is the "couldn't determine" sentinel for an unreadable/non-safetensors file; callers must NOT treat it as `not_a_lora`.
 */
export const LORA_KEY_LAYOUTS = Object.freeze({
  BARE: 'bare',
  COMFYUI: 'comfyui',
  DIFFUSERS: 'diffusers',
  KOHYA: 'kohya',
  NOT_A_LORA: 'not_a_lora',
});

export const LORA_KEY_LAYOUT_VALUES = Object.freeze(Object.values(LORA_KEY_LAYOUTS));

/** Is `layout` a layout this module knows? Layouts read back from persisted state (a LoRA sidecar) must be validated, or an unrecognized string falls through `videoLoraLayoutIssue` as "no LoRA tensors". */
export const isKnownLoraKeyLayout = (layout) => LORA_KEY_LAYOUT_VALUES.includes(layout);

// `lora_A` / `lora_B` (diffusers/PEFT rank pair) in a dotted key. Case-insensitive: some trainers (upstream's LTX trainer on export) emit `lora_a`/`lora_b`, which would otherwise misreport a usable LoRA as `not_a_lora`.
const LORA_AB_RE = /(^|\.)lora_(A|B)(\.|$)/i;
// kohya/LyCORIS rank pair, also under `diffusion_model.` (real LTX-2 LoRAs ship `diffusion_model.<path>.lora_down.weight`: ComfyUI-shaped but NOT fusable by an lora_A/lora_B reader).
const LORA_DOWN_UP_RE = /(^|\.)lora_(down|up)(\.|$)/i;
// kohya's underscore-flattened module namespace (`lora_unet_…`, `lora_te1_…`).
const KOHYA_PREFIX_RE = /^lora_(unet|te\d*)_/i;
// diffusers / PEFT wrapper prefixes.
const DIFFUSERS_PREFIX_RE = /^(transformer|base_model|unet|text_encoder\w*)\./;

/**
 * Classify the LoRA key layout of a parsed header: a `LORA_KEY_LAYOUTS` value, or `null` when missing/unparsable. Mixed files exist (a kohya LoRA also shipping a `diffusion_model.`-prefixed copy),
 * so each tensor votes and the most common layout wins; ties go to the least-fusable layout (refusing with a clear reason beats emitting noise).
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
    // Everything below needs an actual rank tensor; bare `alpha` scalars and non-LoRA tensors carry no layout signal.
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

/** Read a file and classify its LoRA key layout in one call: a `LORA_KEY_LAYOUTS` value, or `null` when unreadable. */
export const classifyLoraKeyLayout = async (path) =>
  classifyLoraKeyLayoutFromHeader(await readSafetensorsHeader(path));

// Layouts the LTX-2 MLX loader can fuse: it pairs `<module>.lora_A.weight` with `.lora_B.weight` after stripping a leading `diffusion_model.`, so only bare and ComfyUI-prefixed files work.
const VIDEO_FUSABLE_LAYOUTS = new Set([LORA_KEY_LAYOUTS.BARE, LORA_KEY_LAYOUTS.COMFYUI]);

/** Why a layout can't be fused into the LTX-2 video transformer, as a user-facing phrase, or `null` when fusable. A `null` layout (couldn't classify) is permissive: an unreadable header isn't evidence of an unusable file. */
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
