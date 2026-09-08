/**
 * Safety clamps for mind-driven local LLM context (`numCtx`) adjustments.
 *
 * Pure helpers — no I/O. Callers pass host facts (RAM, free memory, GPU/VRAM)
 * so a Persistent Mind cannot OOM PortOS on CPU-only / low-RAM hosts by
 * requesting an unbounded window.
 */

/** Absolute floor / ceiling accepted on the wire (matches provider schema). */
export const MIND_LOCAL_CONTEXT_ABSOLUTE_MIN = 512;
export const MIND_LOCAL_CONTEXT_ABSOLUTE_MAX = 131072;

/** Reserve this much RAM for PortOS + OS before estimating KV-cache headroom. */
export const MIND_LOCAL_CONTEXT_PORTOS_HEADROOM_GB = 2.5;

/**
 * Rough tokens-per-GB of remaining RAM for CPU / unified-memory KV growth.
 * Conservative: oversized windows silently offload and freeze the box.
 */
export const MIND_LOCAL_CONTEXT_TOKENS_PER_FREE_GB = 1800;

/** Default assumed weight if the caller cannot supply a model size. */
export const MIND_LOCAL_CONTEXT_DEFAULT_MODEL_GB = 5;

export const MIND_LOCAL_CONTEXT_LIMITS = Object.freeze({
  maxAdjustmentsPerRollingDay: 6,
  minGapMs: 10 * 60 * 1000,
  rollingWindowMs: 24 * 60 * 60 * 1000,
  reasonChars: 240,
});

const positiveNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.floor(value)));

/**
 * Tiered hard ceiling from installed RAM when no discrete GPU is usable.
 * Keeps CPU-only Grok-box / laptop hosts from loading huge contexts.
 */
export function cpuOnlyContextCeiling(totalMemoryGb) {
  const total = positiveNumber(totalMemoryGb);
  if (total == null) return 4096;
  if (total < 12) return 2048;
  // ≤16 GB CPU-only (Grok box): live-validated 20480 with PortOS healthy.
  if (total <= 16) return 20480;
  if (total < 24) return 24576;
  if (total < 32) return 32768;
  if (total < 48) return 49152;
  return 65536;
}

/**
 * Soft ceiling from currently free RAM after reserving PortOS headroom + model.
 */
export function freeMemoryContextCeiling({
  freeMemoryGb = null,
  modelSizeGb = MIND_LOCAL_CONTEXT_DEFAULT_MODEL_GB,
  headroomGb = MIND_LOCAL_CONTEXT_PORTOS_HEADROOM_GB,
  tokensPerFreeGb = MIND_LOCAL_CONTEXT_TOKENS_PER_FREE_GB,
} = {}) {
  const free = positiveNumber(freeMemoryGb);
  if (free == null) return null;
  const model = positiveNumber(modelSizeGb) ?? MIND_LOCAL_CONTEXT_DEFAULT_MODEL_GB;
  const headroom = positiveNumber(headroomGb) ?? MIND_LOCAL_CONTEXT_PORTOS_HEADROOM_GB;
  const usable = free - headroom - model;
  if (usable <= 0) return MIND_LOCAL_CONTEXT_ABSOLUTE_MIN;
  const tokens = Math.floor(usable * (positiveNumber(tokensPerFreeGb) ?? MIND_LOCAL_CONTEXT_TOKENS_PER_FREE_GB));
  return clampInt(tokens, MIND_LOCAL_CONTEXT_ABSOLUTE_MIN, MIND_LOCAL_CONTEXT_ABSOLUTE_MAX);
}

/**
 * GPU path: allow a higher ceiling scaled by VRAM, still hard-capped.
 */
export function gpuContextCeiling(maxVramGb) {
  const vram = positiveNumber(maxVramGb);
  if (vram == null) return null;
  if (vram < 8) return 8192;
  if (vram < 12) return 16384;
  if (vram < 20) return 32768;
  if (vram < 40) return 65536;
  return MIND_LOCAL_CONTEXT_ABSOLUTE_MAX;
}

/**
 * Resolve the safe max `numCtx` a mind may request right now.
 *
 * @returns {{ max: number, min: number, reasons: string[] }}
 */
export function resolveMindLocalContextClamp(facts = {}) {
  const reasons = [];
  const absoluteMax = clampInt(
    positiveNumber(facts.absoluteMax) ?? MIND_LOCAL_CONTEXT_ABSOLUTE_MAX,
    MIND_LOCAL_CONTEXT_ABSOLUTE_MIN,
    MIND_LOCAL_CONTEXT_ABSOLUTE_MAX,
  );
  let max = absoluteMax;

  const cpuCeiling = cpuOnlyContextCeiling(facts.totalMemoryGb);
  if (facts.hasUsableGpu === true) {
    const gpuCeiling = gpuContextCeiling(facts.maxVramGb);
    if (gpuCeiling != null) {
      max = Math.min(max, gpuCeiling);
      reasons.push(`gpu-vram-ceiling:${gpuCeiling}`);
    } else {
      max = Math.min(max, Math.max(cpuCeiling, 32768));
      reasons.push(`gpu-unknown-vram:fallback:${max}`);
    }
  } else {
    max = Math.min(max, cpuCeiling);
    reasons.push(`cpu-only-ram-ceiling:${cpuCeiling}`);
  }

  const freeCeiling = freeMemoryContextCeiling({
    freeMemoryGb: facts.freeMemoryGb,
    modelSizeGb: facts.modelSizeGb,
  });
  if (freeCeiling != null) {
    max = Math.min(max, freeCeiling);
    reasons.push(`free-memory-ceiling:${freeCeiling}`);
  }

  max = clampInt(max, MIND_LOCAL_CONTEXT_ABSOLUTE_MIN, absoluteMax);
  return {
    min: MIND_LOCAL_CONTEXT_ABSOLUTE_MIN,
    max,
    reasons,
  };
}

/**
 * Clamp a requested window. Returns `{ ok, numCtx, clamp }` or a refusal.
 */
export function clampMindLocalContextRequest(requested, facts = {}) {
  const clamp = resolveMindLocalContextClamp(facts);
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: 'numCtx must be a positive integer', clamp };
  }
  const rounded = Math.floor(n);
  if (rounded < clamp.min) {
    return { ok: false, error: `numCtx must be at least ${clamp.min}`, clamp };
  }
  if (rounded > clamp.max) {
    return {
      ok: false,
      error: `numCtx ${rounded} exceeds the safe ceiling ${clamp.max} for this host (RAM/GPU clamps)`,
      clamp,
      refusedAt: rounded,
    };
  }
  return { ok: true, numCtx: rounded, clamp };
}
