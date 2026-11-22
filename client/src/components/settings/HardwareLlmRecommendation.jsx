import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, Cpu, Gauge, Sparkles } from 'lucide-react';
import { getSystemCapabilities } from '../../services/apiSystem.js';

/**
 * The curated coding-agent path is data: each model below carries the facts
 * the launch window is computed from, and each hardware tier only names which
 * model and pack it runs. Swapping the recommended model is a one-line tier
 * edit; the window, the memory note and the badge follow from the model entry.
 *
 * MTPLX allocates the window up front (`--context-window`, see
 * `server/lib/localModelTuning.js`), so the window is a memory reservation, not
 * a ceiling that costs nothing until used. The budget it has to fit inside is
 * the GPU's share of unified memory, which macOS defaults to ~75% of installed
 * RAM; PortOS, Postgres, the browser and the harness live in the remaining
 * quarter alongside the OS. `GPU_HEADROOM_GIB` more of the GPU budget stays free
 * for prefill buffers and the local image/video runtimes sharing it.
 *
 * Inkling 2 Mini (MTPLX pack config) has 24 layers, of which only 4 are full
 * attention (5, 11, 17, 23); the other 20 are 1024-token sliding windows, a
 * constant-size cache independent of the window. Layers 6-17 loop 3 times per
 * token, so layers 11 and 17 hold a cache per pass: 8 full-attention passes x
 * 8 KV heads x 128 dims x K+V x 2 bytes = 32 KB per token at a 16-bit cache.
 * The pack is 17.2 GB on disk (16 GiB) and its window stops at 1,048,576.
 * Measured on a 128 GB M5 Max: 59 tok/s mean decode and 3 s first token versus
 * 39 tok/s and 5.8 s for Qwen3.8-27B Optimized Speed, an Artificial Analysis
 * index tie (20.0 vs 20.1 at xhigh), and 3 of 3 sandbox-repair passes through
 * OpenCode MTPLX TUI in 50-66 s.
 */
export const CODING_AGENT_MODELS = {
  'inkling-2-mini': {
    label: 'Inkling 2 Mini',
    weightsGib: 16,
    kvKbPerToken: 32,
    maxContextTokens: 1_048_576,
    caveat: 'In the repair check it edited files through bash heredocs rather than OpenCode’s edit tool, and its vendor advises capping output tokens and agent turns.',
  },
};

export const GPU_HEADROOM_GIB = 8;
const MIN_LAUNCH_CONTEXT_TOKENS = 32_768;

/** Weights + the KV cache a window of `tokens` reserves, in GiB. */
export const residentGib = (model, tokens) =>
  model.weightsGib + (tokens * model.kvKbPerToken) / (1024 * 1024);

/** The GPU's default share of unified memory on Apple Silicon, in GiB. */
export const appleGpuBudgetGib = (totalMemoryGb) => totalMemoryGb * 0.75;

/**
 * The largest power-of-two window up to the model's ceiling that leaves
 * `GPU_HEADROOM_GIB` of the GPU budget free, or null when not even the minimum
 * window fits (the tier must not recommend the model at all).
 */
export function launchContextTokens(model, gpuBudgetGib) {
  for (let tokens = model.maxContextTokens; tokens >= MIN_LAUNCH_CONTEXT_TOKENS; tokens /= 2) {
    if (gpuBudgetGib - residentGib(model, tokens) >= GPU_HEADROOM_GIB) return tokens;
  }
  return null;
}

const windowLabel = (tokens) => (tokens >= 1_048_576 ? `${tokens / 1_048_576}M` : `${tokens / 1024}K`);
const contextLabel = (tokens) => `${windowLabel(tokens)} context`;
const gib = (value) => `~${Math.round(value)} GiB`;

