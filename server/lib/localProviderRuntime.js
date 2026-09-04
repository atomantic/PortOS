/**
 * Which local runtime a provider talks to, and at which endpoint.
 *
 * A provider like `opencode-llama-tui` is only half a configuration: PortOS can
 * spawn the OpenCode CLI perfectly and the run still dies with "Cannot connect
 * to API: Unable to connect" because the daemon it points at — `llama-server`,
 * the Ollama daemon, LM Studio's server, an MTPLX process, a vLLM container —
 * was never installed
 * or never started. The binary check in `providerRuntimeInstaller.js` answers
 * "can PortOS run `opencode`?", which is a different question and stays green in
 * exactly that failure.
 *
 * This module is the pure half of the answer: given a provider record, which
 * local runtime backs it (`llama` / `ollama` / `lmstudio` / `mtplx` / `vllm` /
 * `sglang` / `slotstream`) and what
 * base URL should be probed. `services/providerReadiness.js` does the probing.
 * Kept side-effect-free so both the readiness service and its tests can reason
 * about the mapping without a daemon on the host.
 *
 * `localBackendForProvider` (and the loopback-host rules under it) lived in
 * `services/localModelHealing.js` until this module existed; it moved here so
 * the healing path and the readiness path classify a provider identically, and
 * `localModelHealing.js` re-exports it for its existing callers.
 *
 * Endpoint resolution deliberately prefers the provider's OWN configuration
 * over any default: a user who moved llama-server to another port edited
 * `OPENCODE_CONFIG_CONTENT` (or `endpoint`), and probing the old default anyway would
 * report their working setup as broken.
 */

import { localRuntimeNamespace, isOpencodeCommand, parseOpencodeConfigContent } from './providerModels.js';
import { opencodeLocalBaseUrl } from './opencodeConfig.js';
import { PORTS } from './ports.js';
import { isLocalInstanceHost, isLocalInstanceEndpoint, localEndpointPort } from './localEndpoint.js';

export { isLocalInstanceHost, isLocalInstanceEndpoint, localEndpointPort } from './localEndpoint.js';

// Default OpenAI-compatible ports for the two local backends PortOS manages. An
// endpoint-only provider (no id/name) pointed at one of these on the local
// instance maps to that backend.
const BACKEND_DEFAULT_PORT = { 11434: 'ollama', 1234: 'lmstudio' };

/**
 * True when a hostname names the SAME local instance the backend manager runs
 * on — any loopback (`127.0.0.0/8`, `::1`), `localhost`, or the unspecified /
 * bind-all address (`0.0.0.0`, `::`, which a manager bound to all interfaces
 * reports while a provider reaches it as localhost). These all canonicalize to
 * one token so spelling differences don't block healing. Deliberately NOT
 * link-local / LAN / Tailscale hosts — a peer on another box is a DIFFERENT
 * instance whose installed models we must not heal against, and whose daemon
 * PortOS must not offer to install here.
 */
// MIRROR of `isOllamaProvider` in services/ollamaManager.js — keep in lockstep.
// Inlined so this module stays free of the manager's module graph.
const isOllamaShape = (provider) =>
  provider?.id === 'ollama' ||
  /ollama/i.test(provider?.name || '') ||
  /(^|[/:])(?:localhost|127\.0\.0\.1|\[::1\]):11434\b/i.test(String(provider?.endpoint || ''));

/**
 * Which local backend (if any) a provider maps to. Matches by id/name first
 * (`ollama` / `lmstudio`), then by an endpoint pointing at the backend's default
 * port on THIS machine's local instance.
 * @returns {'ollama'|'lmstudio'|null}
 */
export function localBackendForProvider(provider) {
  if (isOllamaShape(provider)) return 'ollama';
  if (provider?.id === 'lmstudio' || /lm[\s-]?studio/i.test(provider?.name || '')) return 'lmstudio';
  const port = localEndpointPort(provider?.endpoint);
  return port ? (BACKEND_DEFAULT_PORT[port] || null) : null;
}

/**
 * One row per local runtime PortOS knows how to check for.
 *
 * `defaultBaseUrl` is read from `opencodeConfig.js`'s provider table rather than
 * re-typed: that table is what a spawned OpenCode actually talks to when the
 * provider stores no config of its own, so a second copy here would eventually
 * probe a port nothing is on and call a working setup broken. LM Studio has no
 * row there (nothing spawns OpenCode against it), so it carries its own.
 *
 * `manageUrl` is the client route that installs/starts it — the Models → LLMs
 * page owns every one of these flows, so an unmet requirement links there
 * rather than duplicating the install UI on the Providers page.
 */
