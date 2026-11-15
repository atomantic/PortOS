/**
 * Which LOCAL daemon backs a provider, and whether a stored model pin is one
 * that provider may still be handed.
 *
 * Split out of `localProviderRuntime.js` (which re-exports every name here, so
 * its existing importers are untouched) for one reason: the browser needs this
 * rule. A picker that renders a stored pin has to know whether the catalog
 * still lists it, and `localProviderRuntime.js` reaches `opencodeConfig.js` —
 * and through it `zod`, which is not a client dependency — to resolve
 * ENDPOINTS, a question no picker asks. This leaf carries only what the
 * membership rule needs (`providerModels.js`, `localEndpoint.js`, `ports.js`),
 * all of which the client already imports, so `client/src/utils/providerModels.js`
 * can mirror the server's answer instead of re-deriving a second one.
 *
 * The endpoint half stayed behind in `localProviderRuntime.js`.
 */

import { localRuntimeNamespace, isAntigravityProvider, isOpencodeProvider, antigravityCatalogListsModel, filterSelectableModels } from './providerModels.js';
import { PORTS } from './ports.js';
import { isLocalInstanceHost, localEndpointPort } from './localEndpoint.js';

/**
 * Which PortOS page manages each local runtime — the single source for
 * `LOCAL_RUNTIMES[*].manageUrl`, which reads from here.
 *
 * It lives in this leaf rather than in `localProviderRuntime.js` because the
 * CLIENT needs it too: a reviewer picker that says "start it from …" has to
 * name the same page the readiness card links to, and it cannot import the
 * endpoint half (`opencodeConfig.js` → `zod`) to get one static string. Before
 * #7414 every runtime shared one page, so a second copy was invisible; splitting
 * Models → Runtimes off Models → LLMs made a stale copy name the wrong sibling.
 *
 * Server LIFECYCLE (install, start, stop, checkpoints) is Models → Runtimes;
 * the Ollama / LM Studio WEIGHTS catalog is Models → LLMs. `null` means PortOS
 * has no page for that runtime — vLLM and SGLang are operator-owned compose
 * projects whose only PortOS surface is the readiness checklist.
 *
 * Callers turn a route into prose with `navManifest.getNavPageForPath`; never
 * write the breadcrumb out by hand beside one of these.
 */
export const LOCAL_RUNTIME_MANAGE_URLS = Object.freeze({
  llama: '/models/llms-runtimes',
  ollama: '/models/llms',
  lmstudio: '/models/llms',
  vllm: null,
  sglang: null,
  slotstream: '/models/llms-runtimes',
  mtplx: '/models/llms-runtimes',
});

// Default OpenAI-compatible ports for the two local backends PortOS manages. An
// endpoint-only provider (no id/name) pointed at one of these on the local
// instance maps to that backend.
const BACKEND_DEFAULT_PORT = { 11434: 'ollama', 1234: 'lmstudio' };

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
  // The shipped `mtplx` record is a plain OpenAI-compatible API provider with no
  // marker of its own — `mtplxBacked` only ever rides the OpenCode/Claude CLI
  // wrappers, never this record (#6466). `id` is the one signal it carries.
  // Deliberately NO port arm here, unlike slotstream two lines up: slotstream's
  // port is a PortOS-dedicated constant, while MTPLX's is user-configurable and
  // its default (`:8000`) is a generic port — keying on it would claim an
  // unrelated local API as MTPLX. `isMtplxProvider` in `mtplxServerManager.js`
  // layers a narrower port check on top of this for an unmarked/unnamed
  // provider aimed at wherever the managed daemon is actually listening right
  // now; that check needs live process state this side-effect-free module
  // cannot import without a cycle.
  if (provider?.id === 'mtplx') return 'mtplx';
  return localBackendForProvider(provider);
}

/**
 * `namespace/model` reduced to the bare model id — a no-op on an id with no
 * slash, which is exactly how OpenCode itself splits `provider/model`: on the
 * FIRST slash only.
 */
