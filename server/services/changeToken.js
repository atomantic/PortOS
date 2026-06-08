/**
 * Change-token registry — the shared dataSync federation-invisibility signal (#1031).
 *
 * The dataSync snapshot loop fingerprints `data/<domain>/` directories to decide
 * WHEN to re-send a snapshot to peers. DB-backed Create domains (universes #1014,
 * pipeline series/issues #1015, story-builder sessions #1016) no longer touch
 * those directories on a record write/delete, so the dir fingerprint alone would
 * go stale and peers would silently stop receiving edits.
 *
 * Each migrated domain previously rolled its own module-level `mutationEpoch`
 * counter (three near-identical copies). This module consolidates them into ONE
 * domain-keyed monotonic counter map: a store bumps `bumpChangeToken(domain)` on
 * every record write/delete, and dataSync folds `getChangeToken(domain)` into the
 * domain's fingerprint via its existing sentinel key. The fingerprint string
 * format (`epoch:N`) is unchanged, so this stays byte-identical on the wire —
 * federation-invisible, no schema-version bump.
 *
 * Module-level (singleton) Map so dataSync reads ONE monotonic counter per domain
 * regardless of how many times a store facade is rebuilt (test PATHS.data swaps
 * recreate facades but must not reset the counter). Unknown domains fail-fast on
 * bump/get so a typo can't silently desync a peer.
 */

/** Known change-token domains — callers must pass one of these (no arbitrary strings). */
export const CHANGE_TOKEN_DOMAINS = Object.freeze(['universe', 'pipeline', 'storyBuilder']);

const DOMAIN_SET = new Set(CHANGE_TOKEN_DOMAINS);

// Singleton: one monotonic counter per domain. Survives facade rebuilds.
const counters = new Map();

function assertDomain(domain) {
  if (!DOMAIN_SET.has(domain)) {
    throw new Error(`changeToken: unknown domain "${domain}" — must be one of ${CHANGE_TOKEN_DOMAINS.join(', ')}`);
  }
}

/** Increment the domain's change token — call on every record write/delete. */
export function bumpChangeToken(domain) {
  assertDomain(domain);
  counters.set(domain, (counters.get(domain) || 0) + 1);
}

/** Read the domain's current change token (0 if never bumped). */
export function getChangeToken(domain) {
  assertDomain(domain);
  return counters.get(domain) || 0;
}
