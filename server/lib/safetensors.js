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
