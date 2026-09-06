/**
 * Host capabilities and the shared hardware-requirement evaluator.
 *
 * This module deliberately reports coarse, machine-local facts only. It never
 * includes a hostname, path, account, or network identity. Consumers use the
 * evaluator's three-state result to hide only a known mismatch; a failed probe
 * stays `unknown` so a transient driver problem cannot make a valid option
 * disappear.
 */

import os from 'os';
import { isAppleSilicon } from './platform.js';
import { getCudaCapability, getCudaComputeCapability } from './cudaCapability.js';

export const SYSTEM_CAPABILITIES_VERSION = 1;

const KNOWN_CUDA_STATUSES = new Set(['available', 'absent', 'unknown']);

const MEDIA_HARDWARE_REQUIREMENTS = Object.freeze({
  // The legacy entries default to mflux, which is an Apple-MLX runner.
  dev: Object.freeze({ platforms: ['darwin'], requiresAppleSilicon: true }),
  schnell: Object.freeze({ platforms: ['darwin'], requiresAppleSilicon: true }),
  // These are the explicit floors in the shipped model descriptions. Keep
  // them here as derived metadata so older media-models.json files get the
  // same protection without an on-disk migration.
  'flux2-klein-4b': Object.freeze({ minMemoryGb: 16 }),
  'flux2-klein-9b': Object.freeze({ minMemoryGb: 32 }),
  'flux2-klein-4b-int8': Object.freeze({ minMemoryGb: 32 }),
  'flux2-klein-9b-bf16': Object.freeze({ minMemoryGb: 64 }),
  'hidream-i1-full': Object.freeze({ minMemoryGb: 48 }),
  'hidream-i1-fast': Object.freeze({ minMemoryGb: 48 }),
  'qwen-image': Object.freeze({ minMemoryGb: 64 }),
  'qwen-image-edit': Object.freeze({ minMemoryGb: 64 }),
  'z-image-turbo-bf16': Object.freeze({ minMemoryGb: 16 }),
  'ernie-image': Object.freeze({ minMemoryGb: 32 }),
  'ernie-image-turbo': Object.freeze({ minMemoryGb: 32 }),
});

const LOCAL_LLM_HARDWARE_REQUIREMENTS = Object.freeze({
  // These entries are the 15–24 GB builds in the catalog's 32–128 GB tier.
  // The extra headroom accounts for the runtime and context cache, rather
  // than treating the quantized file size as the whole machine requirement.
  'qwen3.8-27b-mlx-4bit': Object.freeze({
    platforms: ['darwin'],
    requiresAppleSilicon: true,
    minMemoryGb: 32,
  }),
  'qwen3.8-27b-uncensored-mlx': Object.freeze({
    platforms: ['darwin'],
    requiresAppleSilicon: true,
    minMemoryGb: 32,
  }),
  'qwen3.8-27b': Object.freeze({ minMemoryGb: 32 }),
  'gemma4-26b-a4b': Object.freeze({ minMemoryGb: 32 }),
  'muse-glimmer-30b': Object.freeze({ minMemoryGb: 32 }),
  'glm-4.7-flash': Object.freeze({ minMemoryGb: 32 }),
  'olmo-3.1-32b': Object.freeze({ minMemoryGb: 32 }),
  'gemma4-31b': Object.freeze({ minMemoryGb: 64 }),
  'nemotron-3-nano-30b-a3b': Object.freeze({ minMemoryGb: 32 }),
  'qwen3.5-122b-a10b': Object.freeze({ minMemoryGb: 96 }),
  'qwen3-coder-30b': Object.freeze({ minMemoryGb: 32 }),
  'devstral-small-2-24b': Object.freeze({ minMemoryGb: 32 }),
  'north-mini-code-1.0': Object.freeze({ minMemoryGb: 32 }),
  'ornith-35b': Object.freeze({ minMemoryGb: 32 }),
  'nex-n2-mini': Object.freeze({ minMemoryGb: 32 }),
  'qwen3.6-35b-a3b': Object.freeze({ minMemoryGb: 32 }),
  'qwen3.6-fable-fusion': Object.freeze({ minMemoryGb: 64 }),
  'qwen3-vl-30b-a3b': Object.freeze({ minMemoryGb: 32 }),
});

