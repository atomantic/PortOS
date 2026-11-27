/**
 * Which local runtime a provider talks to (`llama` / `ollama` / `lmstudio` / `mtplx` / `vllm` / `sglang` /
 * `slotstream`) and which base URL to probe.
 *
 * A provider like `opencode-llama-tui` can spawn its CLI fine while the daemon it points at was never installed or
 * started, which the binary check in `providerRuntimeInstaller.js` cannot see; `services/provider/providerReadiness.js`
 * does the probing. Pure and side-effect-free. Endpoint resolution prefers the provider's OWN configuration over
 * any default, or a relocated llama-server would be reported broken.
 */

import { isOpencodeCommand, parseOpencodeConfigContent } from './provider/providerModels.js';
import { opencodeLocalBaseUrl } from './opencodeLocalProviders.js';
import { localRuntimeKind, LOCAL_RUNTIME_LABELS, LOCAL_RUNTIME_MANAGE_URLS } from './modelPinMembership.js';
import { PORTS } from './ports.js';
import { isLocalInstanceEndpoint } from './localEndpoint.js';

export { isLocalInstanceHost, isLocalInstanceEndpoint, localEndpointPort } from './localEndpoint.js';
// Classification and the model-pin membership rule live in the browser-safe leaf `modelPinMembership.js` (a picker must not pull this module's graph); re-exported for existing importers.
export { localBackendForProvider, localRuntimeKind, modelPinIsOffered, LOCAL_RUNTIME_MANAGE_URLS } from './modelPinMembership.js';

/**
 * One row per local runtime PortOS can check. `defaultBaseUrl` comes from the `opencodeLocalProviders.js` table (what a spawned OpenCode actually uses), never re-typed; that leaf keeps `opencodeConfig.js` out of this module's closure.
 * `manageUrl` is the client route that installs/starts it, read from `LOCAL_RUNTIME_MANAGE_URLS` because the client needs the same answer; `null` means no page.
 * `modelsHint` and `standbyDetail` name that page via the `{page}` token, expanded by `providerReadiness.js` through `navManifest.getNavPageForPath` so a page move
 * needs no edits; runtimes with a null `manageUrl` must not use the token.
 */
