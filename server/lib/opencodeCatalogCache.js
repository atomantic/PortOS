/**
 * Primes OpenCode's on-disk model catalog, so a "Refresh models" click reports
 * what OpenCode actually offers today rather than what it offered the last time
 * its own background fetch happened to succeed.
 *
 * **The failure this exists for.** `opencode models` does NOT go to the network:
 * it reads `$XDG_CACHE_HOME/opencode/models.json` (falling back to
 * `~/.cache/opencode/models.json`) and prints the models it can resolve out of
 * that file. OpenCode keeps that file current from a task forked at startup
 * that re-fetches when the file is older than five minutes — but the fetch is
 * wrapped in `ignore`, so when it fails, nothing surfaces: `opencode models
 * --refresh` still prints `Models cache refreshed` and still lists the stale
 * catalog. On a host where that fetch keeps failing, the file freezes at
 * whatever day it last worked and every consumer — OpenCode's own TUI, and the
 * PortOS Harnesses page reading through it — silently shows a weeks-old model
 * list while a second machine on the same account shows the current one.
 *
 * That fetch fails for an ordinary reason: OpenCode's HTTP client connects
 * without Happy Eyeballs, so a host advertising an IPv6 default route it cannot
 * actually reach (a VPN interface installing one, with no global v6 address)
 * fails instantly with "Unable to connect" while `curl` and Node — both of
 * which fall back to IPv4 — fetch the same URL fine. PortOS is Node, so
 * fetching the catalog HERE and handing OpenCode the file it wanted is enough
 * to unstick it, for the Harnesses page and for the vendor's own TUI alike.
 *
 * **This writes another tool's cache file, so it is narrow on purpose.** It
 * refuses whenever it cannot be certain which file OpenCode would read
 * (`OPENCODE_MODELS_PATH` pins a different one; a custom `OPENCODE_MODELS_URL`
 * moves the cache to a name derived from a hash of that URL) or whenever the
 * user has opted out of catalog fetching (`OPENCODE_DISABLE_MODELS_FETCH`), and
 * it only ever replaces the file with a payload that parsed as a real catalog.
 * A refusal is not an error: the caller probes anyway and gets today's stale
 * answer, exactly as before this module existed.
 *
 * No AI provider call happens here — this is a vendor catalog endpoint, the
 * same class of read as `npm view`, and it runs only from an explicit click.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';

import { atomicWrite } from './fileUtils.js';

/** Where OpenCode fetches its catalog from, when `OPENCODE_MODELS_URL` says nothing else. */
const OPENCODE_CATALOG_URL = 'https://models.opencode.ai';

/**
 * How old the cache may be before it is worth re-fetching — OpenCode's own
 * staleness window. Matching it keeps a double-click from pulling several MB
 * twice while still meaning "fresh" for anyone who clicked the button.
 */
const CATALOG_MAX_AGE_MS = 5 * 60 * 1000;

/** A multi-megabyte JSON body over a slow link must not hold the click open. */
const CATALOG_FETCH_TIMEOUT_MS = 20_000;

/**
 * The catalog file `opencode models` will read, or `null` when PortOS cannot be
 * sure which file that is (see the module note). `null` is a REFUSAL, not a
 * failure — the caller carries on and probes the harness regardless.
 */
const catalogCachePath = (env) => {
  // The user pinned an explicit catalog file; it is theirs, not a cache.
  if (env.OPENCODE_MODELS_PATH) return null;
  // Catalog fetching is switched off — priming it would be exactly the network
  // read that setting exists to prevent.
  if (env.OPENCODE_DISABLE_MODELS_FETCH) return null;
  // A custom endpoint moves the cache to `models-<hash of url>.json`, and the
  // hash is OpenCode's internal one. Guessing the filename would leave a file
  // it never reads.
  if (env.OPENCODE_MODELS_URL && env.OPENCODE_MODELS_URL !== OPENCODE_CATALOG_URL) return null;
  const home = homedir();
  const cacheRoot = env.XDG_CACHE_HOME || (home ? join(home, '.cache') : null);
  return cacheRoot ? join(cacheRoot, 'opencode', 'models.json') : null;
};

/**
 * Is this text a catalog, rather than an error page or a truncated body?
 *
 * The point is the REFUSAL: overwriting a working catalog with a gateway error
 * page would take the user from a stale model list to an empty one. A catalog is
 * a JSON object keyed by provider id, each entry carrying a `models` object.
 * Async so a malformed body answers `false` instead of throwing.
 */
const isCatalogPayload = async (text) => {
  const parsed = await Promise.resolve().then(() => JSON.parse(text)).catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Object.values(parsed).some((entry) => entry && typeof entry === 'object' && typeof entry.models === 'object');
};

/**
 * Fetch OpenCode's model catalog and write it where `opencode models` reads it,
 * unless it is already fresh or this host is one of the refusal cases.
 *
 * Never throws: every outcome is a reason string, because the caller's job (probe
 * the harness) is still worth doing when priming was skipped or failed.
 *
 * @param {object} [deps]
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {Promise<{primed: boolean, reason: string, path?: string}>}
 */
export async function primeOpencodeCatalogCache({ env = process.env, fetchImpl = fetch } = {}) {
  const path = catalogCachePath(env);
  if (!path) return { primed: false, reason: 'this install reads its catalog from somewhere PortOS should not write' };

  // A missing file is not an error — OpenCode falls back to the catalog built
  // into the binary — but it IS a reason to fetch, so absence and staleness
  // take the same branch.
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
