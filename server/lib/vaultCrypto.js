/**
 * Vault Crypto — field-level AES-256-GCM for the Privacy Center PII Vault
 * (issue #2140, epic #2138). PortOS's first encrypted-at-rest layer.
 *
 * Ciphertext format (versioned for future key rotation):
 *   `v1:<iv_b64>:<tag_b64>:<ct_b64>`
 * — per-value random 12-byte IV, 16-byte GCM auth tag. Any tampering with the
 * IV, tag, or ciphertext makes decryptValue throw (GCM authentication).
 *
 * Key: 32 bytes from env `PRIVACY_VAULT_KEY` (hex or base64 — see
 * `.env.example`). `ensureVaultKey()` self-heals a missing key on first write:
 * generates via randomBytes(32), appends it to `.env`, and logs ONE emoji line
 * that never contains the key value.
 *
 * Masking lives here too (pure, no DB) so list/read responses can show a
 * recognizable-but-safe value while plaintext stays encrypted at rest.
 * Plaintext PII must NEVER be logged — callers log ids/types only.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { join } from 'path';
import { PATHS, tryReadFile, atomicWrite } from './fileUtils.js';

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const FORMAT_VERSION = 'v1';

const DEFAULT_ENV_PATH = join(PATHS.root, '.env');

/** Parse a hex- or base64-encoded 32-byte key; null when absent/invalid. */
function parseKey(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/=]+$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === KEY_BYTES) return decoded;
  }
  return null;
}

function getVaultKey() {
  return parseKey(process.env.PRIVACY_VAULT_KEY);
}

/** True when PRIVACY_VAULT_KEY holds a valid 32-byte key. */
export function isVaultKeyConfigured() {
  return getVaultKey() !== null;
}

/**
 * Self-heal a missing vault key: when `PRIVACY_VAULT_KEY` is unset or invalid,
 * generate 32 random bytes, append the hex form to `.env` (created if absent),
 * and set `process.env` so the running server picks it up immediately. Reads
 * the `.env` file first so a key added after boot is adopted rather than
 * duplicated. Returns `{ generated }`. Never logs the key value.
 */
export async function ensureVaultKey({ envPath = DEFAULT_ENV_PATH } = {}) {
  if (isVaultKeyConfigured()) return { generated: false };

  const content = (await tryReadFile(envPath)) ?? '';
  const existing = content.match(/^PRIVACY_VAULT_KEY=(.*)$/m);
  if (existing && parseKey(existing[1])) {
    process.env.PRIVACY_VAULT_KEY = existing[1].trim();
    return { generated: false };
  }

  const key = randomBytes(KEY_BYTES).toString('hex');
  const separator = content && !content.endsWith('\n') ? '\n' : '';
  await atomicWrite(envPath, `${content}${separator}PRIVACY_VAULT_KEY=${key}\n`);
  process.env.PRIVACY_VAULT_KEY = key;
  console.log('🔐 Generated PRIVACY_VAULT_KEY and appended it to .env (vault encryption engaged)');
  return { generated: true };
}

/** Encrypt a plaintext string → `v1:<iv_b64>:<tag_b64>:<ct_b64>`. */
export function encryptValue(plaintext) {
  const key = getVaultKey();
  if (!key) throw new Error('PRIVACY_VAULT_KEY is not configured — call ensureVaultKey() first');
  if (typeof plaintext !== 'string') throw new Error('encryptValue requires a string');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${FORMAT_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt a `v1:` ciphertext back to plaintext. Throws on an unknown format
 * version, a malformed payload, or any tampering (GCM auth failure).
 */
export function decryptValue(ciphertext) {
  const key = getVaultKey();
  if (!key) throw new Error('PRIVACY_VAULT_KEY is not configured — call ensureVaultKey() first');
  if (typeof ciphertext !== 'string') throw new Error('decryptValue requires a string');
  const [version, ivB64, tagB64, ctB64] = ciphertext.split(':');
  if (version !== FORMAT_VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new Error(`Unsupported vault ciphertext format (expected ${FORMAT_VERSION}:iv:tag:ct)`);
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error('Malformed vault ciphertext');
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

// ─── Masking ─────────────────────────────────────────────────────────────────

/**
 * `••••1234` — last 4 of the digits (or raw chars when digits are scarce).
 * A source of 4 or fewer characters is fully masked: showing "the last 4" of a
 * 4-char value would be full disclosure, not a mask.
 */
function maskLastFour(value) {
  const digits = value.replace(/\D/g, '');
  const source = digits.length >= 4 ? digits : value;
  if (source.length <= 4) return '••••';
  return `••••${source.slice(-4)}`;
}

/**
 * Per-type display mask. Never returns the plaintext:
 * - ssn / phone / financial_account → last-4 (`••••1234`)
 * - email → first char + domain visible (`j•••@example.com`)
 * - address → street segment masked, city/state visible (`••• Portland, OR`)
 * - everything else → first character + `•••`
 */
export function maskValue(type, plaintext) {
  const value = typeof plaintext === 'string' ? plaintext.trim() : '';
  if (!value) return '••••';
  switch (type) {
    case 'ssn':
    case 'phone':
    case 'financial_account':
      return maskLastFour(value);
    case 'email': {
      const at = value.indexOf('@');
      if (at <= 0) return '••••';
      return `${value[0]}•••@${value.slice(at + 1)}`;
    }
    case 'address': {
      const comma = value.indexOf(',');
      if (comma === -1) return '•••';
      return `•••${value.slice(comma)}`;
    }
    default:
      return `${value[0]}•••`;
  }
}
