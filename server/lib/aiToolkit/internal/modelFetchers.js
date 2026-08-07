/**
 * The single per-vendor table behind model refresh.
 *
 * Before this table, adding one vendor to the refresh feature meant four
 * coordinated hand edits: the TUI `else if` chain in `refreshProviderModels`,
 * the CLI `if` chain in `_refreshCLIProviderModels`, the client's
 * `supportsModelRefresh` mirror, and a SECOND transcription of the server
 * dispatch inside the client's parity test. Nothing structurally stopped the
 * next vendor from making three of the four. Now: one row here, and the
 * capability rides to the client on the payload as `canRefreshModels`.
 *
 * ## The columns are the keying conventions
 *
 * Vendors are not identified the same way, and the differences used to live in
 * prose above each branch. They are columns now:
 *
 * - `cliMatch`   — the STRONG identity signal for a `cli` provider: the launch
 *                  command (path/exe-tolerant for vendors whose users configure
 *                  an absolute path), or a structural marker (`ollamaBacked`).
 * - `cliNameMatch` — the WEAK signal: a substring of the user-editable DISPLAY
 *                  NAME. Only consulted once no row has claimed the provider by
 *                  command, so `name: 'Claude via Antigravity'` + `command:
 *                  'claude'` still reaches Anthropic — the right answer for a
 *                  claude binary. A vendor whose word is ordinary English
 *                  (cursor: a DB cursor, a text cursor) deliberately has NO
 *                  name column, or a provider a user named "Cursor Notes" would
 *                  hijack the refresh.
 * - `tuiMatch`   — a `tui` provider's model is normally fixed by its CLI/config,
 *                  so only the vendors whose `--model` flag also applies to the
 *                  interactive session carry this column. It never consults the
 *                  display name: unlike the CLI arm, an EXACT shipped-id match
 *                  is the only non-command signal it admits.
 * - `fetch`      — the provider-service method name that performs the probe.
 *                  Kept as a string so this table stays a pure data module with
 *                  no dependency on the service object it is dispatched from.
 *
 * Adding a vendor is one row. `modelFetchers.test.js` pins that by driving a
 * hypothetical vendor through the table rather than through a chain.
 */
import { ANTIGRAVITY_TUI_ID, isAntigravityCommand } from './antigravity.js';
import { CURSOR_TUI_ID, isCursorCommand } from './cursor.js';
import { isOllamaBackedProvider } from './ollamaBacked.js';

const displayName = (provider) => String(provider?.name || '').toLowerCase();

/**
 * Ordered vendor rows. Order is load-bearing in exactly one place: the
 * ollama row must come first, so a `claude` CLI pointed at a local Ollama
 * daemon pulls the installed (tool-use-capable) Ollama models instead of the
 * static Anthropic list. Every other `cliMatch` in the table is mutually
 * exclusive, and the name pass runs in table order (claude, antigravity,
 * gemini) exactly as the old chain did.
 */
export const MODEL_FETCHERS = [
  {
    key: 'ollama',
    // Not a command test: the marker can be `ollamaBacked`, an id, or an
    // ANTHROPIC_BASE_URL. Still a STRONG signal, so it sits in the first pass.
    cliMatch: (p) => isOllamaBackedProvider(p),
    tuiMatch: (p) => isOllamaBackedProvider(p),
    fetch: '_fetchOllamaToolCapableModels',
  },
  {
    key: 'cursor',
    // No `cliNameMatch` on purpose — see the column notes above.
    cliMatch: (p) => isCursorCommand(p?.command),
    tuiMatch: (p) => p?.id === CURSOR_TUI_ID || isCursorCommand(p?.command),
    fetch: '_fetchCursorModels',
  },
  {
    key: 'claude',
    // Raw-string equality, NOT a basename: `_fetchAnthropicModels` returns a
    // static list, so widening this to every binary named `claude` on disk is a
    // separate call from widening the vendors that probe their own CLI.
    cliMatch: (p) => p?.command === 'claude',
    cliNameMatch: (p) => displayName(p).includes('claude'),
    fetch: '_fetchAnthropicModels',
  },
  {
    key: 'antigravity',
    cliMatch: (p) => isAntigravityCommand(p?.command),
    cliNameMatch: (p) => displayName(p).includes('antigravity'),
    tuiMatch: (p) => p?.id === ANTIGRAVITY_TUI_ID || isAntigravityCommand(p?.command),
    fetch: '_fetchAntigravityModels',
  },
  {
    key: 'gemini',
    cliMatch: (p) => p?.command === 'gemini',
    cliNameMatch: (p) => displayName(p).includes('gemini'),
    fetch: '_fetchGeminiModels',
  },
];

/**
 * The row that will serve `provider`'s model refresh, or `null` when no vendor
 * claims it (the caller then throws its own 400 — this function never throws).
 *
 * `api` providers are deliberately NOT resolved here: they don't route through
 * the table at all, they go to the generic `_refreshAPIProviderModels`. Ask
 * {@link canRefreshModels} for the capability answer that spans both.
 *
 * The CLI arm runs the command pass to exhaustion BEFORE the name pass, which
 * is the generalization of the ordering the old chain had already grown case by
 * case ("an exact command match is a stronger identity signal than a name
 * substring, so it must win"). The one behavior this changes versus the old
 * chain: a provider named e.g. "Claude Opus" whose command is literally
 * `gemini` now reaches the gemini fetcher instead of having Anthropic's static
 * list persisted onto it. Which vendors are refreshable at all is unchanged —
 * the union of the two passes is the same set the chain matched.
 */
export function resolveModelFetcher(provider, table = MODEL_FETCHERS) {
  if (!provider) return null;
  if (provider.type === 'tui') {
    return table.find((f) => f.tuiMatch?.(provider)) || null;
  }
  if (provider.type === 'cli') {
    return table.find((f) => f.cliMatch?.(provider))
      || table.find((f) => f.cliNameMatch?.(provider))
      || null;
  }
  return null;
}

/**
 * Whether the server can refresh this provider's model list — i.e. whether
 * `POST /providers/:id/refresh-models` will answer rather than 400.
 *
 * Pure and side-effect free, so the route can decorate every provider payload
 * with it (as `canRefreshModels`) and the client can stop re-deriving the
 * answer from command/name string sniffing. It is DERIVED ON READ and never
 * stored: `saveProviders` must never see it, or it goes stale against this
 * table the first time a user repoints a provider's command.
 *
 * `table` is injectable for the "adding a vendor is exactly one row" test —
 * production callers always take the default.
 *
 * @param {{type?:string, id?:string, name?:string, command?:string}|null|undefined} provider
 * @param {Array} [table]
 * @returns {boolean}
 */
export function canRefreshModels(provider, table = MODEL_FETCHERS) {
  if (!provider) return false;
  // Every API provider routes to the generic `_refreshAPIProviderModels`.
  if (provider.type === 'api') return true;
  return resolveModelFetcher(provider, table) !== null;
}

/**
 * Decorate one provider (or a nullish miss, passed through untouched) with the
 * derived `canRefreshModels` flag. Returns a COPY — the caller's object, which
 * may be the live cached record `saveProviders` writes back to disk, is never
 * mutated.
 */
export function withRefreshCapability(provider) {
  if (!provider) return provider;
  return { ...provider, canRefreshModels: canRefreshModels(provider) };
}

/** Array form of {@link withRefreshCapability}. */
export function withRefreshCapabilityList(providers) {
  if (!Array.isArray(providers)) return providers;
  return providers.map(withRefreshCapability);
}
