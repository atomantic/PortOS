/**
 * `SERVICE_DEFINITIONS` — every backend a harness can be pointed at, as ONE
 * table (#7562, the first slice of #7561).
 *
 * Before this file, "which backends exist?" was answered by four registries
 * that never met: `PROVIDER_GATEWAYS` (hosted OpenAI-compatible gateways),
 * `LOCAL_RUNTIMES` (daemons on this machine), the AI rows of
 * `credentialRegistry.js` (vendor API keys), and the implicit vendor cloud a
 * subscription harness signs into. A service is any of those, in one shape, so
 * a harness's capability bindings (`providerHarnesses.js`) can name a service
 * by id and `materializeRoute` (`providerRouteRecipes.js`) can turn a
 * (harness, service) pair into an executable record from data alone.
 *
 * Three families, one shape (epic D2):
 *   - `subscription` — auth lives inside the harness (claude.ai login, the
 *     ChatGPT/Codex login, Google for Antigravity, xAI for Grok Build, Cursor).
 *     PortOS holds no key and the service is reachable ONLY by its own program
 *     (`harnessOnly`).
 *   - `api-key` — a hosted API PortOS holds a key for. Some are also hosted
 *     GATEWAYS an OpenCode wrapper can front-end; those rows carry `gateway`,
 *     and {@link PROVIDER_GATEWAYS} in `providerGateways.js` is DERIVED from
 *     them, so a gateway is one row here and nowhere else.
 *   - `local` — a daemon on this machine, one row per `LOCAL_RUNTIMES` id
 *     (`serviceDefinitions.test.js` pins the two id sets together). The daemon's
 *     endpoint is configured per install, so these rows declare WHICH transports
 *     the runtime speaks and no default URL: an instance must name its endpoint,
 *     exactly as `providerConnectionProfile` already demands of a local record.
 *   - `fleet` — a peer's OpenAI-compatible gateway.
 *
 * A DEFINITION is code; an INSTANCE (a definition + plan + credential + catalog)
 * is a later slice's persisted row. {@link resolveServiceInstance} is the pure
 * shape both halves agree on until then.
 *
 * Dependency-light on purpose: imports nothing, so `providerGateways.js` (which
 * `providerModels.js` and the browser reach) can derive its table from here
 * without growing its closure. Default base URLs are literal strings for the
 * same reason — the local-runtime defaults, which need `PORTS`, stay in
 * `LOCAL_RUNTIMES`.
 */

/** The four families a definition belongs to. */
export const SERVICE_FAMILIES = Object.freeze(['subscription', 'api-key', 'local', 'fleet']);

/**
 * User-declared plans. `free` / `paid` are the two tiers a metered API sells;
 * `subscription` is a login the harness owns; `local` is a daemon that bills
 * nobody. A definition lists the plans it can honestly be instantiated under.
 */
export const SERVICE_PLANS = Object.freeze(['free', 'paid', 'subscription', 'local']);

/**
 * How an instance's model catalog is learned. `probe` — GET `/models` on the
 * endpoint; `daemon` — ask the local runtime manager; `harness` — ask the
 * program that signs in (`claude`, `codex`, `agy` list their own catalogs);
 * `static` — nothing to ask, the instance's declared list is the catalog.
 */
export const CATALOG_STRATEGIES = Object.freeze(['probe', 'daemon', 'harness', 'static']);

const METERED = Object.freeze(['free', 'paid']);
const PAID = Object.freeze(['paid']);
const SUBSCRIPTION = Object.freeze(['subscription']);
const LOCAL = Object.freeze(['local']);

/** A model-id suffix filter for the one plan a vendor marks in the id itself. */
const suffixPlanFilter = (suffix) => (plan, models) => (
  plan === 'free' ? models.filter((model) => String(model).endsWith(suffix)) : models
);

const definition = ({ transports = {}, credential = {}, catalog, ...row }) => Object.freeze({
  ...row,
  transports: Object.freeze(Object.fromEntries(
    Object.entries(transports).map(([protocol, transport]) => [protocol, Object.freeze({ defaultBaseUrl: null, ...transport })]),
  )),
  credential: Object.freeze({ envVars: Object.freeze([]), ...credential }),
  catalog: Object.freeze(catalog),
});

