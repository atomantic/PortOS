import {
  commandBasename,
  getOpencodeLocalProviderNamespace,
  isAntigravityProvider,
  isClaudeProvider,
  isCodexProvider,
  isCursorProvider,
  isGrokProvider,
  isKimiProvider,
  isOpencodeProvider,
  prefixOpencodeModel,
} from './providerModels.js';
import { isKiloProvider } from './kilo.js';
import { isOpenchamberProvider } from './openchamber.js';

/**
 * The HARNESS half of the provider-connection graph proposed in
 * `docs/plans/2026-09-06-provider-connections-and-harnesses.md` (#6366).
 *
 * A harness is the agent program PortOS drives (Claude Code, OpenCode, Codex,
 * …) — stable, shipped-in-code identity, never a user-typed command fetched
 * from a server. It is deliberately SEPARATE from:
 *
 *   - `providerVendors.js`, which is argv/sandbox-recipe shaped;
 *   - `providerFamilies.js`, which answers "which paid subscription quota?";
 *   - `providerGateways.js`, which is a hosted OpenAI-compatible backend.
 *
 * A harness answers only: which program runs, which execution modes it can be
 * driven in, which wire protocol it speaks to a backend connection, how a
 * canonical backend model name becomes the string that program accepts — and,
 * since #7562, every WAY it can be pointed at a service (`bindings`, below).
 *
 * The `direct` row is the one harness that is not a program: a direct API
 * record is PortOS's own HTTP client speaking the OpenAI wire. Giving it a row
 * lets the epic compose `direct.api@<service>` from the same tables as every
 * CLI, while the graph keeps storing it as `harness_id = NULL` — see
 * {@link normalizeHarnessId} / {@link graphHarnessId}.
 *
 * Rows match through the existing `is*Provider` predicates rather than a fresh
 * command-string test, so a path-configured binary, a `.exe`, and the shipped
 * ids all resolve the same way they already do everywhere else in PortOS.
 */

/** Execution modes a route can carry. Mirrors the provider record's `type`. */
export const ROUTE_MODES = Object.freeze(['cli', 'tui', 'api']);

/** Modes every CLI/TUI harness supports. */
const CLI_TUI_MODES = Object.freeze(['cli', 'tui']);

/** The `direct` harness only: PortOS's own HTTP client has no process to drive. */
const API_ONLY_MODES = Object.freeze(['api']);

/**
 * Headless only. A harness whose interactive surface is not a terminal — today
 * OpenChamber, whose UI is a web app and whose bare binary starts a server —
 * has no TUI to attach a PTY to, so it must not be offered one.
 */
const CLI_ONLY_MODES = Object.freeze(['cli']);

/**
 * Why a harness carries no command recipe, as the clause the create endpoint
 * refuses with (`bindingBlocker` in `providerRouteRecipes.js`).
 *
 * This is DATA on the row rather than prose in a comment because the refusal
 * quotes it. Until three reasons existed, `bindingBlocker` hardcoded the first
 * one — so adding a `recipe: null` row for either of the others would have told
 * the user their harness "reaches only its own vendor service", which is both
 * wrong and points at the wrong remedy. `noRecipe` is set on exactly the rows
 * with no `bindings` — the ones no service can be composed onto — an invariant
 * `providerHarnesses.test.js` pins. (`direct` has no recipe either, but it is
 * not a program; it binds, so it carries no reason.)
 */
const NO_RECIPE = Object.freeze({
  /** The backend lives in a config file PortOS does not write (Kilo). */
  UNWRITTEN_CONFIG: 'resolves its backend from its own config file, which PortOS does not write',
  /** The backend belongs to a separate runtime the user configures (OpenChamber). */
  EXTERNAL_RUNTIME: 'runs against a workspace runtime you sign in to separately',
});

/**
 * Why a harness that DOES carry a recipe still cannot be minted from a bare
 * connection (`connectionLimit` on the row). Such a row is composable onto the
 * services its bindings name — `materializeRoute` runs it — but a connection
 * is an arbitrary endpoint, and these programs cannot be pointed at one.
 * Quoted by the create endpoint's refusal, like {@link NO_RECIPE}.
 */