export const LOCAL_RUNTIMES = Object.freeze({
  llama: Object.freeze({
    id: 'llama',
    label: LOCAL_RUNTIME_LABELS.llama,
    // The server binary, not the `llama` wrapper: what `llamaServerManager` resolves and starts.
    command: 'llama-server',
    defaultBaseUrl: opencodeLocalBaseUrl('llama'),
    manageUrl: LOCAL_RUNTIME_MANAGE_URLS.llama,
    docsUrl: 'https://github.com/ggml-org/llama.cpp',
    // Names what the user still has to fetch: GGUF weights are a separate download from the binary.
    modelsHint: 'Pick a GGUF preset on that tab — PortOS downloads the weights and starts the server there.',
    // One process, one model; the checklist must not read as "missing the model you asked for". The served id is a LABEL on the launch line (`--alias`), so a mismatch
    // is a rename, which lets `providerReadiness.js` offer to relaunch the same weights under the id the provider asks for.
    servesOneModel: true,
    aliasFlag: '--alias',
    // A stopped llama-server is a valid idle state, not an incomplete install: it needs a concrete GGUF launch choice and, with idle release, unloads and reloads in place.
    standbyWhenStopped: true,
    standbyDetail: 'No model server is running, which is a valid idle state. Choose a GGUF preset on {page} when you want to start one; with idle release configured, llama.cpp unloads it in place and reloads it on the next request.',
  }),
  ollama: Object.freeze({
    id: 'ollama',
    label: LOCAL_RUNTIME_LABELS.ollama,
    command: 'ollama',
    defaultBaseUrl: opencodeLocalBaseUrl('ollama'),
    manageUrl: LOCAL_RUNTIME_MANAGE_URLS.ollama,
    docsUrl: 'https://ollama.com/download',
    modelsHint: 'Pull a model from {page} before an agent can use this provider.',
  }),
  lmstudio: Object.freeze({
    id: 'lmstudio',
    label: LOCAL_RUNTIME_LABELS.lmstudio,
    command: 'lms',
    defaultBaseUrl: opencodeLocalBaseUrl('lmstudio'),
    manageUrl: LOCAL_RUNTIME_MANAGE_URLS.lmstudio,
    docsUrl: 'https://lmstudio.ai/download',
    modelsHint: 'Download a model in LM Studio and start its local server.',
    // No pre-spawn context preparation (unlike Ollama): LM Studio fixes context length at LOAD time and `loadModelWithArgs` would evict the operator's resident model,
    // so an `lmstudioBacked` provider's `numCtx` is set where the model is loaded.
  }),
  vllm: Object.freeze({
    id: 'vllm',
    label: LOCAL_RUNTIME_LABELS.vllm,
    // The stack ships as an upstream compose project and PortOS never vendors the engine or image; "is docker here?" is the only install question it can answer.
    command: 'docker',
    defaultBaseUrl: opencodeLocalBaseUrl('vllm'),
    // No Models page: weights and the compose project are an operator-owned prepare step.
    manageUrl: LOCAL_RUNTIME_MANAGE_URLS.vllm,
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/features/local-llm-runtimes.md#vllm-on-rtx-3090',
    modelsHint: 'Clone syv-ai/qwen38-27b-rtx3090 and run its prepare step once — or let the checklist do it, which is the only path that spends the ~30 GB.',
    // Overrides `providerReadiness`'s model-cache prose: what is missing is a whole compose project, not a checkpoint.
    setupStateDetail: Object.freeze({
      empty: 'No prepared compose project was found — its image and the ~20 GB of weights are not on disk yet.',
      ready: 'The compose project is built and its weights are on disk; this can be confirmed once the container is running.',
    }),
    // One container, one checkpoint; the served id is baked into the compose project, so nothing to rename.
    servesOneModel: true,
  }),
  sglang: Object.freeze({
    id: 'sglang',
    label: LOCAL_RUNTIME_LABELS.sglang,
    // Docker for the same reason as vLLM, but the LAUNCH LINE is ours (`lib/sglangQwenRecipe.js`) since SGLang publishes no compose project.
    command: 'docker',
    defaultBaseUrl: opencodeLocalBaseUrl('sglang'),
    // No Models page: weights are an operator-owned download.
    manageUrl: LOCAL_RUNTIME_MANAGE_URLS.sglang,
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/features/local-llm-runtimes.md#sglang-on-hopper-or-blackwell',
    modelsHint: 'Save the compose file from docs/features/local-llm-runtimes.md#sglang-on-hopper-or-blackwell and download the weights once — PortOS never pulls the image or the ~20 GB of weights.',
    // One container, one checkpoint; the recipe picks the repo from the card class.
    servesOneModel: true,
  }),
  splash: Object.freeze({
    id: 'splash',
    label: LOCAL_RUNTIME_LABELS.splash,
    command: 'splash',
    defaultBaseUrl: opencodeLocalBaseUrl('splash'),
    manageUrl: LOCAL_RUNTIME_MANAGE_URLS.splash,
    docsUrl: 'https://github.com/incoai/splash/blob/1.7.2/docs/server.md',
    modelsHint: 'Choose Start on the Splash card in {page} and wait for its model to load.',
    servesOneModel: true,
    standbyWhenStopped: true,
    standbyDetail: 'Start Splash here or on {page} when you want to use its cached Inkling 2 Mini model.',
  }),
  mkserve: Object.freeze({
    id: 'mkserve',
    label: LOCAL_RUNTIME_LABELS.mkserve,
    command: 'mkserve',
    defaultBaseUrl: opencodeLocalBaseUrl('mkserve'),
    manageUrl: LOCAL_RUNTIME_MANAGE_URLS.mkserve,
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/features/mkserve.md',
    modelsHint: 'Install and start mkserve on {page}; it serves one fixed model.',
    servesOneModel: true,
    standbyWhenStopped: true,
    standbyDetail: 'Start mkserve here or on {page} when you want to use its cached Inkling 2 Mini model.',
  }),
  slotstream: Object.freeze({
    id: 'slotstream',
    label: LOCAL_RUNTIME_LABELS.slotstream,
    command: 'slotstream',
    // Dedicated loopback port — never 11434, which is a PortOS-managed Ollama.
    defaultBaseUrl: `http://127.0.0.1:${PORTS.SLOTSTREAM}/v1`,
    manageUrl: LOCAL_RUNTIME_MANAGE_URLS.slotstream,
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/features/slotstream.md',
    modelsHint: 'A start never fetches weights — add a checkpoint on {page}, then start Slotstream there.',
    servesOneModel: true,
    standbyWhenStopped: true,
    standbyDetail: 'No streaming runtime is running, which is a valid idle state. Start it from {page} when you want a model larger than this machine\'s RAM; with idle release configured, PortOS stops it and starts it again on the next request.',
  }),
  mtplx: Object.freeze({
    id: 'mtplx',
    label: LOCAL_RUNTIME_LABELS.mtplx,
    command: 'mtplx',
    defaultBaseUrl: opencodeLocalBaseUrl('mtplx'),
    // No model CATALOG in PortOS, but Models → Runtimes owns its server (install, checkpoint, start/stop); the checklist's one-click setup (`services/localRuntimeSetup.js`) still runs in place.
    manageUrl: LOCAL_RUNTIME_MANAGE_URLS.mtplx,
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/features/local-llm-runtimes.md#mtplx-on-apple-silicon',
    modelsHint: 'Point the server at the Qwen MTP checkpoint you want, or let the checklist fetch MTPLX\'s default one when nothing is cached.',
    // MTPLX names the served model after the loaded checkpoint, so nothing to rename.
    servesOneModel: true,
  }),
});

