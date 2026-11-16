/**
 * Read the model catalog Claude Code itself caches, so a `claude` provider's **Refresh Models** stops re-serving a
 * hand-maintained list.
 *
 * The `claude` binary has NO `models` subcommand, but it caches the picker catalog for this account (fetched from
 * `/api/model_selector/<surface>`) at `<configDir>/cache/model-catalog/<key>.json`: the authoritative answer for which
 * models THIS plan and CLI version can select, at no network/key/child-process cost. The endpoint is internal and
 * unversioned, so the file's own `version` gates it (a shape change reads as "no catalog", not a wrong list). NOT a
 * substitute for `GET /v1/models`, which needs an `ANTHROPIC_API_KEY` a subscription-auth provider lacks (`type: 'api'`
 * records still use `_refreshAPIProviderModels`). Pure (the fs read lives in `providerCatalogService.js`) and
 * self-contained: no imports out to other PortOS modules, see ../AGENTS.md.
 */

/** The surface id Claude Code fetches its own picker catalog under. */
export const CLAUDE_CODE_SURFACE = 'cc';

/** `<configDir>/cache/model-catalog` — the directory the CLI writes into. */
export const CLAUDE_CATALOG_SUBPATH = Object.freeze(['cache', 'model-catalog']);

/**
 * The config directory the installed CLI reads, honoring its `CLAUDE_CONFIG_DIR` override. `null` when neither an
 * override nor a home is known, so the caller skips the read rather than probing `/undefined/.claude`.
 */
export function claudeConfigDir(env = {}, home = '') {
  const override = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (override) return override;
  return home ? `${home}/.claude` : null;
}

/**
 * Compare dotted versions numerically like the CLI's `min_claude_code_version` gate: true when `version` >= `minimum`. A
 * missing `minimum` means "no floor".
 */
export function versionAtLeast(version, minimum) {
  if (!minimum) return true;
  const parts = (value) => String(value || '').split('.').map((part) => Number.parseInt(part, 10));
  const have = parts(version);
  const need = parts(minimum);
  // An unreadable INSTALLED version must not hide models: dropping the whole catalog is worse than offering a rejectable id.
  if (!Number.isFinite(have[0])) return true;
  for (let i = 0; i < Math.max(have.length, need.length); i += 1) {
    const a = Number.isFinite(have[i]) ? have[i] : 0;
    const b = Number.isFinite(need[i]) ? need[i] : 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Whether a parsed cache file is a catalog this module understands. `version` is the file's OWN schema marker (2 at time
 * of writing); gating on it degrades a future rewrite to "no catalog found".
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

// The one entry both accessors answer from; shared so `catalogAge` always describes the same file `selectCatalogModels` read.
function freshestCatalog(entries, surface) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => isSupportedCatalog(entry, surface))
    .sort((a, b) => (Number(b.fetchedAt) || 0) - (Number(a.fetchedAt) || 0))[0] || null;
}

/**
 * Pick the model ids out of the parsed cache files. Several may exist (one per signed-in account and surface), so the
 * FRESHEST supported `cc` entry (by the CLI's `fetchedAt`) wins, not whatever `readdir` returned first. Returns `[]` when
 * nothing is usable; the caller decides whether that is an error (see `_fetchAnthropicModels`).
 *
 * Order is the catalog's own (`main` then `overflow`), so the first option matches `claude`'s default and a refresh
 * does not re-point a record at a retired id.
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
    // A model the INSTALLED binary is too old to select would be persisted and then rejected at spawn. Callers that must
    // tell "the cache has ids" from "this binary can select none" pass `applyVersionFloor: false`.
    .filter((model) => !applyVersionFloor || versionAtLeast(cliVersion, model.min_claude_code_version))
    .map((model) => model.id);

  return [...new Set(ids)];
}

/** How stale the chosen catalog is, for the caller's log line. The CLI refreshes it; PortOS never writes this file. */
export function catalogAge(entries, { surface = CLAUDE_CODE_SURFACE } = {}) {
  const freshest = freshestCatalog(entries, surface);
  return freshest ? Number(freshest.fetchedAt) || null : null;
}

/**
 * Env markers (the binary's `CLAUDE_CODE_USE_*` set plus the `ANTHROPIC_AWS` / `ANTHROPIC_GOOGLE_CLOUD` variants) that
 * point `claude` at a third-party backend. Such a record's models are namespaced by its backend (`global.anthropic...`),
 * while this catalog holds only first-party ids, so a refresh would overwrite real ids with ones its endpoint rejects.
 * These records resolve to NO fetcher: no Refresh button, the stored catalog stands (#8034).
 */
const THIRD_PARTY_BACKEND_VARS = Object.freeze([
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
]);

// Truthy the way the CLI reads these: any non-empty value except the explicit off-switches (`"0"` / `"false"`).
const envFlagEnabled = (value) => {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
};

export function usesThirdPartyBackend(provider, inheritedEnv = process.env) {
  const envVars = { ...inheritedEnv, ...(provider?.envVars || {}) };
  return THIRD_PARTY_BACKEND_VARS.some((name) => envFlagEnabled(envVars[name]));
}