export const LOCAL_RUNTIMES = Object.freeze({
  llama: Object.freeze({
    id: 'llama',
    label: 'llama.cpp',
    // The server binary, not the `llama` convenience wrapper: this is what
    // `llamaServerManager` resolves and starts.
    command: 'llama-server',
    defaultBaseUrl: opencodeLocalBaseUrl('llama'),
    manageUrl: '/models/llms',
    docsUrl: 'https://github.com/ggml-org/llama.cpp',
    // Named so an unmet check can say what the user still has to fetch. GGUF
    // weights are a separate download from the binary — the single most common
    // reason a freshly-installed llama.cpp still cannot serve a request.
    modelsHint: 'Pick a GGUF preset on that tab — PortOS downloads the weights and starts the server there.',
    // One process, one model. Without this the readiness checklist read as
    // "llama.cpp does not have the model you asked for" — which sent users off
    // to download weights they already had.
    servesOneModel: true,
    // ...and the id it answers under is a LABEL on the launch line, not the
    // GGUF's filename. That is the whole reason a provider can list three model
    // names while the server accepts exactly one: the other two were never
    // separate downloads, they were names nothing was ever started under. It
    // also makes the mismatch a rename rather than a fetch, which is what lets
    // `providerReadiness.js` offer to relaunch the same weights under the id the
    // provider asks for.
    aliasFlag: '--alias',
    // A stopped llama-server is not an incomplete installation. Unlike an
    // always-on API daemon, llama.cpp needs a concrete GGUF launch choice; once
    // started with idle release enabled it unloads that checkpoint in place
    // and reloads it on the next request. Keep the stopped state visible as
    // standby without turning every enabled llama-backed provider into a setup
    // failure on the capability map.
    standbyWhenStopped: true,
    standbyDetail: 'No model server is running, which is a valid idle state. Choose a GGUF preset in Models → LLMs when you want to start one; with idle release configured, llama.cpp unloads it in place and reloads it on the next request.',
  }),
  ollama: Object.freeze({
    id: 'ollama',
    label: 'Ollama',
    command: 'ollama',
    defaultBaseUrl: opencodeLocalBaseUrl('ollama'),
    manageUrl: '/models/llms',
    docsUrl: 'https://ollama.com/download',
    modelsHint: 'Pull a model from Models → LLMs before an agent can use this provider.',
  }),
  lmstudio: Object.freeze({
    id: 'lmstudio',
    label: 'LM Studio',
    command: 'lms',
    defaultBaseUrl: 'http://localhost:1234/v1',
    manageUrl: '/models/llms',
    docsUrl: 'https://lmstudio.ai/download',
    modelsHint: 'Download a model in LM Studio and start its local server.',
  }),
  vllm: Object.freeze({
    id: 'vllm',
    label: 'vLLM (Qwen3.8-27B)',
    // Docker is the harness: the stack ships as an upstream compose project
    // (syv-ai/qwen38-27b-rtx3090), and PortOS never vendors the engine or the
    // ~9.5 GB image. "Is docker here?" is the only install question PortOS can
    // answer about it.
    command: 'docker',
    defaultBaseUrl: opencodeLocalBaseUrl('vllm'),
    // No Models → LLMs entry — the weights and the compose project are an
    // operator-owned ~20 GB prepare step, not something PortOS downloads.
    manageUrl: null,
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/features/qwen38-rtx3090.md',
    modelsHint: 'Clone syv-ai/qwen38-27b-rtx3090 and run its prepare step once — or let the checklist do it, which is the only path that spends the ~30 GB.',
    // What each local-setup state MEANS for this runtime, overriding
    // `providerReadiness`'s model-cache prose. The thing that is missing here is
    // a whole compose project, not a checkpoint, and "no weights cached" would
    // send the operator looking for a download that was never the first step.
    setupStateDetail: Object.freeze({
      empty: 'No prepared compose project was found — its image and the ~20 GB of weights are not on disk yet.',
      ready: 'The compose project is built and its weights are on disk; this can be confirmed once the container is running.',
    }),
    // One container, one checkpoint — but its served id is baked into the
    // compose project, so PortOS has no launch line of its own to rename.
    servesOneModel: true,
  }),
  sglang: Object.freeze({
    id: 'sglang',
    label: 'SGLang (Qwen3.8-27B)',
    // Docker again, for the same reason as vLLM: the engine ships as an official
    // image (`lmsysorg/sglang:qwen38-27b`) PortOS never builds. Unlike vLLM,
    // though, the LAUNCH LINE is ours — `lib/sglangQwenRecipe.js` owns it,
    // because SGLang publishes no compose project to inherit one from.
    command: 'docker',
    defaultBaseUrl: opencodeLocalBaseUrl('sglang'),
    // No Models → LLMs entry — the weights are an operator-owned ~20 GB
    // download, not something PortOS fetches.
    manageUrl: null,
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/features/sglang-qwen38.md',
    modelsHint: 'Save the compose file from docs/features/sglang-qwen38.md and download the weights once — PortOS never pulls the image or the ~20 GB of weights.',
    // One container, one checkpoint; the recipe picks the quantized repo from
    // the card class, so there is no per-model rename for PortOS to offer.
    servesOneModel: true,
  }),
  slotstream: Object.freeze({
    id: 'slotstream',
    label: 'Slotstream',
    command: 'slotstream',
    // Dedicated loopback port — never 11434, which is a PortOS-managed Ollama.
    defaultBaseUrl: `http://127.0.0.1:${PORTS.SLOTSTREAM}/v1`,
    manageUrl: '/models/llms',
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/features/slotstream.md',
    modelsHint: 'A start never fetches weights — add a checkpoint on Models → LLMs, then start Slotstream there.',
    servesOneModel: true,
    standbyWhenStopped: true,
    standbyDetail: 'No streaming runtime is running, which is a valid idle state. Start it from Models → LLMs when you want a model larger than this machine\'s RAM; with idle release configured, PortOS stops it and starts it again on the next request.',
  }),
  mtplx: Object.freeze({
    id: 'mtplx',
    label: 'MTPLX',
    command: 'mtplx',
    defaultBaseUrl: opencodeLocalBaseUrl('mtplx'),
    // No Models → LLMs entry — MTPLX has no model catalog inside PortOS. The
    // one-click setup on the readiness checklist
    // (`services/localRuntimeSetup.js`) is what installs it, downloads its
    // default checkpoint when the cache is empty, and starts it.
    manageUrl: null,
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/features/mtplx.md',
    modelsHint: 'Point the server at the Qwen MTP checkpoint you want, or let the checklist fetch MTPLX\'s default one when nothing is cached.',
    // One process, one checkpoint — MTPLX names it after the checkpoint it
    // loaded, so there is no label for PortOS to change.
    servesOneModel: true,
  }),
});

