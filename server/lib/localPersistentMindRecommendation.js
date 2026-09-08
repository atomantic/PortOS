/**
 * Curated Persistent Mind defaults for CPU-only / low-RAM hosts (Grok Bot boxes).
 *
 * HardwareLlmRecommendation owns GPU coding-agent presets (Apple 48GB+, RTX 3090
 * + Qwen3.8-27B). Those hosts must not be steered toward a 7B Ollama mind as the
 * primary story. This module is the complementary path: a free local mind on
 * Ollama with a tool-capable ~7B instruct model, while Cursor Agent / OpenCode
 * Zen (cloud CLIs) stay the coding harnesses.
 *
 * Pure and dependency-free so the setup service, routes, and unit tests share
 * one source of truth without probing the host.
 */

/** Default Ollama tag — Qwen2.5 7B Instruct (Q4 in the official Ollama library). */
export const LOCAL_PERSISTENT_MIND_MODEL = 'qwen2.5:7b-instruct';

/**
 * Installed ids that satisfy the recommendation. Ollama's library also ships
 * `qwen2.5:7b` as the instruct build; either tag is fine once pulled.
 */
export const LOCAL_PERSISTENT_MIND_MODEL_ALIASES = Object.freeze([
  'qwen2.5:7b-instruct',
  'qwen2.5:7b',
  'qwen2.5:7b-instruct-q4_0',
  'qwen2.5:7b-instruct-q4_K_M',
]);

export const LOCAL_PERSISTENT_MIND_PROVIDER_ID = 'ollama';

/** Rough ceiling for "low RAM" warnings and the Grok-box default path. */
export const LOCAL_PERSISTENT_MIND_LOW_RAM_GB = 20;

/** Catalog / UI size claim for the recommended pull (Q4). */
export const LOCAL_PERSISTENT_MIND_MODEL_SIZE = '~4.7 GB';

const positiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/**
 * True when an installed model id matches the recommended Persistent Mind pull
 * (exact tag or a known alias / `:latest` sibling).
 */
export function matchesLocalPersistentMindModel(modelId) {
  if (typeof modelId !== 'string' || !modelId.trim()) return false;
  const normalized = modelId.trim().toLowerCase();
  const bare = normalized.replace(/:latest$/, '');
  return LOCAL_PERSISTENT_MIND_MODEL_ALIASES.some((alias) => {
    const a = alias.toLowerCase();
    return normalized === a || bare === a || bare.startsWith(`${a}-`) || bare.startsWith(`${a}:`);
  });
}

/**
 * NVIDIA CUDA is present with usable VRAM. `absent` / empty lists are CPU-only;
 * `unknown` is not treated as "has a GPU" (a failed probe must not hide the
 * free local-mind path).
 */
export function hasUsableNvidiaGpu(capabilities) {
  const cuda = capabilities?.cuda;
  if (!cuda || cuda.status !== 'available') return false;
  const vram = positiveNumber(cuda.maxVramGb);
  return vram != null && vram > 0;
}

/** Hosts that already have a curated local coding-agent preset. */
export function isCuratedGpuCodingHost(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const memory = positiveNumber(capabilities.totalMemoryGb);
  if (capabilities.appleSilicon === true && memory != null && memory >= 48) return true;
  if (capabilities.platform === 'win32' && hasUsableNvidiaGpu(capabilities)) {
    const gpuNames = (capabilities.cuda?.gpus || []).map((gpu) => gpu?.name || '').join(' ');
    const maxVram = positiveNumber(capabilities.cuda?.maxVramGb);
    if (/rtx\s*3090/i.test(gpuNames) && maxVram != null && maxVram >= 24) return true;
  }
  return false;
}

/**
 * CPU-only / no usable discrete GPU. Apple Silicon without a CUDA probe still
 * has a GPU (unified memory) — those are not "CPU-only", but low-RAM Apple
 * boxes still get the free local-mind recommendation below.
 */
export function isCpuOnlyHost(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return false;
  if (capabilities.appleSilicon === true) return false;
  return !hasUsableNvidiaGpu(capabilities);
}

export function isLowRamHost(capabilities, thresholdGb = LOCAL_PERSISTENT_MIND_LOW_RAM_GB) {
  const memory = positiveNumber(capabilities?.totalMemoryGb);
  return memory != null && memory <= thresholdGb;
}

