import { commandBasename } from './commandBasename.js';
import { usesThirdPartyBackend } from './claudeCodeCatalog.js';
/**
 * The single per-vendor table behind model refresh.
 *
 * Adding a vendor is one row here; the capability rides to the client on the
 * payload as `canRefreshModels`. The columns are the keying conventions:
 *
 * - `cliMatch`   — the STRONG identity signal for a `cli` provider: the launch
 *                  command (path/exe-tolerant for vendors whose users configure
 *                  an absolute path), or a structural marker (`ollamaBacked`).
 * - `cliNameMatch` — the WEAK signal: a substring of the user-editable DISPLAY
 *                  NAME, consulted only once no row has claimed the provider by
 *                  command. A vendor whose word is ordinary English (cursor)
 *                  deliberately has NO name column, or a provider named
 *                  "Cursor Notes" would hijack the refresh.
 * - `tuiMatch`   — only vendors whose `--model` flag also applies to the
 *                  interactive session carry this. Never consults the display
 *                  name; an EXACT shipped-id match is the only non-command signal.
 * - `fetch`      — the provider-service method name that performs the probe
 *                  (a string, so this stays a pure data module).
 */
import { ANTIGRAVITY_TUI_ID, isAntigravityCommand } from './antigravity.js';
import { CURSOR_TUI_ID, isCursorCommand } from './cursor.js';
import { CODEX_TUI_ID, isCodexCommand } from './codex.js';
import { isOllamaBackedProvider, ollamaBaseFromProvider } from './ollamaBacked.js';
import { isGatewayBackedProvider } from './gateways.js';
import { LOCAL_RUNTIME_MARKERS } from './localRuntimeMarkers.js';

const displayName = (provider) => String(provider?.name || '').toLowerCase();

/**
 * One row per non-Ollama local runtime, in registry order, so a new runtime registers here by
 * adding a `localRuntimeMarkers.js` row. Each probes its OpenAI-compatible `/v1/models` endpoint
 * rather than `opencode models` / `codex` (which would inventory the harness); Splash alone
 * normalizes the endpoint root first. Auth varies by runtime and is the record's `apiKey` (vLLM
 * answers only with the compose stack's key sent as Bearer; LM Studio and SGLang usually have none).
 */
const LOCAL_RUNTIME_FETCHER_ROWS = Object.entries(LOCAL_RUNTIME_MARKERS)
  .filter(([id]) => id !== 'ollama')
  .map(([id, marker]) => ({
    key: id,
    cliMatch: (p) => p?.[marker] === true,
    tuiMatch: (p) => p?.[marker] === true,
    fetch: id === 'splash' ? '_fetchSplashModels' : '_fetchOpenAiCompatibleModels',
  }));

/**
 * Ordered vendor rows. Order is load-bearing in one place: the ollama row
 * must come first, so a `claude` CLI pointed at a local Ollama daemon pulls the
 * installed (tool-use-capable) Ollama models, not the static Anthropic list.
 * The name pass runs in table order (claude, antigravity, gemini).
 */