// Installed local runtimes expose model IDs with quant/runtime suffixes rather
// than the catalog's stable keys. These aliases keep the automatic gate useful
// for stored provider pins too, including the MLX-only variants.
const LOCAL_MODEL_HARDWARE_REQUIREMENTS = Object.freeze({
  ...LOCAL_LLM_HARDWARE_REQUIREMENTS,
  'qwen3.8-27b-mlx': Object.freeze({
    platforms: ['darwin'],
    requiresAppleSilicon: true,
    minMemoryGb: 32,
  }),
  'gemma4-26b-mlx': Object.freeze({ minMemoryGb: 32, platforms: ['darwin'], requiresAppleSilicon: true }),
  'gemma4-31b-mlx': Object.freeze({ minMemoryGb: 64, platforms: ['darwin'], requiresAppleSilicon: true }),
});
const LOCAL_MODEL_REQUIREMENT_KEYS = Object.freeze(
  Object.keys(LOCAL_MODEL_HARDWARE_REQUIREMENTS).sort((a, b) => b.length - a.length),
);

const providerRuntimeRequirements = Object.freeze({
  mtplx: Object.freeze({
    platforms: ['darwin'],
    requiresAppleSilicon: true,
  }),
  vllm: Object.freeze({
    platforms: ['linux', 'win32'],
    requiresNvidiaGpu: true,
    minVramGb: 24,
  }),
  sglang: Object.freeze({
    platforms: ['linux', 'win32'],
    requiresNvidiaGpu: true,
    minVramGb: 32,
    minCudaComputeCapability: 9,
  }),
});

const localProvider = (provider) => provider?.ollamaBacked
  || provider?.lmstudioBacked
  || provider?.llamaBacked
  || provider?.mtplxBacked
  || provider?.vllmBacked
  || provider?.sglangBacked
  || provider?.id === 'mtplx';

const localModelHardwareRequirements = (model) => {
  if (typeof model !== 'string' || !model.trim()) return {};
  const normalized = model.trim().toLowerCase().replace(/[:_/]/g, '-');
  const key = LOCAL_MODEL_REQUIREMENT_KEYS
    .find((candidate) => normalized === candidate || normalized.startsWith(`${candidate}-`));
  return key ? LOCAL_MODEL_HARDWARE_REQUIREMENTS[key] : {};
};

const positiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const uniqueStrings = (value) => [...new Set(
  (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim()),
)];

/**
 * Normalize the user-editable requirement shape. Unknown values are omitted,
 * not treated as a failing requirement, so old/custom records remain safe to
 * read while the compatibility state stays honest.
 */
export function normalizeHardwareRequirements(requirements) {
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) return {};
  const normalized = {};
  const platforms = uniqueStrings(requirements.platforms);
  const architectures = uniqueStrings(requirements.architectures);
  if (platforms.length) normalized.platforms = platforms;
  if (architectures.length) normalized.architectures = architectures;
  for (const key of ['requiresAppleSilicon', 'requiresNvidiaGpu']) {
    if (typeof requirements[key] === 'boolean') normalized[key] = requirements[key];
  }
  for (const key of ['minMemoryGb', 'minVramGb', 'minCudaComputeCapability']) {
    const value = positiveNumber(requirements[key]);
    if (value !== null) normalized[key] = value;
  }
  return normalized;
}

/** Merge requirement layers, with later explicit values taking precedence. */
export function mergeHardwareRequirements(...layers) {
  return normalizeHardwareRequirements(Object.assign({}, ...layers));
}

