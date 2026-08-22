/** Shared best-effort local-model memory reclamation and headroom reporting. */

import { execFile } from './childProcess.js';
import { platform, freemem, totalmem } from 'os';
import { promisify } from 'util';
import { getLoadedModels as ollamaLoadedModels, unloadModel as ollamaUnload, getBaseUrl as ollamaBaseUrl } from '../services/ollamaManager.js';
import { getLoadedModels as lmStudioLoadedModels, unloadModel as lmStudioUnload, getBaseUrl as lmStudioBaseUrl } from '../services/lmStudioManager.js';
import { getAllProviders } from '../services/providers.js';
import { probeOpenAiModels } from './openAiModelsProbe.js';
import { getCudaCapability } from './cudaCapability.js';
import { localRuntimeForProvider, LOCAL_RUNTIMES } from './localProviderRuntime.js';
import { resolveVllmProjectDir } from './vllmQwenProject.js';

const execFileAsync = promisify(execFile);
const GB = 2 ** 30;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

export function isLocalBackendUrl(url) {
  if (!url || !URL.canParse(url)) return false;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

export async function unloadResidentModels() {
  const unloaded = [];
  if (isLocalBackendUrl(ollamaBaseUrl())) {
    const models = await ollamaLoadedModels().catch(() => []);
    for (const model of models) {
      const name = model?.name || model?.id;
      const result = name ? await ollamaUnload(name).catch(() => null) : null;
      if (result?.unloaded) unloaded.push(`ollama:${name}`);
    }
  }
  if (isLocalBackendUrl(lmStudioBaseUrl())) {
    const models = await lmStudioLoadedModels(true).catch(() => []);
    for (const model of models) {
      const result = model?.id ? await lmStudioUnload(model.id).catch(() => null) : null;
      if (result?.success) unloaded.push(`lmstudio:${model.id}`);
    }
  }
  return unloaded;
}

/**
 * Short on purpose. This runs on the hot path of every GPU-heavy local job, and
 * the only question it asks is whether something on loopback answers *now* — a
 * container that needs longer than this to reply is not the thing about to lose
 * the VRAM race.
 */
export const GPU_BLOCKER_PROBE_TIMEOUT_MS = 1_500;

/**
 * The refusal prose for a serving vLLM container. Written the way
 * `vllmStartBlockedReason` writes its refusals: it names the one command that
 * fixes it, and says why PortOS will not run that command for the operator.
 */
const vllmBlockerReason = ({ endpoint, projectDir }) =>
  `${LOCAL_RUNTIMES.vllm.label} is serving at ${endpoint} and holds nearly all of this GPU's VRAM, so this job would run out of memory partway through its model load. Stop the container with \`docker compose --profile single stop\` in ${projectDir}, then start this job again. PortOS will not stop it for you: nothing would restart it, an agent session attached to it dies with it, and a cold start takes roughly 5–7 minutes.`;

/**
 * GPU tenants that make a local media job unwinnable *before* it spends minutes
 * loading a model into VRAM it cannot have.
 *
 * Today that is exactly one thing: the vLLM Qwen3.8-27B compose container, which
 * holds ~23 GB of a 24 GB RTX 3090. `unloadResidentModels()` above cannot help —
 * it evicts loopback Ollama / LM Studio, and a container is invisible to both.
 * The job therefore proceeded, allocated, and died inside the model load with an
 * OOM naming neither vLLM nor a remedy.
 *
 * **Detect and refuse — never auto-stop** (#4766). An Ollama unload is
 * transparent (the next request reloads); stopping this container is not.
 * Nothing restarts it, an attached CoS session dies with it, and a cold start is
 * ~5–7 minutes. PortOS deliberately never *starts* this container either — both
 * directions stay operator decisions, and the refusal prose is what makes that
 * actionable.
 *
 * **Sentinel discipline.** A probe that fails, times out, or throws means "the
 * container is not serving" → **no blocker, proceed**. *Couldn't check* must
 * never collapse into *is blocking*, or an unrelated network hiccup would refuse
 * every media job on the box. Only an endpoint that actually answers blocks —
 * including a 401/403, which is a container up behind `VLLM_API_KEY`.
 *
 * Two cheap gates keep the common path free of latency, in cost order:
 *   1. No **enabled** `vllmBacked` provider → nothing to probe, no network call.
 *   2. `getCudaCapability()` says `'absent'` → this host has no NVIDIA GPU to
 *      contend over. `'unknown'` (nvidia-smi wedged or too old) is NOT a
 *      negative and still probes — same sentinel rule as above, in the other
 *      direction.
 *
 * @param {{env?: NodeJS.ProcessEnv, providers?: Array<object>|null, timeoutMs?: number}} [opts]
 *   `providers` is injectable for tests; production reads the provider store.
 * @returns {Promise<Array<{runtime: string, providerId: string|null, providerName: string|null,
 *   endpoint: string, reason: string}>>} empty when nothing is holding the GPU
 */
export async function detectGpuBlockers({ env = process.env, providers = null, timeoutMs = GPU_BLOCKER_PROBE_TIMEOUT_MS } = {}) {
  const all = Array.isArray(providers) ? providers : await getAllProviders().catch(() => []);
  const candidates = (Array.isArray(all) ? all : []).filter((p) => p?.enabled === true && p?.vllmBacked === true);
  if (!candidates.length) return [];

  // No custom timeout: this shares the memo the image-to-3D lane gating already
  // fills, and a shorter deadline here would write an 'unknown' into it that the
  // other reader would have to treat as "couldn't detect".
  const cuda = await getCudaCapability().catch(() => null);
  if (cuda?.status === 'absent') return [];

  // Two providers can point at one container with different credentials, and a
  // remote endpoint is a different machine's GPU — `localRuntimeForProvider`
  // drops the latter and returns null for it.
  const byEndpoint = new Map();
  for (const provider of candidates) {
    const runtime = localRuntimeForProvider(provider);
    if (runtime?.kind !== 'vllm' || !runtime.endpoint) continue;
    const existing = byEndpoint.get(runtime.endpoint);
    // Prefer the credentialed record: an unauthenticated probe still detects the
    // container (401 ⇒ reachable), but a readable listing is the cleaner signal.
    if (!existing || (!existing.apiKey && typeof provider.apiKey === 'string' && provider.apiKey !== '')) {
      byEndpoint.set(runtime.endpoint, { provider, apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : '' });
    }
  }
  if (!byEndpoint.size) return [];

  const projectDir = resolveVllmProjectDir(env);
  const probes = await Promise.all([...byEndpoint].map(async ([endpoint, { provider, apiKey }]) => {
    const probe = await probeOpenAiModels(endpoint, { timeoutMs, apiKey }).catch(() => null);
    if (!probe?.reachable) return null;
    return {
      runtime: 'vllm',
      providerId: provider?.id ?? null,
      providerName: provider?.name ?? null,
      endpoint,
      reason: vllmBlockerReason({ endpoint, projectDir }),
    };
  }));
  return probes.filter(Boolean);
}

/**
 * One refusal message for a `blockers` array, so all four GPU-heavy callers word
 * the refusal identically instead of each joining the reasons their own way.
 *
 * @param {Array<{reason?: string}>|null|undefined} blockers
 * @returns {string} `''` when nothing is blocking — callers gate on
 *   `blockers.length`, never on this string
 */
export const gpuBlockersMessage = (blockers) =>
  (Array.isArray(blockers) ? blockers : []).map((b) => b?.reason).filter(Boolean).join(' ');

const parsePageSize = (out) => Number(out.match(/page size of (\d+) bytes/i)?.[1] || 4096);

async function darwinAvailableGb() {
  const { stdout } = await execFileAsync('vm_stat');
  const pageSize = parsePageSize(stdout);
  const pages = (label) => Number(stdout.match(new RegExp(`${label}:\\s+(\\d+)\\.`))?.[1] || 0);
  const available = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
  return available ? (available * pageSize) / GB : null;
}

export async function getAvailableMemoryGb() {
  if (platform() === 'darwin') {
    const available = await darwinAvailableGb().catch(() => null);
    if (Number.isFinite(available) && available > 0) return available;
  }
  return freemem() / GB;
}

/**
 * The preflight every GPU-heavy local job runs: refuse-or-reclaim, then report
 * the headroom the caller sizes its run against.
 *
 * `blockers` is additive (#4766) — a non-empty array means the job cannot
 * succeed no matter how much system RAM is free, and the caller must fail fast
 * with `gpuBlockersMessage(...)` rather than start a model load.
 *
 * Nothing is unloaded while blocked: evicting the user's resident LLM is a real
 * cost, and paying it for a run that is about to be refused helps nobody.
 */
export async function prepareLocalMemory() {
  const blockers = await detectGpuBlockers().catch(() => []);
  const unloaded = blockers.length ? [] : await unloadResidentModels().catch(() => []);
  const availableGb = await getAvailableMemoryGb().catch(() => 0);
  const totalGb = totalmem() / GB;
  return { unloaded, availableGb, totalGb, budgetGb: Math.min(totalGb, availableGb), blockers };
}
