/**
 * Context-window memory planning for local models: KV-cache size from a model's layout, and the largest window that fits.
 *
 * Pure. The layout comes from Ollama's `/api/show` `model_info` (GGUF keys
 * `<arch>.block_count`, `.attention.head_count_kv`, `.attention.key_length`, …).
 * Only full-attention layers grow with the window: state-space layers (a zero
 * KV-head count, or off the `full_attention_interval`) hold none, and
 * sliding-window layers hold a fixed `sliding_window` tokens. A layout the keys
 * don't describe (an MLX safetensors build reports only its block count) is
 * `null`, and callers say "unknown" instead of guessing.
 */

/** Bytes per cached element for Ollama's `OLLAMA_KV_CACHE_TYPE` spellings (GGML block sizes). */
export const KV_CACHE_BYTES_PER_ELEMENT = Object.freeze({ f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 });

/** Windows offered as choices, smallest first. */
export const CONTEXT_WINDOW_STEPS = Object.freeze([8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576]);

/**
 * Share of unified memory a Mac GPU may wire by default (macOS caps Metal's
 * working set near three quarters of RAM); on other hosts the caller passes
 * VRAM or RAM it already knows.
 */
export const APPLE_GPU_MEMORY_SHARE = 0.75;

/** Room kept free beside one loaded model for compute buffers, the OS and PortOS. */
export const CONTEXT_PLAN_HEADROOM_BYTES = 6 * 1024 ** 3;

/**
 * Architectures whose sliding-window layers the GGUF doesn't list: the runtime
 * hard-codes the period, and every `period`-th layer is full attention.
 */
const IMPLICIT_SWA_PERIOD = Object.freeze({ gemma2: 2, gemma3: 6, gptoss: 2 });

const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const at = (value, index) => (Array.isArray(value) ? value[index] : value);

/**
 * The KV layout from `model_info`, or `null` when the keys don't describe one.
 *
 * @param {Record<string, unknown>|null|undefined} modelInfo
 * @returns {{ arch: string, nativeContext: number|null, perTokenElements: number, fixedElements: number, slidingWindow: number|null }|null}
 */
export function kvLayoutFromModelInfo(modelInfo) {
  if (!modelInfo || typeof modelInfo !== 'object') return null;
  const arch = String(modelInfo['general.architecture'] || '');
  if (!arch) return null;
  const key = (name) => modelInfo[`${arch}.${name}`];
  const blocks = positive(key('block_count'));
  const heads = key('attention.head_count');
  const kvHeads = key('attention.head_count_kv') ?? heads;
  const embedding = positive(key('embedding_length'));
  if (!blocks || kvHeads == null) return null;
  const headDim = embedding && positive(at(heads, 0)) ? embedding / at(heads, 0) : null;
  const keyLength = positive(key('attention.key_length')) ?? headDim;
  const valueLength = positive(key('attention.value_length')) ?? keyLength;
  if (!keyLength || !valueLength) return null;
  const keyLengthSwa = positive(key('attention.key_length_swa')) ?? keyLength;
  const valueLengthSwa = positive(key('attention.value_length_swa')) ?? valueLength;
  const interval = positive(key('full_attention_interval'));
  const slidingWindow = positive(key('attention.sliding_window'));
  const period = IMPLICIT_SWA_PERIOD[arch];
  const listed = key('attention.sliding_window_pattern');
  const isSliding = (layer) => (Array.isArray(listed) ? listed[layer] === true : Boolean(period) && (layer + 1) % period !== 0);
  let perTokenElements = 0;
  let fixedElements = 0;
  for (let layer = 0; layer < blocks; layer += 1) {
    const layerKvHeads = Number(at(kvHeads, layer)) || 0;
    if (layerKvHeads <= 0) continue;
    // A scalar head count with an interval means the other layers are state-space.
    if (!Array.isArray(kvHeads) && interval && (layer + 1) % interval !== 0) continue;
    const sliding = Boolean(slidingWindow) && isSliding(layer);
    const elements = sliding
      ? layerKvHeads * (keyLengthSwa + valueLengthSwa)
      : layerKvHeads * (keyLength + valueLength);
    if (sliding) fixedElements += elements * slidingWindow;
    else perTokenElements += elements;
  }
  if (perTokenElements === 0 && fixedElements === 0) return null;
  return { arch, nativeContext: positive(key('context_length')), perTokenElements, fixedElements, slidingWindow };
}