const CONNECTION_LIMIT = Object.freeze({
  /** A subscription program: it signs into its own vendor service and nothing else. */
  VENDOR_SERVICE: 'reaches only its own vendor service',
  /**
   * Verified against the installed CLI (`pi --help`, its `docs/models.md`): Pi
   * reaches a backend by `--provider <name>` / `--model provider/id` plus that
   * provider's env key, and a CUSTOM endpoint only through
   * `~/.pi/agent/models.json`, a user-owned file PortOS does not write. So a
   * Pi route can be materialized for any service Pi ships a provider name for
   * (`piProvider` on the definition) — nvidia, openrouter, anthropic, … — but
   * not for an arbitrary local daemon or endpoint.
   */
  PI_BUILTIN_PROVIDERS: 'reaches only the services Pi ships a provider name for (a custom endpoint lives in Pi\'s own models.json, which PortOS does not write)',
});

/**
 * A recipe for a program that only ever talks to the service it signs into:
 * its argv is real (lifted from the shipped samples like every other recipe)
 * but it has no endpoint or credential column to materialize.
 */
const subscriptionRecipe = (command, { cli, tui }) => Object.freeze({
  command,
  timeout: HARNESS_TIMEOUT_MS,
  baseUrl: null,
  credential: null,
  modes: {
    cli: { args: cli, headlessArgs: [] },
    tui: { args: tui, tuiPromptDelayMs: TUI_PROMPT_DELAY_MS },
  },
});

/**
 * The COMMAND RECIPE half of a harness row (#6369).
 *
 * Everything above classifies a provider record that already exists. A recipe
 * answers the opposite question — **how do you spawn a fresh one?** — which is
 * what minting a new executable route for a connection needs and what this
 * registry could not describe before.
 *
 * Each recipe is the shipped, proven configuration for that program, lifted
 * from its `defaults/providers.sample.json` entry rather than invented here;
 * `providerRouteRecipes.sampleParity.test.js` fails when the two drift, so a
 * minted route can never quietly become one the harness will not run.
 *
 * Columns:
 *
 *   - `command` / `modes[mode]` — the binary and its per-mode argv. `cli`
 *     carries `headlessArgs`, `tui` carries `tuiPromptDelayMs`; neither is
 *     meaningful for the other mode, so neither is declared for it.
 *   - `baseUrl` — where a connection's endpoint lands on the record:
 *     `{ via: 'env', name }` an environment variable, `{ via: 'field' }` the
 *     record's own `endpoint`, or `{ via: 'opencodeConfig' }` the inline
 *     provider JSON OpenCode reads.
 *   - `credential` — the key the connection must carry for this program, and
 *     whether it REFUSES to start without one. Claude Code does (it sends an
 *     Anthropic auth token even to a local daemon that ignores it), which is why
 *     the create endpoint refuses rather than minting a route that cannot run.
 *
 * A harness with **no** recipe is not an oversight — it means this program has
 * no backend PortOS can point at from a connection, and its row says WHICH of
 * the {@link NO_RECIPE} reasons applies. Adding one of those stays `/ai/new`.
 */

/** Claude Code's headless argv, shared by every Claude recipe mode. */
const CLAUDE_HEADLESS_ARGS = Object.freeze(['--no-session-persistence', '--disable-slash-commands', '--tools', '']);

/** The delay a TUI harness needs before its first prompt, matching every shipped TUI sample. */
const TUI_PROMPT_DELAY_MS = 2500;

/** A local agent run is long; every shipped CLI/TUI sample uses this timeout. */
const HARNESS_TIMEOUT_MS = 600000;

/**
 * The CAPABILITY BINDINGS of a harness row (#7562): one entry per way the
 * program can be pointed at a service definition (`serviceDefinitions.js`).
 * `compatibleBindings` matches them against a resolved service instance, and
 * `materializeRoute` (`providerRouteRecipes.js`) writes the record each one
 * describes. Shapes (frozen; a new shape is a new writer arm, not a new field):
 *
 *   - `{ via: 'subscription', service }` — the harness signs in itself; the
 *     record carries no endpoint and no key.
 *   - `{ protocol, baseUrl, credential }` — any service declaring `protocol`
 *     as a transport. `baseUrl.via` is `env` (`name`), `field` (the record's
 *     own `endpoint`) or `opencodeConfig` (the inline provider JSON OpenCode
 *     reads). `credential.via` is `env` (`name`, `required`), `field` (the
 *     record's `apiKey`) or `gatewayEnv` (the gateway's own key var).
 *   - `{ service, env, credential }` — a named service reached through a static
 *     env switch (Bedrock: `CLAUDE_CODE_USE_BEDROCK=1`).
 *   - `{ service, baseUrl: { via: 'opencodeConfig', builtin: true }, credential }`
 *     — a service OpenCode already knows; only permissions are declared.
 *   - `{ via: 'codexOss', localRuntime: [...], protocol, baseUrl, credential }`
 *     — Codex's `--oss --local-provider` (≥ `CODEX_OSS_MIN_VERSION`), emitted
 *     at spawn from the runtime marker the record carries; the endpoint lands
 *     on the record like any protocol binding's.
 *   - `{ via: 'piProvider', credential }` — any service carrying `piProvider`,
 *     selected with `--provider <name>` and keyed from the service's own env var.
 *
 * A row with NO bindings is exactly a row with `noRecipe`: the program cannot
 * be pointed at anything from data. `providerHarnesses.test.js` pins that.
 */