/**
 * Local runtimes the measured-assessment feature can benchmark.
 *
 * Deliberately the same key space as `LOCAL_RUNTIMES` above, minus nothing:
 * every local daemon PortOS knows how to *reach* is one it can also *measure*,
 * because a measurement is just one bounded generation over the shared
 * OpenAI-compatible wire protocol.
 *
 * The split below is about how PortOS gets to the model, not about how good the
 * measurement is:
 *   - MANAGED — PortOS keeps a provider record and an installed-model catalog
 *     for it, so a run goes through the playground's provider path and lands in
 *     `/runs`.
 *   - ENDPOINT — a bare loopback daemon the user (or PortOS's llama-server
 *     launcher) started. Its "installed models" are whatever `GET /v1/models`
 *     reports right now, and a measurement talks to the endpoint directly.
 */
export const ASSESSABLE_RUNTIMES = Object.freeze(['ollama', 'lmstudio', 'llama', 'mtplx', 'vllm', 'sglang', 'slotstream']);

/** Assessable runtimes PortOS holds a provider record and model catalog for. */
export const MANAGED_ASSESSMENT_BACKENDS = Object.freeze(['ollama', 'lmstudio']);

/** True for an assessable runtime reached as a bare OpenAI-compatible endpoint. */
export const isEndpointRuntime = (id) =>
  ASSESSABLE_RUNTIMES.includes(id) && !MANAGED_ASSESSMENT_BACKENDS.includes(id);

/**
 * Normalize a base URL to the `/v1` root an OpenAI-compatible probe needs.
 * A scheme is added when missing, because `OLLAMA_HOST` is conventionally a
 * bare `host:port` (mirroring `ollamaManager`'s own normalization).
 */