const memoryGbFromBytes = (bytes) => {
  const number = Number(bytes);
  return Number.isFinite(number) && number > 0
    ? Math.round(number / 1024 ** 3)
    : null;
};

/**
 * Capture the synchronous host facts needed by the selection surfaces.
 * `isAppleSilicon` is the canonical probe and handles Rosetta-launched Node.
 */
export function captureSystemCapabilities({
  platform = process.platform,
  arch = process.arch,
  appleSilicon,
  totalMemoryBytes = os.totalmem(),
  cpuCount = os.cpus().length,
} = {}) {
  const resolvedAppleSilicon = platform === 'darwin'
    ? (typeof appleSilicon === 'boolean' ? appleSilicon : isAppleSilicon({ platform, arch }))
    : false;
  return {
    version: SYSTEM_CAPABILITIES_VERSION,
    platform,
    arch,
    appleSilicon: resolvedAppleSilicon,
    cpuCount: Number.isInteger(cpuCount) && cpuCount > 0 ? cpuCount : null,
    totalMemoryGb: memoryGbFromBytes(totalMemoryBytes),
  };
}

const normalizeCudaCapabilities = (cuda) => {
  const status = KNOWN_CUDA_STATUSES.has(cuda?.status) ? cuda.status : 'unknown';
  const gpus = Array.isArray(cuda?.gpus)
    ? cuda.gpus
      .filter((gpu) => gpu && typeof gpu === 'object')
      .map((gpu) => ({
        name: typeof gpu.name === 'string' ? gpu.name : null,
        vramGb: positiveNumber(gpu.vramGb),
        computeCap: typeof gpu.computeCap === 'string' ? gpu.computeCap : null,
      }))
    : [];
  return {
    status,
    gpus,
    maxVramGb: positiveNumber(cuda?.maxVramGb),
    primaryComputeCap: typeof cuda?.primaryComputeCap === 'string' ? cuda.primaryComputeCap : null,
    error: typeof cuda?.error === 'string' ? cuda.error : null,
  };
};

/**
 * Full capability snapshot for the dedicated system endpoint and provider
 * cards. The CUDA probe has its own cache and three-state result.
 */
export async function detectSystemCapabilities(options = {}) {
  const {
    cudaProbe = getCudaCapability,
    cudaComputeProbe,
    ...captureOptions
  } = options;
  const base = captureSystemCapabilities(captureOptions);
  const cuda = await cudaProbe();
  // Keep injected probes hermetic in tests; production's cached VRAM probe is
  // the only path that automatically adds the cached compute-capability probe.
  const compute = cudaComputeProbe
    ? await cudaComputeProbe()
    : cudaProbe === getCudaCapability && cuda?.status === 'available' && !cuda.primaryComputeCap
      ? await getCudaComputeCapability()
      : null;
  const computeByName = new Map((compute?.gpus || []).map((gpu) => [gpu.name, gpu]));
  const enrichedCuda = compute
    ? {
        ...cuda,
        primaryComputeCap: cuda?.primaryComputeCap || compute.primaryComputeCap,
        gpus: (cuda?.gpus || []).map((gpu) => ({
          ...gpu,
          computeCap: gpu.computeCap || computeByName.get(gpu.name)?.computeCap || null,
        })),
      }
    : cuda;
  return { ...base, cuda: normalizeCudaCapabilities(enrichedCuda) };
}

const reasonFor = (key, value) => {
  if (key === 'platforms') return `Requires ${value.join(' or ')}`;
  if (key === 'architectures') return `Requires ${value.join(' or ')} architecture`;
  if (key === 'requiresAppleSilicon') return 'Requires Apple Silicon';
  if (key === 'requiresNvidiaGpu') return 'Requires an NVIDIA GPU';
  if (key === 'minMemoryGb') return `Requires at least ${value} GB of system memory`;
  if (key === 'minVramGb') return `Requires an NVIDIA GPU with at least ${value} GB VRAM`;
  if (key === 'minCudaComputeCapability') return `Requires CUDA compute capability ${value}+`;
  return 'Hardware requirement not met';
};