export const MODEL_FETCHERS = [
  {
    key: 'ollama',
    // Not a command test (marker may be `ollamaBacked`, an id, or ANTHROPIC_BASE_URL), but still STRONG.
    cliMatch: (p) => isOllamaBackedProvider(p),
    tuiMatch: (p) => isOllamaBackedProvider(p),
    fetch: '_fetchOllamaToolCapableModels',
  },
  ...LOCAL_RUNTIME_FETCHER_ROWS,
  {
    key: 'gateway',
    // Gateway-backed OpenCode wrappers (see ./gateways.js) probe their sibling
    // API provider's `/models`, never `opencode models`. One row for every gateway.
    cliMatch: isGatewayBackedProvider,
    tuiMatch: isGatewayBackedProvider,
    fetch: '_fetchGatewayModels',
  },
  {
    key: 'pi', cliMatch: (p) => commandBasename(p?.command) === 'pi',
    tuiMatch: (p) => commandBasename(p?.command) === 'pi', fetch: '_fetchPiModels',
  },
  {
    key: 'cursor',
    // No `cliNameMatch` on purpose (see column notes).
    cliMatch: (p) => isCursorCommand(p?.command),
    tuiMatch: (p) => p?.id === CURSOR_TUI_ID || isCursorCommand(p?.command),
    fetch: '_fetchCursorModels',
  },
  {
    key: 'codex',
    cliMatch: (p) => isCodexCommand(p?.command),
    cliNameMatch: (p) => displayName(p).includes('codex'),
    tuiMatch: (p) => p?.id === CODEX_TUI_ID || isCodexCommand(p?.command),
    fetch: '_fetchCodexModels',
  },
  {
    key: 'claude',
    // Raw-string equality, NOT a basename: `_fetchAnthropicModels` reads the
    // catalog the installed Claude Code caches in `~/.claude`, so a
    // differently-named binary would be answered for by whichever `claude` owns it.
    cliMatch: (p) => p?.command === 'claude' && !usesThirdPartyBackend(p),
    tuiMatch: (p) => p?.command === 'claude' && !usesThirdPartyBackend(p),
    cliNameMatch: (p) => displayName(p).includes('claude') && !usesThirdPartyBackend(p),
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
 * claims it (never throws; the caller owns the 400).
 *
 * `api` providers are NOT resolved here (they use `_refreshAPIProviderModels`);
 * {@link canRefreshModels} spans both. The CLI arm runs the command pass to
 * exhaustion BEFORE the name pass: an exact command match outranks a name substring.
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
 * Pure. DERIVED ON READ and never stored: `saveProviders` must never see it, or
 * it goes stale when a user repoints a provider's command. `table` is
 * injectable for tests only.
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
 * Decorate one provider (nullish passes through) with the derived
 * `canRefreshModels` flag. Returns a COPY: the input may be the live cached
 * record `saveProviders` writes to disk.
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

/**
 * Stable key grouping providers whose model refresh issues the IDENTICAL probe
 * against the same Ollama daemon — or `null` when the provider's refresh isn't
 * an Ollama probe at all (refresh it on its own).
 *
 * Several providers commonly resolve to ONE daemon; grouping on this key lets a
 * caller fetch once (`/api/tags` plus the per-model `/api/show` probe) and apply
 * the answer to every member.
 *
 * `null` is a sentinel, NOT "no group": refresh that provider individually.
 *
 * Two probe shapes keep SEPARATE key namespaces because they return different
 * lists for the same daemon:
 * - `api:` — short-circuits to `${endpoint}/api/tags` and persists the UNFILTERED list.
 * - `tools:` — `_fetchOllamaToolCapableModels`, filtered to tool-use-capable models.
 * Collapsing them would persist a wrong list (a Claude harness that cannot edit files).
 *
 * @param {object|null|undefined} provider
 * @param {Array} [table]
 * @returns {string|null}
 */
export function ollamaRefreshGroupKey(provider, table = MODEL_FETCHERS) {
  if (!provider) return null;
  if (provider.type === 'api') {
    // Mirrors the short-circuit in `_refreshAPIProviderModels`. A key makes the
    // provider ungroupable: a miss falls through to a `/models` fetch carrying
    // `apiKey`, so different keys on one endpoint can see different catalogs.
    if (provider.apiKey) return null;
    const endpoint = String(provider.endpoint || '');
    if (!endpoint.includes('ollama') && !endpoint.includes(':11434')) return null;
    // Only a trailing slash is normalized, NOT `/v1` (unlike `ollamaBaseFromProvider`):
    // the api arm probes the endpoint verbatim, so `…:11434` and `…:11434/v1` are
    // different requests.
    return `api:${endpoint.replace(/\/+$/, '')}`;
  }
  return resolveModelFetcher(provider, table)?.key === 'ollama'
    ? `tools:${ollamaBaseFromProvider(provider)}`
    : null;
}