export function normalizeOpenAiBaseUrl(url) {
  if (typeof url !== 'string') return null;
  let trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `http://${trimmed}`;
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * The base URL the rest of PortOS talks to this backend on, when the provider
 * itself names none. The backend managers resolve their own base URL from these
 * env vars (`ollamaManager.js`, `lmStudioManager.js`); reading them here keeps a
 * relocated daemon from showing up as "not responding — install it" on the card
 * while every other PortOS feature reaches it fine.
 */
function envBaseUrl(kind) {
  if (kind === 'ollama') return process.env.OLLAMA_URL || process.env.OLLAMA_HOST || null;
  if (kind === 'lmstudio') return process.env.LM_STUDIO_URL || null;
  return null;
}

/** The `baseURL` an OpenCode provider config declares for `namespace`, if any. */
function opencodeConfiguredBaseUrl(provider, namespace) {
  // A hand-edited config that no longer parses tells us nothing about the
  // endpoint; `parseOpencodeConfigContent` answers null and we fall through to
  // the provider's own fields.
  const parsed = parseOpencodeConfigContent(provider?.envVars?.OPENCODE_CONFIG_CONTENT);
  const baseUrl = parsed?.provider?.[namespace]?.options?.baseURL;
  return typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl : null;
}

/**
 * The local-runtime kind a provider is backed by, from its explicit markers
 * first and its endpoint/name only as a fallback.
 *
 * The `*Backed` markers are authoritative — they are what the spawner itself
 * keys on. Hosted gateways (`providerGateways.js`) are deliberately excluded:
 * each is an OpenCode local *namespace* but a remote hosted API, so there is no
 * local daemon to check.
 *
 * @param {object|null|undefined} provider
 * @returns {'llama'|'ollama'|'lmstudio'|'mtplx'|'vllm'|'sglang'|'slotstream'|null}
 */
export function localRuntimeKind(provider) {
  if (!provider || typeof provider !== 'object') return null;
  // Marker-based, NOT command-based: this also resolves `claude-ollama`, which
  // carries `ollamaBacked` without being an OpenCode provider.
  const namespace = localRuntimeNamespace(provider);
  if (namespace) return namespace;
  if (provider?.id === 'slotstream' || /slotstream/i.test(provider?.name || '')) return 'slotstream';
  if (Number(localEndpointPort(provider?.endpoint)) === PORTS.SLOTSTREAM) return 'slotstream';
  return localBackendForProvider(provider);
}

/**
 * Whether a provider may be handed `model` — the one rule for validating a
 * stored model pin against a provider record.
 *
 * Two providers are pass-throughs, for opposite reasons:
 *
 *   - one that enumerates NO models has nothing to validate against, so any id
 *     is its caller's to choose;
 *   - one backed by a LOCAL daemon has a `models` array that is only a cached
 *     snapshot, while the daemon on this machine is the authority. Every model
 *     picker in PortOS deliberately offers what the daemon reports rather than
 *     what the record lists, so judging a local pin against the record rejects
 *     a model that is installed and serving — that is how a pr-reviewer stage
 *     pinned to a freshly pulled Ollama model got "not offered by provider" on
 *     every dispatch.
 *
 * Anything else enumerates its own catalog, and a pin outside it reaches the
 * CLI as a model it cannot serve.
 *
 * @param {object|null|undefined} provider
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function modelPinIsOffered(provider, model) {
  const offered = Array.isArray(provider?.models) ? provider.models : [];
  if (offered.length === 0 || localRuntimeKind(provider)) return true;
  return offered.includes(model);
}

/**
 * The local runtime a provider needs, with the endpoint PortOS should probe.
 *
 * @param {object|null|undefined} provider
 * @returns {{kind:string,label:string,command:string|null,endpoint:string|null,manageUrl:string|null,docsUrl:string,modelsHint:string,standbyWhenStopped?:boolean,standbyDetail?:string}|null}
 */
export function localRuntimeForProvider(provider) {
  const kind = localRuntimeKind(provider);
  if (!kind) return null;
  const runtime = LOCAL_RUNTIMES[kind];

  const configured = isOpencodeCommand(provider?.command)
    ? opencodeConfiguredBaseUrl(provider, kind)
    // Claude's Ollama wrapper carries the daemon URL in its own env var.
    : (typeof provider?.envVars?.ANTHROPIC_BASE_URL === 'string' ? provider.envVars.ANTHROPIC_BASE_URL : null);

  const endpoint = normalizeOpenAiBaseUrl(configured)
    || normalizeOpenAiBaseUrl(provider?.endpoint)
    || normalizeOpenAiBaseUrl(envBaseUrl(kind))
    || runtime.defaultBaseUrl;

  // A provider whose endpoint lives on ANOTHER machine has no local runtime,
  // however local its name/id looks. An `LM Studio <box>` provider pointed
  // at a LAN host still matched `lmstudio` by NAME, and the card answered
  // "LM Studio installed — `lms` is on PortOS's PATH" and "start it from
  // Models → LLMs" about a server PortOS neither runs nor can start.
  // An external API endpoint is assumed to be set up by whoever runs it; the
  // only honest report here is none.
  if (!isLocalInstanceEndpoint(endpoint)) return null;

  const { id, ...row } = runtime;
  return { ...row, kind: id, endpoint };
}