/** A model's own maximum window from `model_info`, whether or not its KV layout is known. */
export function nativeContextFromModelInfo(modelInfo) {
  const arch = String(modelInfo?.['general.architecture'] || '');
  return arch ? positive(modelInfo[`${arch}.context_length`]) : null;
}

/** KV-cache bytes for `tokens` of context under `cacheType` (unknown spellings count as f16). */
export function kvCacheBytes(layout, tokens, cacheType = 'f16') {
  const bytesPerElement = KV_CACHE_BYTES_PER_ELEMENT[cacheType] ?? KV_CACHE_BYTES_PER_ELEMENT.f16;
  const window = Math.max(0, Number(tokens) || 0);
  const fixed = layout.slidingWindow ? layout.fixedElements * Math.min(1, window / layout.slidingWindow) : 0;
  return Math.ceil((layout.perTokenElements * window + fixed) * bytesPerElement);
}

/**
 * The memory one model can use: the GPU's share of unified memory on Apple
 * Silicon, the largest GPU's VRAM on CUDA, otherwise RAM.
 *
 * @param {{ appleSilicon?: boolean, totalMemoryGb?: number|null, cuda?: { maxVramGb?: number|null } }} capabilities
 * @returns {number|null} bytes
 */
export function modelMemoryBudgetBytes(capabilities) {
  const ram = positive(capabilities?.totalMemoryGb);
  const vram = positive(capabilities?.cuda?.maxVramGb);
  if (vram) return vram * 1024 ** 3;
  if (!ram) return null;
  return ram * 1024 ** 3 * (capabilities?.appleSilicon ? APPLE_GPU_MEMORY_SHARE : 1);
}

/**
 * A model's context table and recommended window: every step up to its native
 * maximum, each with KV and total bytes and whether it fits `budgetBytes`
 * beside the weights and headroom. The recommendation is the largest fitting
 * step (the native maximum itself when it sits between steps), or `null` when
 * the layout is unknown or nothing fits.
 *
 * @param {{ layout: ReturnType<typeof kvLayoutFromModelInfo>, nativeContext?: number|null, weightsBytes?: number|null, budgetBytes?: number|null, cacheType?: string }} input
 */
export function planContextWindow({ layout, nativeContext = null, weightsBytes = null, budgetBytes = null, cacheType = 'f16' }) {
  const native = positive(nativeContext) ?? layout?.nativeContext ?? null;
  const weights = positive(weightsBytes) ?? 0;
  const budget = positive(budgetBytes);
  if (!layout) return { layoutKnown: false, nativeContext: native, cacheType, weightsBytes: weights || null, budgetBytes: budget, rows: [], recommended: null };
  const steps = CONTEXT_WINDOW_STEPS.filter((tokens) => !native || tokens <= native);
  if (native && !steps.includes(native)) steps.push(native);
  const rows = steps.map((tokens) => {
    const kvBytes = kvCacheBytes(layout, tokens, cacheType);
    const totalBytes = weights + kvBytes;
    return { tokens, kvBytes, totalBytes, fits: budget ? totalBytes + CONTEXT_PLAN_HEADROOM_BYTES <= budget : null };
  });
  const fitting = rows.filter((row) => row.fits !== false);
  return {
    layoutKnown: true,
    nativeContext: native,
    cacheType,
    weightsBytes: weights || null,
    budgetBytes: budget,
    rows,
    recommended: fitting.length ? fitting[fitting.length - 1].tokens : null,
  };
}

/**
 * Normalize an `OLLAMA_KV_CACHE_TYPE` value; Ollama ignores a quantized type
 * without flash attention, so that combination plans as f16.
 */
export function effectiveKvCacheType(cacheType, flashAttention) {
  const type = String(cacheType || '').trim().toLowerCase();
  if (!KV_CACHE_BYTES_PER_ELEMENT[type] || type === 'f16') return 'f16';
  const flash = String(flashAttention ?? '').trim().toLowerCase();
  return flash === '1' || flash === 'true' ? type : 'f16';
}