/** The one direct-API binding: PortOS's HTTP client on any OpenAI-compatible service. */
const DIRECT_API_BINDING = Object.freeze({
  protocol: 'openai',
  baseUrl: Object.freeze({ via: 'field' }),
  credential: Object.freeze({ via: 'field', required: false }),
});

/** The credential Claude Code sends: required even to a daemon that ignores it. */
const CLAUDE_AUTH_TOKEN = Object.freeze({ via: 'env', name: 'ANTHROPIC_AUTH_TOKEN', required: true });

/** Pi's argv for the two modes, lifted from the shipped `pi-cli` / `pi-tui` samples. */
const PI_TUI_ARGS = Object.freeze(['--approve']);

/**
 * @type {readonly {id:string,label:string,modes:readonly string[],protocol:string,recipe:object|null,bindings:readonly object[],matches:(p:object)=>boolean}[]}
 */
export const PROVIDER_HARNESSES = Object.freeze([
  Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    modes: CLI_TUI_MODES,
    protocol: 'anthropic',
    recipe: Object.freeze({
      command: 'claude',
      timeout: HARNESS_TIMEOUT_MS,
      baseUrl: { via: 'env', name: 'ANTHROPIC_BASE_URL' },
      // Claude Code will not start without a token, even against a local daemon
      // that ignores it — so a backend carrying none cannot mint a Claude route.
      credential: CLAUDE_AUTH_TOKEN,
      modes: {
        cli: { args: ['--print'], headlessArgs: CLAUDE_HEADLESS_ARGS },
        tui: { args: ['--dangerously-skip-permissions'], tuiPromptDelayMs: TUI_PROMPT_DELAY_MS },
      },
    }),
    bindings: Object.freeze([
      Object.freeze({ via: 'subscription', service: 'claude-subscription' }),
      Object.freeze({ protocol: 'anthropic', baseUrl: Object.freeze({ via: 'env', name: 'ANTHROPIC_BASE_URL' }), credential: CLAUDE_AUTH_TOKEN }),
      Object.freeze({
        service: 'bedrock',
        env: Object.freeze({ CLAUDE_CODE_USE_BEDROCK: '1' }),
        credential: Object.freeze({ via: 'env', name: 'AWS_BEARER_TOKEN_BEDROCK', required: true }),
      }),
    ]),
    matches: isClaudeProvider,
  }),
  Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    modes: CLI_TUI_MODES,
    protocol: 'openai',
    recipe: Object.freeze({
      command: 'opencode',
      timeout: HARNESS_TIMEOUT_MS,
      // OpenCode reads its backend out of an inline provider JSON rather than an
      // environment variable, which is also why that string stays route-owned.
      baseUrl: { via: 'opencodeConfig' },
      credential: { via: 'field', required: false },
      modes: {
        cli: { args: ['run'], headlessArgs: [] },
        tui: { args: [], tuiPromptDelayMs: TUI_PROMPT_DELAY_MS },
      },
    }),
    bindings: Object.freeze([
      // OpenCode's own hosted service is a provider it ships; only permissions
      // go in the inline config, and the key rides its documented env var.
      Object.freeze({
        service: 'opencode-zen',
        baseUrl: Object.freeze({ via: 'opencodeConfig', builtin: true }),
        credential: Object.freeze({ via: 'env', name: 'OPENCODE_API_KEY', required: true }),
      }),
      // A gateway's key is materialized under the gateway's own variable (what
      // the spawner exports for OpenCode); anything else keys off the record.
      Object.freeze({ protocol: 'openai', baseUrl: Object.freeze({ via: 'opencodeConfig' }), credential: Object.freeze({ via: 'gatewayEnv', required: false }) }),
    ]),
    matches: isOpencodeProvider,
  }),
  Object.freeze({
    id: 'kilo',
    label: 'Kilo Code',
    modes: CLI_TUI_MODES,
    protocol: 'openai',
    // Kilo is an OpenCode fork, so its backend is declared in a config file
    // rather than an environment variable — and PortOS has not verified which
    // config surface this fork reads (OpenCode's own `OPENCODE_CONFIG_CONTENT`
    // is the one PortOS writes, and Kilo renames its environment under
    // `KILO_*`). Minting a route on a guess would produce one that points at
    // nothing while reporting a backend, so Kilo stays classifiable and
    // installable but not creatable from a connection.
    recipe: null,
    noRecipe: NO_RECIPE.UNWRITTEN_CONFIG,
    bindings: Object.freeze([]),
    matches: isKiloProvider,
  }),
  Object.freeze({
    id: 'openchamber',
    label: 'OpenChamber',
    modes: CLI_ONLY_MODES,
    protocol: 'openai',
    // OpenChamber is a control plane in front of a runtime the USER starts and
    // configures (its providers are signed in through its own web UI), so there
    // is no PortOS-supplied backend for a minted route to carry.
    recipe: null,
    noRecipe: NO_RECIPE.EXTERNAL_RUNTIME,
    bindings: Object.freeze([]),
    matches: isOpenchamberProvider,
  }),
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    modes: CLI_TUI_MODES,
    protocol: 'openai',
    recipe: Object.freeze({
      command: 'codex',
      timeout: HARNESS_TIMEOUT_MS,
      baseUrl: { via: 'field' },
      credential: { via: 'field', required: false },
      modes: {
        cli: { args: [], headlessArgs: [] },
        tui: { args: [], tuiPromptDelayMs: TUI_PROMPT_DELAY_MS },
      },
    }),
    bindings: Object.freeze([
      Object.freeze({ via: 'subscription', service: 'codex-subscription' }),
      // `--oss --local-provider <ollama|lmstudio>` is emitted at spawn from the
      // record's runtime marker (`buildCodexOssArgs`), so the binding only has
      // to name the runtimes Codex can serve — the same pair as
      // `CODEX_OSS_LOCAL_PROVIDERS`, pinned by providerHarnesses.test.js.
      Object.freeze({
        via: 'codexOss',
        localRuntime: Object.freeze(['ollama', 'lmstudio']),
        protocol: 'openai',
        baseUrl: Object.freeze({ via: 'field' }),
        credential: Object.freeze({ via: 'field', required: false }),
      }),
      Object.freeze({ protocol: 'openai', baseUrl: Object.freeze({ via: 'env', name: 'OPENAI_BASE_URL' }), credential: Object.freeze({ via: 'env', name: 'OPENAI_API_KEY', required: true }) }),
    ]),
    matches: isCodexProvider,
  }),
  Object.freeze({
    id: 'antigravity',
    label: 'Antigravity',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    recipe: subscriptionRecipe('agy', { cli: ['--print', '--dangerously-skip-permissions'], tui: ['--dangerously-skip-permissions'] }),
    connectionLimit: CONNECTION_LIMIT.VENDOR_SERVICE,
    bindings: Object.freeze([Object.freeze({ via: 'subscription', service: 'antigravity' })]),
    matches: isAntigravityProvider,
  }),
  Object.freeze({
    id: 'cursor',
    label: 'Cursor Agent',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    recipe: subscriptionRecipe('cursor-agent', { cli: ['--print', '--force'], tui: ['--force'] }),
    connectionLimit: CONNECTION_LIMIT.VENDOR_SERVICE,
    bindings: Object.freeze([Object.freeze({ via: 'subscription', service: 'cursor' })]),
    matches: isCursorProvider,
  }),
  Object.freeze({
    id: 'grok',
    label: 'Grok',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    recipe: subscriptionRecipe('grok', { cli: [], tui: [] }),
    connectionLimit: CONNECTION_LIMIT.VENDOR_SERVICE,
    bindings: Object.freeze([Object.freeze({ via: 'subscription', service: 'grok-build' })]),
    matches: isGrokProvider,
  }),
  Object.freeze({
    id: 'kimi',
    label: 'Kimi Code',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    recipe: subscriptionRecipe('kimi', { cli: [], tui: ['--yolo'] }),
    connectionLimit: CONNECTION_LIMIT.VENDOR_SERVICE,
    bindings: Object.freeze([Object.freeze({ via: 'subscription', service: 'kimi' })]),
    matches: isKimiProvider,
  }),
  Object.freeze({
    id: 'pi',
    label: 'Pi',
    modes: CLI_TUI_MODES,
    // Pi speaks both wires; `openai` is what a bare record classifies as, and
    // the binding below is what says which one a given service gets.
    protocol: 'openai',
    recipe: Object.freeze({
      command: 'pi',
      timeout: HARNESS_TIMEOUT_MS,
      // Pi selects its backend by provider NAME, not by URL — see
      // CONNECTION_LIMIT.PI_BUILTIN_PROVIDERS. The flag is appended to the mode
      // argv by the writer, so the shipped sample argv stays the prefix.
      baseUrl: { via: 'piProvider', flag: '--provider' },
      credential: { via: 'env', required: true },
      modes: {
        cli: { args: ['--print', ...PI_TUI_ARGS], headlessArgs: [] },
        tui: { args: [...PI_TUI_ARGS] },
      },
    }),
    connectionLimit: CONNECTION_LIMIT.PI_BUILTIN_PROVIDERS,
    bindings: Object.freeze([
      Object.freeze({ via: 'piProvider', credential: Object.freeze({ via: 'env', required: true }) }),
    ]),
    // No `isPiProvider` predicate exists — `pi` has no vendor module of its own
    // beyond `aiToolkit/internal/pi.js`, so match its binary basename directly.
    matches: (provider) => commandBasename(provider?.command) === 'pi',
  }),
  Object.freeze({
    id: 'direct',
    label: 'Direct API',
    modes: API_ONLY_MODES,
    protocol: 'openai',
    // Not a program: nothing to spawn, so no command recipe — and no
    // `noRecipe` either, because it CAN be pointed at a service.
    recipe: null,
    bindings: Object.freeze([DIRECT_API_BINDING]),
    matches: (provider) => provider?.type === 'api',
  }),
]);

