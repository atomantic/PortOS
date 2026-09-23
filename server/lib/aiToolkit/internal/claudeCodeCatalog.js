/**
 * Read the model catalog Claude Code itself caches, so a `claude` provider's
 * **Refresh Models** stops re-serving a hand-maintained list.
 *
 * Unlike every other vendor here, the `claude` binary ships NO `models`
 * subcommand — `claude --help` has `--model <model>` and nothing that prints
 * the catalog, and an unknown id is rejected with prose ("isn't described by
 * this version's model catalog"), not an enumeration. So there is no
 * `_execCliModelList` probe to write.
 *
 * What the binary DOES do is fetch the picker catalog for this account from
 * `/api/model_selector/<surface>` (claude.ai OAuth) and cache the response at
 * `<configDir>/cache/model-catalog/<key>.json`. That file is the authoritative
 * answer to the question the provider card is actually asking — which models
 * THIS user's plan and THIS installed CLI version can select — and reading it
 * costs no network call, no API key, and no child process. The endpoint itself
 * is internal and unversioned; the cache file carries its own `version` and is
 * gated on it below, so a shape change reads as "no catalog" rather than as a
 * silently wrong list.
 *
 * NOT a substitute for the first-party Models API (`GET /v1/models`): that one
 * is documented and stable but needs an `ANTHROPIC_API_KEY`, which a
 * subscription-auth CLI provider does not have. A `type: 'api'` Anthropic
 * record with a key still goes through `_refreshAPIProviderModels`.
 *
 * Pure by design (the fs read lives in `providers.js` with the rest of this
 * directory's I/O) and self-contained — no imports out to other PortOS modules,
 * see ../AGENTS.md.
 */

/** The surface id Claude Code fetches its own picker catalog under. */
export const CLAUDE_CODE_SURFACE = 'cc';

/** `<configDir>/cache/model-catalog` — the directory the CLI writes into. */
export const CLAUDE_CATALOG_SUBPATH = Object.freeze(['cache', 'model-catalog']);

/**
 * The config directory the installed CLI reads, honoring the same
 * `CLAUDE_CONFIG_DIR` override the binary does. Returns `null` when neither a
 * override nor a home directory is known, so the caller skips the read rather
 * than probing `/undefined/.claude`.
 */
export function claudeConfigDir(env = {}, home = '') {
  const override = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (override) return override;
  return home ? `${home}/.claude` : null;
}

/**
 * Compare two dotted version strings numerically, the way the CLI's own
 * `min_claude_code_version` gate does. Returns true when `version` is at least
 * `minimum`. A missing or unparseable `minimum` means "no floor" — the catalog
 * omits the key for models every supported version can select.
 */
export function versionAtLeast(version, minimum) {
  if (!minimum) return true;
  const parts = (value) => String(value || '').split('.').map((part) => Number.parseInt(part, 10));
  const have = parts(version);
  const need = parts(minimum);
  // An unreadable INSTALLED version must not hide models. The floor exists to
  // stop offering an id the binary would reject; with no version to compare we
  // cannot answer that, and dropping the whole catalog is the worse error.
  if (!Number.isFinite(have[0])) return true;
  for (let i = 0; i < Math.max(have.length, need.length); i += 1) {
    const a = Number.isFinite(have[i]) ? have[i] : 0;
    const b = Number.isFinite(need[i]) ? need[i] : 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Whether a parsed cache file is a Claude Code catalog this module understands.
 * `version` is the file's OWN schema marker (2 at time of writing) — gate on it
 * so a future rewrite degrades to "no catalog found" instead of feeding a
 * changed shape through the accessors below.
 */
const SUPPORTED_CACHE_VERSIONS = Object.freeze([2]);

export function isSupportedCatalog(parsed, surface = CLAUDE_CODE_SURFACE) {
  return Boolean(
    parsed
    && typeof parsed === 'object'
    && SUPPORTED_CACHE_VERSIONS.includes(parsed.version)
    && parsed.catalog?.surface === surface
    && Array.isArray(parsed.catalog?.config?.models),
  );
}

/**
 * The one entry both accessors below answer from: the freshest cache file that
 * parses as a catalog for `surface`. Shared rather than restated, because
 * `catalogAge` reports the age OF the entry `selectCatalogModels` read — two
 * copies of this filter-and-sort could drift and make the logged timestamp
 * describe a different file than the ids.
 */
function freshestCatalog(entries, surface) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => isSupportedCatalog(entry, surface))
    .sort((a, b) => (Number(b.fetchedAt) || 0) - (Number(a.fetchedAt) || 0))[0] || null;
}

