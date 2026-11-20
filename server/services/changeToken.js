/**
 * Change-token registry — domain-keyed monotonic counters the dataSync snapshot loop folds into a domain's fingerprint.
 * DB-backed domains no longer touch `data/<domain>/`, so stores bump a token on every record write/delete or peers would stop receiving edits.
 * The fingerprint format (`epoch:N`) is unchanged on the wire; unknown domains throw so a typo can't silently desync a peer.
 * Singleton Map: facade rebuilds (test PATHS.data swaps) must not reset a counter.
 */

/** Known change-token domains — callers must pass one of these (no arbitrary strings). */
export const CHANGE_TOKEN_DOMAINS = Object.freeze(['universe', 'pipeline', 'storyBuilder', 'usage']);

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