const APPLE_TIERS = [
  {
    id: 'apple-48',
    minMemoryGb: 48,
    maxMemoryGb: 63,
    modelKey: 'inkling-2-mini',
    pack: 'MTPLX Optimized-Speed',
    alternatives: 'Set --kv-quant q8 to halve the cache when a longer window matters more than long-context decode speed. Qwen3.8-27B MTPLX is the dense fallback at 128K here. llama.cpp remains the compatibility fallback.',
  },
  {
    id: 'apple-64',
    minMemoryGb: 64,
    maxMemoryGb: 127,
    modelKey: 'inkling-2-mini',
    pack: 'MTPLX Optimized-Speed',
    alternatives: 'Qwen3.8-27B MTPLX is the dense fallback at its full 256K window. Use Slotstream only when deliberately running the SSD-streamed Flash-Next model. llama.cpp is the useful GGUF compatibility and tuning route.',
  },
  {
    id: 'apple-128',
    minMemoryGb: 128,
    modelKey: 'inkling-2-mini',
    pack: 'MTPLX Optimized-Speed',
    alternatives: 'The Optimized-Quality pack trades about a sixth of the decode speed for fidelity. Qwen3.8-27B MTPLX Optimized Quality is the dense fallback at 256K. Slotstream is an optional path for the larger SSD-streamed Flash-Next model.',
  },
];

/** Resolve a tier against its model entry into the profile the card renders. */
function appleProfile(tier) {
  const model = CODING_AGENT_MODELS[tier.modelKey];
  const budget = appleGpuBudgetGib(tier.minMemoryGb);
  const contextTokens = launchContextTokens(model, budget);
  if (!contextTokens) return null;
  const atCeiling = contextTokens === model.maxContextTokens;
  return {
    id: tier.id,
    minMemoryGb: tier.minMemoryGb,
    maxMemoryGb: tier.maxMemoryGb,
    machine: `${tier.minMemoryGb} GB Apple Silicon`,
    contextTokens,
    runtime: 'MTPLX',
    harness: 'OpenCode MTPLX TUI',
    modelLabel: model.label,
    model: `${model.label} ${tier.pack}`,
    note: `Native MTP speculative decoding. Weights and a ${windowLabel(contextTokens)} KV cache reserve ${gib(residentGib(model, contextTokens))} of the ${gib(budget)} this machine gives the GPU${atCeiling ? ', which is the checkpoint’s full window' : ''}, leaving headroom for PortOS and the harness.${model.caveat ? ` ${model.caveat}` : ''}`,
    alternatives: tier.alternatives,
  };
}

const APPLE_PROFILES = APPLE_TIERS.map(appleProfile).filter(Boolean);

const RTX_3090_PROFILE = {
  id: 'rtx-3090',
  machine: 'Windows + NVIDIA RTX 3090 (24 GB VRAM)',
  contextTokens: 65_536,
  runtime: 'llama.cpp',
  harness: 'OpenCode llama TUI',
  modelLabel: 'Qwen3.8-27B',
  model: 'Qwen3.8-27B GGUF (Q4)',
  note: 'Runs the 27B coding model directly on the 3090 through the mature GGUF path; use one request slot for an interactive coding agent. Weights plus a 64K KV cache already claim ~19 of the card’s 24 GB, which is what caps the window here.',
  alternatives: 'Quantize the KV cache (--cache-type-k q8_0 with flash attention on) to buy a longer window on this card. MTPLX and Slotstream are Apple-Silicon runtimes. Ollama is fine for a simpler general-purpose local setup, but this profile keeps llama.cpp controls available.',
};

/**
 * Select a deliberately small set of maintained, hardware-specific starting
 * profiles. This is separate from the catalog's per-model fit calculation:
 * fit answers whether a weight can run, while this answers which full runtime
 * and harness path PortOS has curated for a coding agent.
 */