/**
 * Whether this install should be offered the free Ollama Persistent Mind path
 * as the default local recommendation (Grok Bot box and similar).
 */
export function hostFitsLocalPersistentMindDefault(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return false;
  if (isCuratedGpuCodingHost(capabilities)) return false;
  if (isCpuOnlyHost(capabilities)) return true;
  if (isLowRamHost(capabilities)) return true;
  // Modest Apple Silicon (< 48 GB) has no curated 27B coding preset either.
  if (capabilities.appleSilicon === true) {
    const memory = positiveNumber(capabilities.totalMemoryGb);
    return memory == null || memory < 48;
  }
  return false;
}

/**
 * Heavy 27B / vLLM / SGLang presets must not be the suggested path on these
 * hosts — they thrash CPU RAM or require a GPU that is not there.
 */
export function shouldSuppressHeavyLocalPresets(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return false;
  if (isCuratedGpuCodingHost(capabilities)) return false;
  if (hasUsableNvidiaGpu(capabilities)) {
    const vram = positiveNumber(capabilities.cuda?.maxVramGb);
    // A card under 24 GB cannot run the curated vLLM 27B path honestly.
    return vram == null || vram < 24;
  }
  if (capabilities.appleSilicon === true) {
    const memory = positiveNumber(capabilities.totalMemoryGb);
    return memory == null || memory < 32;
  }
  return true;
}

/**
 * @param {object|null|undefined} capabilities — `detectSystemCapabilities()` shape
 * @returns {object|null} recommendation profile, or null when another path owns the host
 */
export function localPersistentMindRecommendation(capabilities) {
  if (!hostFitsLocalPersistentMindDefault(capabilities)) return null;

  const memory = positiveNumber(capabilities?.totalMemoryGb);
  const cpuOnly = isCpuOnlyHost(capabilities);
  const lowRam = isLowRamHost(capabilities);
  const warnings = [];
  if (cpuOnly) {
    warnings.push('This host has no usable NVIDIA GPU — inference runs on CPU and will be slower than a GPU box.');
  }
  if (lowRam) {
    warnings.push(
      memory != null
        ? `About ${Math.round(memory)} GB RAM detected — keep the mind on a ~7B Q4 model; do not pull 27B or vLLM presets here.`
        : 'Low RAM host — keep the mind on a ~7B Q4 model; do not pull 27B or vLLM presets here.',
    );
  } else if (shouldSuppressHeavyLocalPresets(capabilities)) {
    warnings.push('Skip 27B / vLLM / SGLang presets on this machine — they need a GPU (or ≥32 GB unified memory on Apple Silicon).');
  }

  const machine = cpuOnly
    ? (memory != null
      ? `CPU-only host (~${Math.round(memory)} GB RAM)`
      : 'CPU-only host (no NVIDIA GPU)')
    : (memory != null
      ? `Modest local host (~${Math.round(memory)} GB RAM)`
      : 'Modest local host');

  return Object.freeze({
    id: 'grok-box-ollama-mind',
    audience: 'grok-box',
    machine,
    providerId: LOCAL_PERSISTENT_MIND_PROVIDER_ID,
    providerLabel: 'Ollama',
    model: LOCAL_PERSISTENT_MIND_MODEL,
    modelLabel: 'Qwen2.5 7B Instruct (Q4)',
    modelSize: LOCAL_PERSISTENT_MIND_MODEL_SIZE,
    runtime: 'Ollama',
    mindRole: 'Persistent Mind (free, local, tool-capable)',
    codingHarnesses: 'Cursor Agent / OpenCode Zen (cloud CLIs) for coding tasks',
    topology: 'Local Ollama Persistent Mind + cloud coding CLIs',
    note: 'Default for Grok Bot boxes and other CPU-only / no-GPU installs: a free local Persistent Mind on Ollama, with Cursor / OpenCode Zen reserved for coding.',
    alternatives: 'Do not enable vLLM or Qwen3.8-27B presets on this host. When you later add a GPU workstation, use Models → LLMs → Recommended coding-agent setup instead.',
    warnings: Object.freeze(warnings),
    suppressHeavyLocalPresets: shouldSuppressHeavyLocalPresets(capabilities),
    cpuOnly,
    lowRam,
  });
}
