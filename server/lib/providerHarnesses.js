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
 * @type {readonly {id:string,label:string,modes:readonly string[],protocol:string,matches:(p:object)=>boolean}[]}
 */
export const PROVIDER_HARNESSES = Object.freeze([
  Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    modes: CLI_TUI_MODES,
    protocol: 'anthropic',
    matches: isClaudeProvider,
  }),
  Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    modes: CLI_TUI_MODES,
    protocol: 'openai',
    matches: isOpencodeProvider,
  }),
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    modes: CLI_TUI_MODES,
    protocol: 'openai',
    matches: isCodexProvider,
  }),
  Object.freeze({
    id: 'antigravity',
    label: 'Antigravity',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    matches: isAntigravityProvider,
  }),
  Object.freeze({
    id: 'cursor',
    label: 'Cursor Agent',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    matches: isCursorProvider,
  }),
  Object.freeze({
    id: 'grok',
    label: 'Grok',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    matches: isGrokProvider,
  }),
  Object.freeze({
    id: 'kimi',
    label: 'Kimi Code',
    modes: CLI_TUI_MODES,
    protocol: 'native',
    matches: isKimiProvider,
  }),
  Object.freeze({
    id: 'pi',
    label: 'Pi',
    modes: CLI_TUI_MODES,
    protocol: 'native',
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
