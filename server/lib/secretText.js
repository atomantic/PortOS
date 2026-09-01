/**
 * Scrub credential-SHAPED token values out of free text bound for an LLM
 * provider or a world-readable artifact.
 *
 * The operator-action ledger already drops credential-shaped KEYS at record
 * time (`services/userActions.js#redactPayload`), but free-text fields —
 * summaries, target names — can carry a pasted token by VALUE, where no key
 * name exists to match. This is the value-side counterpart: conservative,
 * well-known token shapes only, so ordinary prose, git SHAs (40 hex), and
 * short ids survive untouched. Complements `commandSecurity.js#redactOutput`
 * (JSON key/value patterns) rather than replacing it.
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

/** Replace credential-shaped substrings with `[REDACTED]`. Non-strings pass through. */
export function scrubSecretTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return SECRET_TOKEN_PATTERNS.reduce((out, pattern) => out.replace(pattern, '[REDACTED]'), text);
}

/**
 * Apply `scrubSecretTokens` to every string in a JSON-shaped value — arrays and
 * plain objects are walked (values only; key names are handled by the key-based
 * redaction at record time), everything else passes through untouched.
 */
export function scrubSecretTokensDeep(value) {
  if (typeof value === 'string') return scrubSecretTokens(value);
  if (Array.isArray(value)) return value.map(scrubSecretTokensDeep);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrubSecretTokensDeep(child)]));
  }
  return value;
}