/** The harness id a direct API record resolves to. */
export const DIRECT_HARNESS_ID = 'direct';

/**
 * The graph stores a direct API binding as `harness_id = NULL` (nullable
 * column, partial unique index untouched); the registry names it `direct`.
 * These two are the only translation between the two vocabularies.
 */
export const normalizeHarnessId = (harnessId) => harnessId ?? DIRECT_HARNESS_ID;
export const graphHarnessId = (harnessId) => (harnessId === DIRECT_HARNESS_ID ? null : harnessId ?? null);

/** Every harness id, for schemas that must accept only a real harness. */
export const PROVIDER_HARNESS_IDS = Object.freeze(PROVIDER_HARNESSES.map((h) => h.id));

/** The registry row for a harness id, or `null` for anything else. */
export const harnessById = (id) => PROVIDER_HARNESSES.find((h) => h.id === id) || null;

/**
 * The harnesses a fresh route can be MINTED for — the ones carrying a command
 * recipe. Everything else stays classifiable but not creatable, which is a
 * property of the program, not a gap in this table.
 */
export const CREATABLE_HARNESS_IDS = Object.freeze(
  PROVIDER_HARNESSES.filter((h) => h.recipe && !h.connectionLimit).map((h) => h.id),
);

/**
 * Why `harnessId` cannot be minted from a bare connection, or `null` when it
 * can. A row with no recipe says so through `noRecipe`; Pi has a recipe but a
 * backend it can only name, not address (`connectionLimit`).
 */