const compareCudaCapability = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * Evaluate a requirement against a capability snapshot.
 *
 * `state: 'unknown'` is intentionally compatible for filtering purposes. A
 * menu hides only `unavailable`, while a caller that needs a hard execution
 * gate can distinguish unknown and ask the runtime to verify again.
 */
export function evaluateHardwareRequirements(requirements, capabilities = captureSystemCapabilities()) {
  const normalized = normalizeHardwareRequirements(requirements);
  const unavailable = [];
  const unknown = [];
  const capability = capabilities || {};

  if (normalized.platforms) {
    if (typeof capability.platform !== 'string') unknown.push(reasonFor('platforms', normalized.platforms));
    else if (!normalized.platforms.includes(capability.platform)) unavailable.push(reasonFor('platforms', normalized.platforms));
  }
  if (normalized.architectures) {
    if (typeof capability.arch !== 'string') unknown.push(reasonFor('architectures', normalized.architectures));
    else if (!normalized.architectures.includes(capability.arch)) unavailable.push(reasonFor('architectures', normalized.architectures));
  }
  if (normalized.requiresAppleSilicon) {
    if (typeof capability.appleSilicon !== 'boolean') unknown.push(reasonFor('requiresAppleSilicon'));
    else if (!capability.appleSilicon) unavailable.push(reasonFor('requiresAppleSilicon'));
  }
  if (normalized.minMemoryGb != null) {
    const memory = positiveNumber(capability.totalMemoryGb);
    if (memory === null) unknown.push(reasonFor('minMemoryGb', normalized.minMemoryGb));
    else if (memory < normalized.minMemoryGb) unavailable.push(reasonFor('minMemoryGb', normalized.minMemoryGb));
  }

  const needsCuda = normalized.requiresNvidiaGpu || normalized.minVramGb != null || normalized.minCudaComputeCapability != null;
  if (needsCuda) {
    const cuda = capability.cuda;
    if (!cuda || !KNOWN_CUDA_STATUSES.has(cuda.status) || cuda.status === 'unknown') {
      unknown.push(reasonFor('requiresNvidiaGpu'));
    } else if (cuda.status === 'absent') {
      unavailable.push(reasonFor('requiresNvidiaGpu'));
    } else {
      if (normalized.minVramGb != null) {
        const vram = positiveNumber(cuda.maxVramGb);
        if (vram === null) unknown.push(reasonFor('minVramGb', normalized.minVramGb));
        else if (vram < normalized.minVramGb) unavailable.push(reasonFor('minVramGb', normalized.minVramGb));
      }
      if (normalized.minCudaComputeCapability != null) {
        const computeCap = compareCudaCapability(cuda.primaryComputeCap);
        if (computeCap === null) unknown.push(reasonFor('minCudaComputeCapability', normalized.minCudaComputeCapability));
        else if (computeCap < normalized.minCudaComputeCapability) {
          unavailable.push(reasonFor('minCudaComputeCapability', normalized.minCudaComputeCapability));
        }
      }
    }
  }

  const reasons = [...new Set([...unavailable, ...unknown])];
  return {
    state: unavailable.length ? 'unavailable' : unknown.length ? 'unknown' : 'available',
    reasons,
    requirements: normalized,
  };
}

export const isHardwareCompatible = (compatibility) => compatibility?.state !== 'unavailable';