const localRuntime = (id, label, { anthropic = false } = {}) => definition({
  id,
  label,
  family: 'local',
  localRuntime: id,
  transports: { openai: {}, ...(anthropic ? { anthropic: {} } : {}) },
  plans: LOCAL,
  catalog: { strategy: 'daemon' },
});

const subscription = (id, label, harnessOnly, extra = {}) => definition({
  id,
  label,
  family: 'subscription',
  harnessOnly,
  plans: SUBSCRIPTION,
  catalog: { strategy: 'harness' },
  ...extra,
});

/**
 * @typedef {object} ServiceDefinition
 * @property {string} id — stable identity; also the default instance slug, the
 *   OpenCode namespace for a gateway, and the `service` a harness binding names.
 * @property {string} label
 * @property {'subscription'|'api-key'|'local'|'fleet'} family
 * @property {Record<'anthropic'|'openai', {defaultBaseUrl: string|null}>} transports —
 *   the wire protocols the service speaks. A service declaring none is reached
 *   only through a program that knows it (`harnessOnly`) or a static env switch.
 * @property {{envVars: readonly string[], keyUrl?: string}} credential — the env
 *   var names a key for this service is conventionally held under (first is
 *   canonical), and where to obtain one.
 * @property {readonly string[]} plans — the {@link SERVICE_PLANS} an instance may declare.
 * @property {{strategy: string, planFilter?: (plan: string, models: string[]) => string[]}} catalog
 * @property {string} [localRuntime] — the `LOCAL_RUNTIMES` id this row IS.
 * @property {string} [harnessOnly] — reachable only through this harness id.
 * @property {{apiKeyEnv: string, legacyMarker?: string, legacyApiKeyField?: string}} [gateway] —
 *   present on the rows `PROVIDER_GATEWAYS` derives from.
 * @property {string} [piProvider] — the built-in provider name Pi ships for this
 *   service (`pi --provider <name>`), read by Pi's harness binding.
 */