/**
 * Pick the model ids out of the cache files the caller read.
 *
 * `entries` is every parsed `<configDir>/cache/model-catalog/*.json`. There can
 * legitimately be several — one per account the user has signed in as, and one
 * per surface — so the FRESHEST supported `cc` entry wins rather than the first
 * one `readdir` happened to return. `fetchedAt` is the CLI's own stamp.
 *
 * Returns `[]` when nothing usable was found; the caller decides whether that
 * is an error (it is — see `_fetchAnthropicModels`) so this stays pure.
 *
 * Ordering is the catalog's own, which is the picker's order: `main` models
 * first, then `overflow`. That makes the provider card's first option the same
 * model `claude` would default to, so a refresh does not silently re-point a
 * record at a retired id.
 */
export function selectCatalogModels(entries, {
  cliVersion = '',
  surface = CLAUDE_CODE_SURFACE,
  applyVersionFloor = true,
} = {}) {
  const freshest = freshestCatalog(entries, surface);
  if (!freshest) return [];

  const ids = freshest.catalog.config.models
    .filter((model) => model && typeof model.id === 'string' && model.id)
    // A model the INSTALLED binary is too old to select would be persisted into
    // the record's picker and then rejected at spawn time with the CLI's own
    // "isn't described by this version's model catalog" prose. The catalog
    // declares that floor per model; honor it. Callers that need to tell "the
    // cache has ids" from "this binary can select none of them" pass
    // `applyVersionFloor: false`.
    .filter((model) => !applyVersionFloor || versionAtLeast(cliVersion, model.min_claude_code_version))
    .map((model) => model.id);

  return [...new Set(ids)];
}

/**
 * How stale the chosen catalog is, for the caller's log line. The CLI refreshes
 * on its own schedule whenever a session runs; PortOS never writes this file.
 */
export function catalogAge(entries, { surface = CLAUDE_CODE_SURFACE } = {}) {
  const freshest = freshestCatalog(entries, surface);
  return freshest ? Number(freshest.fetchedAt) || null : null;
}

/**
 * Env markers that point the `claude` binary at a third-party backend instead
 * of the first-party subscription/API endpoint. Taken from the binary's own
 * `CLAUDE_CODE_USE_*` set; `ANTHROPIC_AWS` / `ANTHROPIC_GOOGLE_CLOUD` are the
 * Claude-Platform variants of the same choice.
 *
 * Such a record's models are namespaced by its backend
 * (`global.anthropic.claude-opus-5`, `claude-opus-4-5@20251101`), and the
 * catalog this module reads holds only first-party ids — the CLI never fetches
 * the picker catalog when it is not talking to claude.ai. Answering a refresh
 * with the first-party list would overwrite a Bedrock record's real ids with
 * ones its endpoint rejects, and strand its own `defaultModel` outside its
 * model list. So these records resolve to NO fetcher: the card offers no
 * Refresh button and its stored catalog stands. See PortOS issue #8034.
 */
const THIRD_PARTY_BACKEND_VARS = Object.freeze([
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
]);

/**
 * Truthy the way the CLI reads these: any set, non-empty value other than the
 * explicit off-switches. `"0"` / `"false"` are how an install disables a marker
 * it inherited, and must not count as "pointed at Bedrock".
 */
const envFlagEnabled = (value) => {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
};

export function usesThirdPartyBackend(provider, inheritedEnv = process.env) {
  const envVars = { ...inheritedEnv, ...(provider?.envVars || {}) };
  return THIRD_PARTY_BACKEND_VARS.some((name) => envFlagEnabled(envVars[name]));
}
