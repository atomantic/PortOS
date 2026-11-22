/**
 * Dependency-free RFC 6238 TOTP / RFC 4226 HOTP codes, RFC 4648 Base32 decoding and `otpauth://totp` setup-key parsing.
 *
 * The website-login vault (`services/privacyWebsiteLogins.js`) stores the parsed
 * config returned by `parseTotpSetupKey` inside the encrypted payload, and the
 * model-blind browser fill (`services/browserVaultFill.js`) calls `generateTotp`
 * at fill time, so neither the seed nor a code ever has to leave the host process.
 * Callers must never log a seed or a generated code.
 */

import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Most authenticator setup keys are 80 or 160 bits. Anything shorter is far more
// likely to be a typo or a pasted recovery code than a real seed.
const TOTP_MIN_SECRET_BYTES = 10;
const TOTP_ALGORITHMS = Object.freeze(['SHA1', 'SHA256', 'SHA512']);
const TOTP_DEFAULTS = Object.freeze({ algorithm: 'SHA1', digits: 6, period: 30 });
const MIN_DIGITS = 6;
const MAX_DIGITS = 8;
const MAX_PERIOD_SECONDS = 300;

const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_TOTP_SECRET' });

/** Decode RFC 4648 Base32, ignoring case, spaces, hyphens and `=` padding. Throws on any other character. */
export function decodeBase32(input) {
  const clean = String(input ?? '').replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean) throw invalid('TOTP setup key is empty');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw invalid('TOTP setup key is not valid Base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const normalizeBase32 = (input) => String(input ?? '').replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();

const parseIntParam = (raw, fallback, { min, max }, name) => {
  if (raw == null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw invalid(`TOTP ${name} must be a whole number`);
  const value = Number(raw);
  if (value < min || value > max) throw invalid(`TOTP ${name} must be between ${min} and ${max}`);
  return value;
};

/**
 * Parse a raw Base32 setup key or an `otpauth://totp/...` URI into the stored
 * config `{ secret, algorithm, digits, period }` (`secret` is canonical Base32).
 * HOTP (`otpauth://hotp`) is refused: a counter would need write-back on every
 * fill. Throws an Error with `code: 'INVALID_TOTP_SECRET'` whose message never
 * echoes the input.
 */
export function parseTotpSetupKey(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw invalid('TOTP setup key is empty');
  let secret = raw;
  let algorithm = TOTP_DEFAULTS.algorithm;
  let digits = TOTP_DEFAULTS.digits;
  let period = TOTP_DEFAULTS.period;
  if (/^otpauth:/i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw invalid('TOTP setup URI is malformed'); }
    if (url.host.toLowerCase() !== 'totp') throw invalid('Only time-based (otpauth://totp) setup keys are supported');
    secret = url.searchParams.get('secret') ?? '';
    const requestedAlgorithm = (url.searchParams.get('algorithm') || TOTP_DEFAULTS.algorithm).toUpperCase().replace('-', '');
    if (!TOTP_ALGORITHMS.includes(requestedAlgorithm)) throw invalid('TOTP algorithm must be SHA1, SHA256 or SHA512');
    algorithm = requestedAlgorithm;
    digits = parseIntParam(url.searchParams.get('digits'), digits, { min: MIN_DIGITS, max: MAX_DIGITS }, 'digits');
    period = parseIntParam(url.searchParams.get('period'), period, { min: 1, max: MAX_PERIOD_SECONDS }, 'period');
  }
  const key = decodeBase32(secret);
  if (key.length < TOTP_MIN_SECRET_BYTES) throw invalid(`TOTP setup key must decode to at least ${TOTP_MIN_SECRET_BYTES} bytes`);
  return { secret: normalizeBase32(secret), algorithm, digits, period };
}

/** RFC 4226 HOTP over a raw key Buffer and a non-negative integer counter. */
export function generateHotp(key, counter, { algorithm = TOTP_DEFAULTS.algorithm, digits = TOTP_DEFAULTS.digits } = {}) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm.toLowerCase(), key).update(message).digest();
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte picks
  // four bytes; the top bit is masked so the result is a positive 31-bit int.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * RFC 6238 TOTP for a stored config (`parseTotpSetupKey` output). Returns the
 * code and `expiresAt`, the epoch milliseconds at which this time step ends.
 * `key` may be passed instead of `secret` for RFC test vectors with ASCII seeds.
 */
export function generateTotp(config, { now = Date.now() } = {}) {
  const algorithm = config.algorithm ?? TOTP_DEFAULTS.algorithm;
  const digits = config.digits ?? TOTP_DEFAULTS.digits;
  const period = config.period ?? TOTP_DEFAULTS.period;
  const key = config.key ?? decodeBase32(config.secret);
  const step = Math.floor(now / 1000 / period);
  return {
    code: generateHotp(key, step, { algorithm, digits }),
    expiresAt: (step + 1) * period * 1000,
  };
}
