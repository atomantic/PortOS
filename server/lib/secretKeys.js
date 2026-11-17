/**
 * "Does this payload KEY name hold a credential?": `isSecretKey(key)`, the key-side half of the secret-redaction pair whose value side is `secretText.js#scrubSecretTokens`.
 *
 * `api_key`/`apiKey`/`API-KEY` normalize to `apikey`; a trailing `Key`/`Keys` counts; short names like `auth`/`env` match only whole. Split out of `services/userActions.js` when the Eidoverse promote gate needed it at the federation boundary (`{ apiKey: 'hunter2' }` carries a live credential no value-shape pattern can recognize, since the secret is identifiable only by what it is CALLED); pure and dependency-free so a `lib/` gate and a `services/` ledger can both reach it.
 * Substring matching is deliberate OVER-redaction: dropping `tokenCount` costs one boring number, missing `refreshToken` writes a live credential to disk or a peer.
 */

// Matched with separators and case removed, so `api_key`, `apiKey` and `API-KEY` all normalize to `apikey`.
const SECRET_KEY_FRAGMENTS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'authorization',
  'credential', 'privatekey', 'ciphertext', 'cookie', 'accesskey',
];
// Names too short to substring-match (a bare `key` would eat `keysChanged`, `env` would eat `envelope`), so they match only as a WHOLE key.
const SECRET_KEY_EXACT = new Set(['key', 'keys', 'auth', 'env', 'dotenv', 'vault', 'pat', 'pw']);

const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

/** True when a payload key name looks like it holds a credential. */
export function isSecretKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (SECRET_KEY_EXACT.has(normalized)) return true;
  // A trailing `Key`/`Keys` names every provider-specific credential (`openaiKey`, `sshKey`, `signingKey`, `deployKeys`) none of which contain `apikey`; anchoring at the END keeps `keysChanged` out.
  if (normalized.endsWith('key') || normalized.endsWith('keys')) return true;
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}
