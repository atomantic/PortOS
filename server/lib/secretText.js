/**
 * Scrub credential-SHAPED token values, plus host-registered ephemeral literal secrets, out of free text bound for an LLM provider or a world-readable artifact.
 *
 * `scrubSecretTokens(text)` replaces prefixed API keys, GitHub/Slack tokens, JWTs, AWS key ids, pasted Bearer headers and 48+-char hex with `[REDACTED]`; `scrubSecretTokensDeep(value)` walks arrays/plain objects and scrubs every string value. The value-side counterpart to the operator-action ledger's key-based `services/userActions.js#redactPayload` (free-text summaries and target names can carry a pasted token by VALUE, with no key name to match) and complement to `commandSecurity.js#redactOutput`'s JSON patterns. Conservative, well-known shapes only, so prose, 40-hex git SHAs and short ids survive.
 *
 * Ephemeral secrets: a host-side flow that hands a plaintext secret to something
 * a model can later observe (the model-blind browser fill typing a vault password
 * into a page) registers the literal with `registerEphemeralSecret` for a bounded
 * TTL. Both scrubbers then redact it by exact value, and `scrubEphemeralSecretsDeep`
 * applies ONLY that literal pass, for DOM reads whose content must otherwise stay
 * byte-identical. The registry is in-memory and never persisted or logged; it is a
 * defense-in-depth echo filter, not the boundary that keeps secrets out of results.
 */

const SECRET_TOKEN_PATTERNS = [
  // OpenAI/Anthropic/Stripe-style prefixed keys (sk-…, sk-ant-…, pk_live_…).
  /\b[sprx]k[-_](?:[A-Za-z0-9]+[-_])*[A-Za-z0-9]{16,}\b/g,
  // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_ + the fine-grained github_pat_).
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // JWTs (three dot-joined base64url segments starting with the {"alg" header).
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bearer/token headers pasted whole.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // Very long unbroken hex (48+ — deliberately above a 40-char git SHA).
  /\b[A-Fa-f0-9]{48,}\b/g,
];

const REDACTED = '[REDACTED]';

// Shorter literals would redact ordinary words and numbers everywhere for the
// whole TTL; a 6-digit TOTP code is the shortest secret this is meant for.
const EPHEMERAL_SECRET_MIN_LENGTH = 4;
const EPHEMERAL_SECRET_MAX_ENTRIES = 256;
const ephemeralSecrets = new Map(); // literal -> expiresAt (epoch ms)

const liveEphemeralSecrets = (now = Date.now()) => {
  for (const [literal, expiresAt] of ephemeralSecrets) {
    if (expiresAt <= now) ephemeralSecrets.delete(literal);
  }
  // Longest first, so a password that contains a registered TOTP code is
  // redacted whole rather than leaving its remainder around a placeholder.
  return [...ephemeralSecrets.keys()].sort((a, b) => b.length - a.length);
};

/**
 * Redact `value` by exact match from every later scrub until `ttlMs` elapses.
 * Returns false (and registers nothing) for non-strings or values shorter than
 * EPHEMERAL_SECRET_MIN_LENGTH. Re-registering keeps the later expiry, never a
 * shorter one; the oldest entry is evicted beyond EPHEMERAL_SECRET_MAX_ENTRIES.
 */
export function registerEphemeralSecret(value, { ttlMs, now = Date.now() } = {}) {
  if (typeof value !== 'string' || value.length < EPHEMERAL_SECRET_MIN_LENGTH) return false;
  if (!(ttlMs > 0)) return false;
  const expiresAt = Math.max(ephemeralSecrets.get(value) ?? 0, now + ttlMs);
  ephemeralSecrets.delete(value);
  ephemeralSecrets.set(value, expiresAt);
  while (ephemeralSecrets.size > EPHEMERAL_SECRET_MAX_ENTRIES) ephemeralSecrets.delete(ephemeralSecrets.keys().next().value);
  return true;
}

/** Test seam: drop every registered ephemeral secret. */
export function clearEphemeralSecrets() {
  ephemeralSecrets.clear();
}

const scrubLiterals = (text, literals) => literals.reduce((out, literal) => out.split(literal).join(REDACTED), text);

/** Replace only registered ephemeral secrets in `text`; everything else is left byte-identical. */
export function scrubEphemeralSecrets(text) {
  if (typeof text !== 'string' || text.length === 0 || ephemeralSecrets.size === 0) return text;
  return scrubLiterals(text, liveEphemeralSecrets());
}

const mapStringsDeep = (value, scrub) => {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((child) => mapStringsDeep(child, scrub));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapStringsDeep(child, scrub)]));
  }
  return value;
};

/** `scrubEphemeralSecrets` over every string in a JSON-shaped value; returns the input untouched when nothing is registered. */
export function scrubEphemeralSecretsDeep(value) {
  if (ephemeralSecrets.size === 0) return value;
  const literals = liveEphemeralSecrets();
  if (literals.length === 0) return value;
  return mapStringsDeep(value, (text) => (text ? scrubLiterals(text, literals) : text));
}

/** Replace credential-shaped substrings and registered ephemeral secrets with `[REDACTED]`. Non-strings pass through. */
export function scrubSecretTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return scrubEphemeralSecrets(SECRET_TOKEN_PATTERNS.reduce((out, pattern) => out.replace(pattern, REDACTED), text));
}

/** Apply `scrubSecretTokens` to every string in a JSON-shaped value; arrays and plain objects are walked (values only; key names are handled by key-based redaction at record time), everything else passes through. */
export function scrubSecretTokensDeep(value) {
  return mapStringsDeep(value, scrubSecretTokens);
}