export function hardwareLlmRecommendation(capabilities) {
  const memory = Number(capabilities?.totalMemoryGb);
  const gpuNames = (capabilities?.cuda?.gpus || []).map((gpu) => gpu?.name || '').join(' ');
  const maxVramGb = Number(capabilities?.cuda?.maxVramGb);
  if (capabilities?.platform === 'win32' && /rtx\s*3090/i.test(gpuNames) && maxVramGb >= 24) {
    return RTX_3090_PROFILE;
  }
  if (capabilities?.platform !== 'darwin' || capabilities?.appleSilicon !== true || !Number.isFinite(memory)) return null;
  return APPLE_PROFILES.find((profile) => memory >= profile.minMemoryGb && (profile.maxMemoryGb == null || memory <= profile.maxMemoryGb)) || null;
}

function RecommendationBody({ profile }) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
        <div className="bg-port-bg/70 rounded-lg p-2.5 min-w-0"><span className="text-gray-500">Runtime</span><p className="text-gray-200 mt-0.5 font-medium">{profile.runtime}</p></div>
        <div className="bg-port-bg/70 rounded-lg p-2.5 min-w-0"><span className="text-gray-500">Harness</span><p className="text-gray-200 mt-0.5 font-medium">{profile.harness}</p></div>
        <div className="bg-port-bg/70 rounded-lg p-2.5 min-w-0"><span className="text-gray-500">Launch target</span><p className="text-gray-200 mt-0.5 font-medium">{contextLabel(profile.contextTokens)}</p></div>
      </div>

      <div className="text-xs text-gray-300 space-y-1.5 leading-relaxed">
        <p className="flex gap-2"><CheckCircle2 size={14} className="text-port-success shrink-0 mt-0.5" /><span><strong className="text-gray-200">Model:</strong> {profile.model}</span></p>
        <p className="flex gap-2"><Cpu size={14} className="text-gray-500 shrink-0 mt-0.5" /><span>{profile.note}</span></p>
        <p className="text-gray-500">{profile.alternatives}</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <Link to="/ai" className="text-port-accent hover:underline">Configure the harness in AI Providers</Link>
        <Link to="/models/performance" className="inline-flex items-center gap-1 text-port-accent hover:underline"><Gauge size={12} /> Validate with a local task check</Link>
      </div>
    </>
  );
}

export default function HardwareLlmRecommendation() {
  const [capabilities, setCapabilities] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [wideViewport, setWideViewport] = useState(() => window.matchMedia?.('(min-width: 640px)').matches ?? false);
  const [mobileExpanded, setMobileExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSystemCapabilities({ silent: true })
      .then((result) => {
        if (!cancelled) setCapabilities(result);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.('(min-width: 640px)');
    if (!media) return undefined;
    const syncViewport = () => setWideViewport(media.matches);
    syncViewport();
    media.addEventListener('change', syncViewport);
    return () => media.removeEventListener('change', syncViewport);
  }, []);

  const profile = hardwareLlmRecommendation(capabilities);
  if (!loaded) {
    return <div className="bg-port-card border border-port-border rounded-xl p-4 text-xs text-gray-500">Checking this machine for a curated coding-agent setup…</div>;
  }
  if (!profile) return null;

  return (
    <details
      className="group bg-port-accent/5 border border-port-accent/40 rounded-xl p-4 sm:p-5"
      open={wideViewport || mobileExpanded}
      onToggle={(event) => { if (!wideViewport) setMobileExpanded(event.currentTarget.open); }}
    >
      <summary
        className="flex cursor-pointer list-none flex-col sm:flex-row sm:cursor-default sm:items-start justify-between gap-3"
        onClick={(event) => { if (wideViewport) event.preventDefault(); }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-port-accent">
            <Sparkles size={16} />
            <h2 id="hardware-llm-recommendation-title" className="text-sm font-semibold">Recommended coding-agent setup</h2>
          </div>
          <p className="text-xs text-gray-400 mt-1">Curated for this machine: {profile.machine}</p>
        </div>
        <span className="text-[11px] px-2 py-1 rounded border border-port-accent/30 text-port-accent shrink-0">{profile.modelLabel}</span>
      </summary>
      <div className="mt-3 space-y-3 group-open:block sm:block">
        <RecommendationBody profile={profile} />
      </div>
    </details>
  );
}
