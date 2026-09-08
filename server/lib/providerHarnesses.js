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
 * driven in, which wire protocol it speaks to a backend connection, and how a
 * canonical backend model name becomes the string that program accepts.
 *
 * Rows match through the existing `is*Provider` predicates rather than a fresh
 * command-string test, so a path-configured binary, a `.exe`, and the shipped
 * ids all resolve the same way they already do everywhere else in PortOS.
 */

/** Execution modes a route can carry. Mirrors the provider record's `type`. */
export const ROUTE_MODES = Object.freeze(['cli', 'tui', 'api']);

/** Modes every CLI/TUI harness supports. Direct API bindings carry no harness. */
const CLI_TUI_MODES = Object.freeze(['cli', 'tui']);

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
 * A harness with **no** recipe is not an oversight: `native`-protocol programs
 * talk only to their own vendor service, so there is no user-supplied backend to
 * point one at. Adding one of those stays `/ai/new`.
 */

/** Claude Code's headless argv, shared by every Claude recipe mode. */
const CLAUDE_HEADLESS_ARGS = Object.freeze(['--no-session-persistence', '--disable-slash-commands', '--tools', '']);

/** The delay a TUI harness needs before its first prompt, matching every shipped TUI sample. */
const TUI_PROMPT_DELAY_MS = 2500;

/** A local agent run is long; every shipped CLI/TUI sample uses this timeout. */
const HARNESS_TIMEOUT_MS = 600000;

/**
 * @type {readonly {id:string,label:string,modes:readonly string[],protocol:string,recipe:object|null,matches:(p:object)=>boolean}[]}
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
      credential: { via: 'env', name: 'ANTHROPIC_AUTH_TOKEN', required: true },
      modes: {
        cli: { args: ['--print'], headlessArgs: CLAUDE_HEADLESS_ARGS },
        tui: { args: ['--dangerously-skip-permissions'], tuiPromptDelayMs: TUI_PROMPT_DELAY_MS },
      },
    }),
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
    matches: isOpencodeProvider,
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
    matches: isCodexProvider,
  }),
  Object.freeze({
    id: 'antigravity',
    label: 'Antigravity',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    // No recipe: this program reaches only its own vendor service, so
    // there is no connection to point a freshly minted route at.
    recipe: null,
    matches: isAntigravityProvider,
  }),
  Object.freeze({
    id: 'cursor',
    label: 'Cursor Agent',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    // No recipe: this program reaches only its own vendor service, so
    // there is no connection to point a freshly minted route at.
    recipe: null,
    matches: isCursorProvider,
  }),
  Object.freeze({
    id: 'grok',
    label: 'Grok',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    // No recipe: this program reaches only its own vendor service, so
    // there is no connection to point a freshly minted route at.
    recipe: null,
    matches: isGrokProvider,
  }),
  Object.freeze({
    id: 'kimi',
    label: 'Kimi Code',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    // No recipe: this program reaches only its own vendor service, so
    // there is no connection to point a freshly minted route at.
    recipe: null,
    matches: isKimiProvider,
  }),
  Object.freeze({
    id: 'pi',
    label: 'Pi',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    // No recipe: this program reaches only its own vendor service, so
    // there is no connection to point a freshly minted route at.
    recipe: null,
    // No `isPiProvider` predicate exists — `pi` has no vendor module of its own
    // beyond `aiToolkit/internal/pi.js`, so match its binary basename directly.
    matches: (provider) => commandBasename(provider?.command) === 'pi',
  }),
]);

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
  PROVIDER_HARNESSES.filter((h) => h.recipe).map((h) => h.id),
);

/** The command recipe for a harness id, or `null` when it has none. */
export const harnessRecipe = (id) => harnessById(id)?.recipe || null;

/**
 * The harness a provider record is driven by, or `null`.
 *
 * `null` has TWO distinct causes and the caller must not conflate them: an
 * `api`-type record legitimately has no harness (a direct API binding), while a
 * `cli`/`tui` record with no matching row is an UNKNOWN harness that must stay
 * an unlinked legacy route. Use {@link providerRouteMode} to tell them apart.
 *
 * @param {{id?:string, type?:string, command?:string}|null|undefined} provider
 * @returns {{id:string,label:string,modes:readonly string[],protocol:string}|null}
 */
export function harnessForProvider(provider) {
  if (!provider || typeof provider !== 'object' || provider.type === 'api') return null;
  return PROVIDER_HARNESSES.find((h) => h.matches(provider)) || null;
}

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