export const harnessConnectionBlocker = (harnessId) => {
  const harness = harnessById(harnessId);
  return harness?.noRecipe || harness?.connectionLimit || null;
};

/** The command recipe for a harness id, or `null` when it has none. */
export const harnessRecipe = (id) => harnessById(id)?.recipe || null;

/**
 * The harness a provider record is driven by, or `null` for an UNKNOWN one.
 *
 * An `api`-type record resolves to the `direct` row (#7562); it used to be
 * `null`, which conflated "no program" with "a program this build does not
 * know" — a `cli`/`tui` record with no matching row, which must stay an
 * unlinked legacy route. Graph code that stores the id passes it through
 * {@link graphHarnessId} so a direct binding still lands as `NULL`.
 *
 * @param {{id?:string, type?:string, command?:string}|null|undefined} provider
 * @returns {{id:string,label:string,modes:readonly string[],protocol:string}|null}
 */
export function harnessForProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  return PROVIDER_HARNESSES.find((h) => h.matches(provider)) || null;
}

/**
 * The bindings of `harness` that can reach `serviceInstance` (a resolved
 * instance from `resolveServiceInstance`), in row order — the first is the one
 * `materializeRoute` writes. Empty when the pair cannot be composed.
 *
 * Matching rules, one per binding shape: a `subscription` / `service` binding
 * matches by definition id; a `protocol` binding matches when the instance
 * declares that transport; a `codexOss` binding matches the instance's local
 * runtime; a `piProvider` binding matches a definition Pi ships a name for. A
 * definition that is `harnessOnly` matches nothing but that harness.
 *
 * @param {object|string} harness - a registry row or its id
 * @param {{definition: object, transports: object}} serviceInstance
 * @returns {readonly object[]}
 */