/** @type {readonly ServiceDefinition[]} */
export const SERVICE_DEFINITIONS = Object.freeze([
  // --- subscription ---------------------------------------------------------
  subscription('claude-subscription', 'Claude subscription', 'claude'),
  subscription('codex-subscription', 'ChatGPT / Codex subscription', 'codex'),
  subscription('antigravity', 'Antigravity (Google)', 'antigravity'),
  subscription('grok-build', 'Grok Build (xAI)', 'grok'),
  subscription('cursor', 'Cursor', 'cursor', {
    credential: { envVars: ['CURSOR_API_KEY'], keyUrl: 'https://cursor.com/dashboard' },
  }),

  // --- api-key --------------------------------------------------------------
  definition({
    id: 'anthropic',
    label: 'Anthropic API',
    family: 'api-key',
    transports: { anthropic: { defaultBaseUrl: 'https://api.anthropic.com' } },
    credential: { envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], keyUrl: 'https://console.anthropic.com/settings/keys' },
    plans: PAID,
    catalog: { strategy: 'probe' },
    piProvider: 'anthropic',
  }),
  definition({
    id: 'openai',
    label: 'OpenAI API',
    family: 'api-key',
    transports: { openai: { defaultBaseUrl: 'https://api.openai.com/v1' } },
    credential: { envVars: ['OPENAI_API_KEY'], keyUrl: 'https://platform.openai.com/api-keys' },
    plans: PAID,
    catalog: { strategy: 'probe' },
    piProvider: 'openai',
  }),
  definition({
    id: 'google',
    label: 'Google AI Studio (Gemini)',
    family: 'api-key',
    // Gemini's OpenAI-compatible surface; the native Generative Language API is
    // reached only by programs that speak it (Pi's `google` provider).
    transports: { openai: { defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' } },
    credential: { envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY'], keyUrl: 'https://aistudio.google.com/apikey' },
    plans: METERED,
    catalog: { strategy: 'probe' },
    piProvider: 'google',
  }),
  definition({
    id: 'xai',
    label: 'xAI API',
    family: 'api-key',
    transports: { openai: { defaultBaseUrl: 'https://api.x.ai/v1' } },
    credential: { envVars: ['XAI_API_KEY', 'GROK_API_KEY'], keyUrl: 'https://console.x.ai/' },
    plans: PAID,
    catalog: { strategy: 'probe' },
    piProvider: 'xai',
  }),
  definition({
    id: 'bedrock',
    label: 'Amazon Bedrock',
    family: 'api-key',
    // No transport of its own: Claude Code reaches it through a static env
    // switch (`CLAUDE_CODE_USE_BEDROCK=1`) and Pi through its own provider name.
    credential: { envVars: ['AWS_BEARER_TOKEN_BEDROCK'], keyUrl: 'https://console.aws.amazon.com/bedrock/' },
    plans: PAID,
    catalog: { strategy: 'static' },
    piProvider: 'amazon-bedrock',
  }),
  definition({
    id: 'kimi',
    label: 'Kimi / Moonshot',
    family: 'api-key',
    transports: { openai: { defaultBaseUrl: 'https://api.moonshot.ai/v1' } },
    credential: { envVars: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
    plans: PAID,
    catalog: { strategy: 'probe' },
    harnessOnly: 'kimi',
    piProvider: 'kimi-coding',
  }),
  // The three hosted gateways, in the order `PROVIDER_GATEWAYS` has always
  // listed them — registry order breaks a tie on a record carrying two markers.
  definition({
    id: 'orcarouter',
    label: 'OrcaRouter',
    family: 'api-key',
    transports: { openai: { defaultBaseUrl: 'https://api.orcarouter.ai/v1' } },
    credential: { envVars: ['ORCAROUTER_API_KEY'] },
    plans: PAID,
    catalog: { strategy: 'probe' },
    gateway: Object.freeze({ apiKeyEnv: 'ORCAROUTER_API_KEY', legacyMarker: 'orcarouterBacked', legacyApiKeyField: 'orcarouterApiKey' }),
  }),
  definition({
    id: 'openrouter',
    label: 'OpenRouter',
    family: 'api-key',
    transports: { openai: { defaultBaseUrl: 'https://openrouter.ai/api/v1' } },
    credential: { envVars: ['OPENROUTER_API_KEY'] },
    plans: METERED,
    // OpenRouter marks its free tier in the model id itself — the one real signal.
    catalog: { strategy: 'probe', planFilter: suffixPlanFilter(':free') },
    gateway: Object.freeze({ apiKeyEnv: 'OPENROUTER_API_KEY' }),
    piProvider: 'openrouter',
  }),
  definition({
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    family: 'api-key',
    transports: { openai: { defaultBaseUrl: 'https://integrate.api.nvidia.com/v1' } },
    credential: { envVars: ['NVIDIA_API_KEY'], keyUrl: 'https://build.nvidia.com' },
    // Free vs paid is declared by the user: NIM's `/models` carries no tier field.
    plans: METERED,
    catalog: { strategy: 'probe' },
    gateway: Object.freeze({ apiKeyEnv: 'NVIDIA_API_KEY' }),
    piProvider: 'nvidia',
  }),
  definition({
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    family: 'api-key',
    transports: { openai: { defaultBaseUrl: 'https://opencode.ai/zen/v1' } },
    credential: { envVars: ['OPENCODE_API_KEY'], keyUrl: 'https://opencode.ai/auth' },
    plans: METERED,
    catalog: { strategy: 'probe', planFilter: suffixPlanFilter('-free') },
    piProvider: 'opencode',
  }),
  definition({
    id: 'cerebras',
    label: 'Cerebras',
    family: 'api-key',
    transports: { openai: { defaultBaseUrl: 'https://api.cerebras.ai/v1' } },
    credential: { envVars: ['CEREBRAS_API_KEY'], keyUrl: 'https://cloud.cerebras.ai/' },
    plans: METERED,
    catalog: { strategy: 'probe' },
    piProvider: 'cerebras',
  }),
  definition({
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    family: 'api-key',
    // A bare endpoint the user names; nothing conventional to default to.
    transports: { openai: {} },
    plans: METERED,
    catalog: { strategy: 'probe' },
  }),

  // --- local ----------------------------------------------------------------
  // Ollama serves an Anthropic-compatible surface beside its `/v1`, which is
  // what lets Claude Code drive it.
  localRuntime('ollama', 'Ollama', { anthropic: true }),
  localRuntime('lmstudio', 'LM Studio'),
  localRuntime('mtplx', 'MTPLX'),
  localRuntime('llama', 'llama.cpp'),
  localRuntime('vllm', 'vLLM'),
  localRuntime('sglang', 'SGLang', { anthropic: true }),
  localRuntime('slotstream', 'Slotstream'),

  // --- fleet ----------------------------------------------------------------
  definition({
    id: 'fleet-host',
    label: 'Fleet host',
    family: 'fleet',
    transports: { openai: {} },
    plans: Object.freeze(['free']),
    catalog: { strategy: 'probe' },
  }),
]);

/** Every definition id. */
export const SERVICE_DEFINITION_IDS = Object.freeze(SERVICE_DEFINITIONS.map((row) => row.id));

/** The definition for an id, or `null`. */
export const serviceDefinitionById = (id) => SERVICE_DEFINITIONS.find((row) => row.id === id) || null;

/** The definition that IS a local runtime id, or `null`. */
export const serviceDefinitionForLocalRuntime = (runtimeId) =>
  SERVICE_DEFINITIONS.find((row) => row.localRuntime === runtimeId) || null;

/**
 * A slug an instance may be addressed by: `[a-z0-9][a-z0-9-]*`, so it can sit
 * inside a composite provider id (`harness.method@service`) unescaped.
 */
export const SERVICE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The pure INSTANCE shape the rest of the epic composes over: a definition,
 * the slug it is addressed by, the plan the user declared, the endpoints it is
 * actually reached at, and its credential material.
 *
 * Accepts a definition id, an instance input, or an already-resolved instance
 * (resolution is idempotent), so every consumer can take any of them. A
 * transport the instance does not
 * override falls back to the definition's default base URL; a transport with
 * neither is still DECLARED (the service speaks it) but has no endpoint, which
 * `materializeRoute` refuses rather than guessing — a local daemon's port is an
 * install-specific fact.
 *
 * `credentials` holds raw secret material, exactly as `providerConnectionProfile`'s
 * does, and must never be serialized into a response.
 *
 * @param {{definitionId?: string, definition?: ServiceDefinition, slug?: string, plan?: string,
 *          transports?: Record<string, {baseUrl?: string|null}>, credentials?: {apiKey?: string},
 *          credential?: {via?: 'bootstrap'|'stored'}, credentialVia?: 'bootstrap'|'stored'}|string} input
 * @returns {{definition: ServiceDefinition, slug: string, plan: string,
 *            transports: Record<string, {baseUrl: string|null}>, credentials: {apiKey?: string},
 *            credentialVia: 'stored'|'bootstrap'}}
 */
export function resolveServiceInstance(input) {
  const raw = typeof input === 'string' ? { definitionId: input } : (input || {});
  const definition = raw.definition || serviceDefinitionById(raw.definitionId);
  if (!definition) throw serviceError('SERVICE_DEFINITION_UNKNOWN', `No service definition "${raw.definitionId ?? ''}"`);

  const slug = raw.slug ?? definition.id;
  if (!SERVICE_SLUG_RE.test(slug)) throw serviceError('SERVICE_SLUG_INVALID', `"${slug}" is not a service slug ([a-z0-9][a-z0-9-]*)`);
  const plan = raw.plan ?? definition.plans[0];
  if (!definition.plans.includes(plan)) {
    throw serviceError('SERVICE_PLAN_UNSUPPORTED', `${definition.label} has no "${plan}" plan; choose one of ${definition.plans.join(', ')}`);
  }

  const transports = {};
  for (const [protocol, transport] of Object.entries(definition.transports)) {
    const override = raw.transports?.[protocol]?.baseUrl;
    transports[protocol] = { baseUrl: typeof override === 'string' && override !== '' ? override : transport.defaultBaseUrl };
  }
  return {
    definition,
    slug,
    plan,
    transports,
    credentials: { ...(raw.credentials || {}) },
    credentialVia: raw.credentialVia === 'bootstrap' || raw.credential?.via === 'bootstrap' ? 'bootstrap' : 'stored',
  };
}

/** A typed error every consumer can key on. */
export function serviceError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