/** Resolve the derived requirements for an image or video registry entry. */
export function hardwareRequirementsForMediaModel(model, { kind = 'image', bucket } = {}) {
  const runtimeRequirements = {};
  if (kind === 'video') {
    if (bucket === 'mlx') {
      runtimeRequirements.platforms = ['darwin'];
      runtimeRequirements.requiresAppleSilicon = true;
    } else if (bucket === 'cuda') {
      runtimeRequirements.platforms = ['linux', 'win32'];
      runtimeRequirements.requiresNvidiaGpu = true;
    }
  } else if (model?.runner === 'mflux' || (!model?.runner && ['dev', 'schnell'].includes(model?.id))) {
    runtimeRequirements.platforms = ['darwin'];
    runtimeRequirements.requiresAppleSilicon = true;
  }
  // Custom image entries may carry the same coarse memory estimate as video
  // entries. Apply it across both registries before the static shipped map and
  // an explicit user override take their usual precedence.
  if (positiveNumber(model?.memoryGb) !== null) runtimeRequirements.minMemoryGb = Number(model.memoryGb);
  return mergeHardwareRequirements(runtimeRequirements, MEDIA_HARDWARE_REQUIREMENTS[model?.id], model?.hardwareRequirements);
}

/** Resolve a catalog entry's explicit platform/memory gates. */
export function hardwareRequirementsForLocalLlm(entry) {
  const platformRequirements = entry?.appleSiliconOnly
    ? { platforms: ['darwin'], requiresAppleSilicon: true }
    : {};
  return mergeHardwareRequirements(platformRequirements, LOCAL_LLM_HARDWARE_REQUIREMENTS[entry?.key], entry?.hardwareRequirements);
}

/** Resolve inferred and user-configured provider requirements. */
export function hardwareRequirementsForProvider(provider) {
  const runtime = provider?.mtplxBacked || provider?.id === 'mtplx'
    ? 'mtplx'
    : provider?.vllmBacked
      ? 'vllm'
      : provider?.sglangBacked
        ? 'sglang'
        : null;
  return mergeHardwareRequirements(providerRuntimeRequirements[runtime], provider?.hardwareRequirements);
}

export function hardwareRequirementsForProviderModel(provider, model) {
  return mergeHardwareRequirements(
    hardwareRequirementsForProvider(provider),
    localProvider(provider) ? localModelHardwareRequirements(model) : null,
    provider?.modelHardwareRequirements?.[model],
  );
}

/** Add the compatibility facts consumed by model and provider selection UIs. */
export function withHardwareCompatibility(item, capabilities, requirements) {
  const hardwareRequirements = normalizeHardwareRequirements(requirements ?? item?.hardwareRequirements);
  if (Object.keys(hardwareRequirements).length === 0
    && !item?.hardwareRequirements
    && !item?.hardwareCompatibility) return item;
  return {
    ...item,
    hardwareRequirements,
    hardwareCompatibility: evaluateHardwareRequirements(hardwareRequirements, capabilities),
  };
}

export function withProviderHardwareCompatibility(provider, capabilities) {
  const hardwareRequirements = hardwareRequirementsForProvider(provider);
  const modelRequirementLayers = provider?.modelHardwareRequirements || {};
  const modelIds = [...new Set([
    ...(Array.isArray(provider?.models) ? provider.models : []),
    ...Object.keys(modelRequirementLayers),
    provider?.defaultModel,
    provider?.lightModel,
    provider?.mediumModel,
    provider?.heavyModel,
    provider?.fallbackModel,
  ].filter((model) => typeof model === 'string' && model))];
  const modelHardwareCompatibility = Object.fromEntries(modelIds.map((model) => {
    const requirements = hardwareRequirementsForProviderModel(provider, model);
    return [model, evaluateHardwareRequirements(requirements, capabilities)];
  }));
  const hasModelRequirements = Object.values(modelHardwareCompatibility).some(
    (compatibility) => Object.keys(compatibility.requirements).length > 0,
  );
  if (Object.keys(hardwareRequirements).length === 0 && !hasModelRequirements) return provider;
  return {
    ...provider,
    hardwareRequirements,
    hardwareCompatibility: evaluateHardwareRequirements(hardwareRequirements, capabilities),
    modelHardwareCompatibility,
  };
}
