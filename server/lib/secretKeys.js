/**
 * "Does this payload KEY name hold a credential?" — the key-side half of the
 * secret-redaction pair whose value side is `secretText.js#scrubSecretTokens`.
 *
 * Split out of `services/userActions.js` (where the operator-action ledger
 * wrote it) when the Eidoverse promote gate needed the same question at the
 * federation boundary: a `body` of `{ apiKey: 'hunter2' }` carries a live
 * credential that no value-shape pattern can recognize, because the secret is
 * only identifiable by what it is CALLED. Pure and dependency-free so both a
 * `lib/` gate and a `services/` ledger can reach it.
 *
 * Substring matching is deliberate OVER-redaction: dropping `tokenCount` costs
 * one boring number, while missing `refreshToken` writes a live credential to
 * disk (or ships it to a peer).
 */

// Matched against the key with separators and case removed, so `api_key`,
// `apiKey` and `API-KEY` all normalize to `apikey`.
const SECRET_KEY_FRAGMENTS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'authorization',
  'credential', 'privatekey', 'ciphertext', 'cookie', 'accesskey',
];
// Names too short to substring-match safely (a bare `key` fragment would eat
// `keysChanged`, `env` would eat `envelope`), so they match only as a WHOLE key.
const SECRET_KEY_EXACT = new Set(['key', 'keys', 'auth', 'env', 'dotenv', 'vault', 'pat', 'pw']);

const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

/** True when a payload key name looks like it holds a credential. */
export function isSecretKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (SECRET_KEY_EXACT.has(normalized)) return true;
  // A trailing `Key`/`Keys` is how every provider-specific credential is named
  // (`openaiKey`, `sshKey`, `signingKey`, `deployKeys`), and none of them contain
  // the literal `apikey`. Anchoring at the END keeps `keysChanged` out.
  if (normalized.endsWith('key') || normalized.endsWith('keys')) return true;
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}
