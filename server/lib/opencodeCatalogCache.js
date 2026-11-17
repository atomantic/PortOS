/**
 * Primes OpenCode's on-disk model catalog so a "Refresh models" click reports what OpenCode offers today, not what it offered the last time its own background fetch succeeded.
 *
 * **The failure this exists for:** `opencode models` does NOT hit the network; it reads `$XDG_CACHE_HOME/opencode/models.json` (or `~/.cache/opencode/models.json`). OpenCode refreshes that from a startup task when the file is older than five minutes, but the fetch
 * is wrapped in `ignore`, so on failure `opencode models --refresh` still prints `Models cache refreshed` and lists the stale catalog; the file freezes and OpenCode's TUI and the PortOS Harnesses page show a weeks-old list while a second machine shows the current one.
 * The fetch fails because OpenCode's HTTP client connects without Happy Eyeballs: a host advertising an unreachable IPv6 default route (a VPN installing one, no global v6) fails instantly while `curl` and Node fall back to IPv4. PortOS is Node, so fetching HERE and handing OpenCode the file unsticks both.
 * **This writes another tool's cache file, so it is narrow on purpose:** it refuses when it can't be certain which file OpenCode reads (`OPENCODE_MODELS_PATH` pins another; a custom `OPENCODE_MODELS_URL` moves the cache to a hash-derived name) or the user opted out (`OPENCODE_DISABLE_MODELS_FETCH`),
 * and only replaces the file with a payload that parsed as a real catalog. A refusal is not an error (the caller probes anyway). No AI provider call: a vendor catalog endpoint (like `npm view`), run only from an explicit click.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';

import { atomicWrite } from './fileUtils.js';

/** Where OpenCode fetches its catalog from, absent `OPENCODE_MODELS_URL`. */
const OPENCODE_CATALOG_URL = 'https://models.opencode.ai';

/** How old the cache may be before re-fetching, matching OpenCode's own staleness window (a double-click shouldn't pull several MB twice). */
const CATALOG_MAX_AGE_MS = 5 * 60 * 1000;

/** A multi-megabyte JSON body over a slow link must not hold the click open. */
const CATALOG_FETCH_TIMEOUT_MS = 20_000;

/** The catalog file `opencode models` will read, or `null` when PortOS can't be sure which (a REFUSAL, not a failure: the caller probes the harness regardless). */
const catalogCachePath = (env) => {
  // The user pinned an explicit catalog file; it is theirs, not a cache.
  if (env.OPENCODE_MODELS_PATH) return null;
  // Catalog fetching is switched off: priming would be the network read that setting prevents.
  if (env.OPENCODE_DISABLE_MODELS_FETCH) return null;
  // A custom endpoint moves the cache to `models-<hash of url>.json` using OpenCode's internal hash; a guessed filename would be one it never reads.
  if (env.OPENCODE_MODELS_URL && env.OPENCODE_MODELS_URL !== OPENCODE_CATALOG_URL) return null;
  const home = homedir();
  const cacheRoot = env.XDG_CACHE_HOME || (home ? join(home, '.cache') : null);
  return cacheRoot ? join(cacheRoot, 'opencode', 'models.json') : null;
};

/** Is this text a catalog, not an error page or truncated body? Overwriting a working catalog with a gateway error page would turn a stale list into an empty one. A catalog is a JSON object keyed by provider id, each entry carrying a `models` object. Async so a malformed body answers `false`. */
const isCatalogPayload = async (text) => {
  const parsed = await Promise.resolve().then(() => JSON.parse(text)).catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Object.values(parsed).some((entry) => entry && typeof entry === 'object' && typeof entry.models === 'object');
};

/**
 *
 * @param {object} [deps]
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {Promise<{primed: boolean, reason: string, path?: string}>}
 */
export async function primeOpencodeCatalogCache({ env = process.env, fetchImpl = fetch } = {}) {
  const path = catalogCachePath(env);
  if (!path) return { primed: false, reason: 'this install reads its catalog from somewhere PortOS should not write' };

  // A missing file is not an error (OpenCode falls back to the built-in catalog) but IS a reason to fetch, so absence and staleness share a branch.
  const mtimeMs = await stat(path).then((s) => s.mtimeMs, () => null);
  if (mtimeMs !== null && Date.now() - mtimeMs < CATALOG_MAX_AGE_MS) {
    return { primed: false, reason: 'catalog is already fresh', path };
  }

  const url = `${OPENCODE_CATALOG_URL}/api.json`;
  const text = await fetchImpl(url, { signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) })
    .then((res) => (res.ok ? res.text() : null))
    .catch(() => null);
  if (text === null) return { primed: false, reason: `could not reach ${url}`, path };
  // Parse failures land here too — a body that is not JSON is not a catalog.
  if (!(await isCatalogPayload(text))) return { primed: false, reason: `${url} did not return a model catalog`, path };

  const written = await atomicWrite(path, text).then(() => true, () => false);
  return written
    ? { primed: true, reason: `wrote ${Buffer.byteLength(text)} bytes`, path }
    : { primed: false, reason: `could not write ${path}`, path };
}