/**
 * Local runtimes the measured-assessment feature can benchmark: the same key space as `LOCAL_RUNTIMES`, since a measurement is one bounded generation over the
 * OpenAI-compatible protocol. MANAGED runtimes have a provider record and installed-model catalog (run lands in `/runs`); ENDPOINT runtimes are bare loopback
 * daemons whose models are whatever `GET /v1/models` reports and are measured directly.
 */
export const ASSESSABLE_RUNTIMES = Object.freeze(['ollama', 'lmstudio', 'llama', 'mtplx', 'vllm', 'sglang', 'slotstream', 'splash', 'mkserve']);

/** Assessable runtimes PortOS holds a provider record and model catalog for. */
export const MANAGED_ASSESSMENT_BACKENDS = Object.freeze(['ollama', 'lmstudio']);

/** True for an assessable runtime reached as a bare OpenAI-compatible endpoint. */
export const isEndpointRuntime = (id) =>
  ASSESSABLE_RUNTIMES.includes(id) && !MANAGED_ASSESSMENT_BACKENDS.includes(id);

/** Normalize a base URL to the `/v1` root a probe needs; adds a missing scheme because `OLLAMA_HOST` is conventionally a bare `host:port`. */
export function normalizeOpenAiBaseUrl(url) {
  if (typeof url !== 'string') return null;
  let trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `http://${trimmed}`;
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

// The backend managers resolve their base URL from these env vars; reading them keeps a relocated daemon from showing as "not responding" on the card.
function envBaseUrl(kind) {
  if (kind === 'ollama') return process.env.OLLAMA_URL || process.env.OLLAMA_HOST || null;
  if (kind === 'lmstudio') return process.env.LM_STUDIO_URL || null;
  return null;
}

/** The `baseURL` an OpenCode provider config declares for `namespace`, if any. */
function opencodeConfiguredBaseUrl(provider, namespace) {
  // An unparseable hand-edited config says nothing about the endpoint; fall through to the provider's own fields.
  const parsed = parseOpencodeConfigContent(provider?.envVars?.OPENCODE_CONFIG_CONTENT);
  const baseUrl = parsed?.provider?.[namespace]?.options?.baseURL;
  return typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl : null;
}

/**
 * The local runtime a provider needs, with the endpoint to probe.
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

  // A provider whose endpoint is on ANOTHER machine has no local runtime however local its name looks (`LM Studio <box>` matched by name);
  // an external endpoint is its operator's to set up.
  if (!isLocalInstanceEndpoint(endpoint)) return null;

  const { id, ...row } = runtime;
  return { ...row, kind: id, endpoint };
}