export function compatibleBindings(harness, serviceInstance) {
  const row = typeof harness === 'string' ? harnessById(harness) : harness;
  const definition = serviceInstance?.definition;
  if (!row || !definition) return [];
  if (definition.harnessOnly && definition.harnessOnly !== row.id) return [];
  const declares = (protocol) => Boolean(serviceInstance.transports?.[protocol]);
  return row.bindings.filter((binding) => {
    if (binding.service) return binding.service === definition.id;
    if (binding.via === 'codexOss') return binding.localRuntime.includes(definition.localRuntime) && declares(binding.protocol);
    if (binding.via === 'piProvider') return typeof definition.piProvider === 'string';
    return Boolean(binding.protocol) && declares(binding.protocol);
  });
}

/** Whether `harness` can be pointed at `serviceInstance` at all. */
export const isCompatible = (harness, serviceInstance) => compatibleBindings(harness, serviceInstance).length > 0;

/** Whether `harnessId` can be driven in `mode`. Unknown harness → false. */
export const harnessSupportsMode = (harnessId, mode) =>
  Boolean(harnessById(harnessId)?.modes.includes(mode));

/**
 * The route mode a provider record executes in, or `null` when its `type` is
 * not one PortOS can execute. Never inferred from a name or command — the
 * record's own `type` is the execution contract.
 */
export const providerRouteMode = (provider) =>
  ROUTE_MODES.includes(provider?.type) ? provider.type : null;

/**
 * The string this provider's harness actually accepts for a canonical backend
 * model name — today only OpenCode needs one (its `<namespace>/<model>` form).
 *
 * Delegates to `prefixOpencodeModel`, the same adapter the spawner uses, so the
 * preview can never disagree with what a run would really send.
 */
export const toExecutableModelName = (provider, canonicalModel) =>
  prefixOpencodeModel(provider, canonicalModel);

/**
 * The inverse adapter: the canonical backend name behind a STORED model string.
 *
 * Import must never rewrite a saved model string by heuristically stripping a
 * prefix, so this is verified rather than guessed — a candidate is accepted
 * only when {@link toExecutableModelName} maps it back to the exact stored
 * string. A stored string that no candidate reproduces is left untouched and
 * reported, so it stays a visible unresolved alias instead of silently becoming
 * a model the harness cannot serve.
 *
 * @param {object} provider
 * @param {string} stored - the model string as saved on the provider record
 * @returns {{canonical:string, executable:string, resolved:boolean, reason:string|null}}
 */
export function toCanonicalModelName(provider, stored) {
  const unresolved = { canonical: stored, executable: stored, resolved: false, reason: 'unmappable-model-alias' };
  if (typeof stored !== 'string' || stored === '') return unresolved;

  const namespace = getOpencodeLocalProviderNamespace(provider);
  const stripped = namespace && stored.startsWith(`${namespace}/`)
    ? stored.slice(namespace.length + 1)
    : null;

  // Shortest-first: a namespaced string canonicalizes to its bare id, and an
  // already-canonical string round-trips to itself.
  for (const candidate of [stripped, stored]) {
    if (candidate && toExecutableModelName(provider, candidate) === stored) {
      return { canonical: candidate, executable: stored, resolved: true, reason: null };
    }
  }
  return unresolved;
}
