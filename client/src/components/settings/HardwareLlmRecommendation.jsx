import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, Cpu, Gauge, Sparkles } from 'lucide-react';
import { getSystemCapabilities } from '../../services/api';

/**
 * The launch context on each profile below is arithmetic, not taste, so it is
 * stated here rather than typed into a string nobody can check.
 *
 * Qwen3.8-27B is 64 layers: 48 Gated DeltaNet (a constant-size recurrent state,
 * independent of window) plus 16 full-attention GQA layers, which are the only
 * ones that hold a per-token KV cache. That geometry costs 65.5 KB per token at
 * a bf16/fp16 cache — the same `KV_KB_PER_TOKEN` the SGLang recipe sizes its
 * pools from (`server/lib/sglangQwenRecipe.js`). MTPLX allocates the window up
 * front (`--context-window`, see `server/lib/localModelTuning.js`), so the
 * window is a memory reservation, not a ceiling that costs nothing until used.
 *
 * The budget it has to fit inside is the GPU's share of unified memory, which
 * macOS defaults to ~75% of installed RAM — and PortOS, Postgres, the browser
 * and the harness live in the remaining quarter alongside the OS.
 *
 * The checkpoint's own ceiling is 262,144 tokens (`localLlmCatalog.js`), so no
 * Apple tier is offered more. A 1M-token window would need 65.5 GiB of KV cache
 * on its own — more than a 48 GB machine has in total, and past every tier's
 * GPU budget even before the 15 GB of weights. The 1M-context local model in
 * the catalog is Nemotron 3 Nano 30B-A3B, not this one.
 */
const MLX_4BIT_WEIGHTS_GIB = 15;
const KV_KB_PER_TOKEN = 65.5;
export const QWEN38_MAX_CONTEXT_TOKENS = 262_144;

/** Weights + the KV cache a window of `tokens` reserves, in GiB. */
export const qwen38ResidentGib = (tokens) =>
  MLX_4BIT_WEIGHTS_GIB + (tokens * KV_KB_PER_TOKEN) / (1024 * 1024);

/** The GPU's default share of unified memory on Apple Silicon, in GiB. */
export const appleGpuBudgetGib = (totalMemoryGb) => totalMemoryGb * 0.75;

const contextLabel = (tokens) => `${tokens / 1024}K context`;

const APPLE_PROFILES = [
  {
    id: 'apple-48',
    minMemoryGb: 48,
    maxMemoryGb: 63,
    machine: '48 GB Apple Silicon',
    contextTokens: 131_072,
    runtime: 'MTPLX',
    harness: 'OpenCode MTPLX TUI',
    model: 'Qwen3.8-27B MTPLX Optimized Speed',
    note: 'Weights and a 128K KV cache reserve about 23 GiB of the ~36 GiB this machine gives the GPU, leaving practical unified-memory headroom for PortOS and the harness.',
    alternatives: 'Going further costs more than it buys here: 256K would reserve ~31 GiB and squeeze everything else, and the checkpoint stops at 256K regardless. Set --kv-quant q8 to halve the cache when a longer window matters more than long-context decode speed. Slotstream is for the much larger SSD-streamed Flash-Next model, not this 27B coding path. llama.cpp remains the compatibility fallback.',
  },
  {
    id: 'apple-64',
    minMemoryGb: 64,
    maxMemoryGb: 127,
    machine: '64 GB Apple Silicon',
    contextTokens: 262_144,
    runtime: 'MTPLX',
    harness: 'OpenCode MTPLX TUI',
    model: 'Qwen3.8-27B MTPLX Optimized Speed',
    note: 'Uses native MTP speculative decoding, with room to reserve the checkpoint’s full 256K window: ~31 GiB of the ~48 GiB GPU budget.',
    alternatives: 'Use Slotstream only when deliberately running the SSD-streamed Flash-Next model. llama.cpp is the useful GGUF compatibility and tuning route.',
  },
  {
    id: 'apple-128',
    minMemoryGb: 128,
    machine: '128 GB Apple Silicon',
    contextTokens: 262_144,
    runtime: 'MTPLX',
    harness: 'OpenCode MTPLX TUI',
    model: 'Qwen3.8-27B MTPLX Optimized Quality',
    note: 'Prioritizes the quality checkpoint at the same full 256K window — the checkpoint’s ceiling, reached with GPU budget to spare for local image and video work.',
    alternatives: 'Slotstream is an optional path for the larger SSD-streamed Flash-Next model. Use llama.cpp when a GGUF or its speculative-decoding controls are required.',
  },
];

const RTX_3090_PROFILE = {
  id: 'rtx-3090',
  machine: 'Windows + NVIDIA RTX 3090 (24 GB VRAM)',
  contextTokens: 65_536,
  runtime: 'llama.cpp',
  harness: 'OpenCode llama TUI',
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

export default function HardwareLlmRecommendation() {
  const [capabilities, setCapabilities] = useState(null);
  const [loaded, setLoaded] = useState(false);

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

  const profile = hardwareLlmRecommendation(capabilities);
  if (!loaded) {
    return <div className="bg-port-card border border-port-border rounded-xl p-4 text-xs text-gray-500">Checking this machine for a curated coding-agent setup…</div>;
  }
  if (!profile) return null;

  return (
    <section className="bg-port-accent/5 border border-port-accent/40 rounded-xl p-4 sm:p-5 space-y-3" aria-labelledby="hardware-llm-recommendation-title">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-port-accent">
            <Sparkles size={16} />
            <h2 id="hardware-llm-recommendation-title" className="text-sm font-semibold">Recommended coding-agent setup</h2>
          </div>
          <p className="text-xs text-gray-400 mt-1">Curated for this machine: {profile.machine}</p>
        </div>
        <span className="text-[11px] px-2 py-1 rounded border border-port-accent/30 text-port-accent shrink-0">Qwen3.8-27B</span>
      </div>

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
    </section>
  );
}