const bareOpencodeModel = (value) => value.slice(value.indexOf('/') + 1);

/**
 * Whether a provider may be handed `model` — the ONE rule for validating a
 * stored model pin against a provider record.
 *
 * Two providers are pass-throughs, for opposite reasons:
 *
 *   - one that enumerates NO models has nothing to validate against, so
 *     any id is its caller's to choose;
 *   - one backed by a LOCAL daemon has a `models` array that is only a cached
 *     snapshot, while the daemon on this machine is the authority. Every model
 *     picker in PortOS deliberately offers what the daemon reports rather than
 *     what the record lists, so judging a local pin against the record rejects
 *     a model that is installed and serving — that is how a pr-reviewer stage
 *     pinned to a freshly pulled Ollama model got "not offered by provider" on
 *     every dispatch.
 *
 * The shipped `mtplx` API record falls into the third bucket now that
 * `localRuntimeKind` names it (#6466): it lists one static id, but `mtplx serve`
 * names its process after whatever checkpoint is actually loaded, so the
 * record's `models` array is exactly the same kind of stale snapshot Ollama's
 * is — pass-through is correct here for the same reason, not a side effect of
 * the collapse.
 *
 * Beyond the pass-throughs the comparison is exact, with two tolerances for a
 * pin that is the SAME model spelled differently — not a laxer rule (#7327).
 * Both live here rather than in a wrapper so all four callers share one answer:
 *
 *  - **agy compares on BASE ids.** Once `--effort` carries the tier,
 *    `gemini-3.6-flash` and `gemini-3.6-flash-low` are the same `--model`
 *    value — `resolveAntigravityModelAndEffort` splits a suffixed pin into
 *    exactly that base plus `--effort` before spawning — and a tier the base
 *    does not offer is clamped by `antigravityModelEffortLevels` rather than
 *    being a different model. Without this a bare base id pinned against a
 *    suffix-only catalog was rejected as unserveable by the very helper that
 *    would have spawned it.
 *  - **OpenCode addresses models as `namespace/model`.** A pin is stored BARE
 *    and namespaced at spawn (`prefixOpencodeModel`), so a catalog holding the
 *    qualified form — or a pin hand-written that way — is the same model. Gated
 *    on the provider being OpenCode: ungated, the reduction would match any
 *    slash-bearing pin against a bare catalog on ANY vendor.
 *
 * A configured-default sentinel is deliberately NOT a pass-through here. It is
 * a posture rather than a model, but only a CLI that HAS its own default can be
 * handed one, so the question "is this provider's catalog missing it?" is the
 * wrong one to ask about it — `providerCatalogListsModel` answers it for the
 * retired-pin audit, and the pickers guard it with `isConfiguredDefaultModel`.
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
  if (offered.includes(model)) return true;
  if (typeof model !== 'string' || model.trim() === '') return false;

  const id = model.trim();
  // Sentinels are a posture, not a model, so they can never be what a pin
  // matches against here — and `antigravityCatalogListsModel` reads an empty
  // base list as "no catalog", which is the same pass-through as above.
  const ids = filterSelectableModels(offered.filter((m) => typeof m === 'string'));
  if (isAntigravityProvider(provider)) return antigravityCatalogListsModel(id, ids);
  // Gated on the provider actually BEING OpenCode. Ungated, the namespace
  // reduction matches any slash-bearing pin against a bare catalog on any
  // vendor — `custom/gpt-4o` would read as offered by an OpenAI record listing
  // `gpt-4o`, and the three spawn-time callers would hand that id straight to a
  // CLI/API that rejects it. Harmless while this rule only fed the audit (a
  // missed warning); a real over-permission now that it gates spawns.
  if (!isOpencodeProvider(provider)) return false;
  return ids.some((listed) => bareOpencodeModel(listed) === bareOpencodeModel(id));
}
