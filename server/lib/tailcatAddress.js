/** Pure Tailcat capability validation and diagnostic redaction. */

const DIAGNOSTIC_MAX_CHARS = 320;

/** Redact a tc address for logs / UI — never echo the full capability. */
export function redactTcAddress(tc) {
  const raw = String(tc || '').trim();
  if (!raw) return '(empty)';
  if (raw.length <= 8) return 'tc…';
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

/**
 * Accept a pasted tailcat address. Real addresses are `tc` + base64url CBOR;
 * keep the gate loose enough for DNS TXT forms that still begin with `tc`, but
 * reject obvious garbage so we never spawn with an operator typo as argv.
 */
export function isValidTcAddress(tc) {
  const raw = String(tc || '').trim();
  if (!raw.startsWith('tc')) return false;
  if (raw.length < 24 || raw.length > 2048) return false;
  // Letters, digits, _ - = + / (base64 / base64url) only after the tc prefix.
  return /^tc[A-Za-z0-9_+\/=-]+$/.test(raw);
}

/**
 * Strip every capability-shaped token out of tailcat's own diagnostics, then
 * bound them, so a startup failure can finally be *reported* to the operator
 * instead of collapsing into an opaque "startup timed out". Redaction runs over
 * the whole buffered tail at once, never per chunk, so an address split across
 * reads is still caught after reassembly.
 */
export function redactTailcatDiagnostics(text) {
  const lines = String(text || '')
    // 8+ payload chars, so even a tail-truncated address fragment is scrubbed.
    .replace(/tc[A-Za-z0-9_+\/=-]{8,}/g, 'tc…')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.slice(-3).join(' | ');
  return joined.length > DIAGNOSTIC_MAX_CHARS ? `${joined.slice(0, DIAGNOSTIC_MAX_CHARS)}…` : joined;
}

