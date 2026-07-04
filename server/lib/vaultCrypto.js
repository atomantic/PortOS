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
import { readFileSync } from 'fs';
import { chmod } from 'fs/promises';
import { join } from 'path';
import { PATHS, tryReadFile, atomicWrite } from './fileUtils.js';
import { createSingleFlight } from './singleFlight.js';

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const FORMAT_VERSION = 'v1';

// Anchor to the INSTALL root, not the code root: the encrypted rows live in
// the ONE install-shared Postgres, so the key must live next to that data. A
// server booted from a CoS git worktree (PORTOS_DATA_ROOT pinned, #1947) has
// no .env in its checkout — anchoring to PATHS.root there would mint a
// throwaway key in the worktree, encrypt shared rows with it, and destroy the
// key when the worktree is pruned (irreversible PII loss).
const DEFAULT_ENV_PATH = join(PATHS.installRoot, '.env');

// Test hook: unit tests point this at a temp .env so the read-path fallback
// below never touches (or is satisfied by) the real install's key.
let envPathOverride = null;
export function __setVaultEnvPathForTests(path) { envPathOverride = path; }
const resolveEnvPath = () => envPathOverride ?? DEFAULT_ENV_PATH;

/** First VALID key among all PRIVACY_VAULT_KEY= lines in the .env file. */
function readKeyFromEnvFile(envPath) {
  let content = '';
  try { content = readFileSync(envPath, 'utf8'); } catch { return null; }
  for (const match of content.matchAll(/^PRIVACY_VAULT_KEY=(.*)$/gm)) {
    const raw = match[1].trim();
    if (parseKey(raw)) return raw;
  }
  return null;
}

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

/**
 * Resolve the vault key: `process.env` first, then the `.env` file. The file
 * fallback is what makes READS survive a server restart — nothing loads `.env`
 * into `process.env` at boot (PortOS has no dotenv), so without it every
 * decrypt/status call would fail after `pm2 restart` until the next WRITE
 * happened to run `ensureVaultKey()`. A key found in the file is adopted into
 * `process.env` so subsequent calls take the fast path.
 */
function getVaultKey() {
  const fromEnv = parseKey(process.env.PRIVACY_VAULT_KEY);
  if (fromEnv) return fromEnv;
  const fromFile = readKeyFromEnvFile(resolveEnvPath());
  if (fromFile) {
    process.env.PRIVACY_VAULT_KEY = fromFile;
    return parseKey(fromFile);
  }
  return null;
}

/** True when PRIVACY_VAULT_KEY holds a valid 32-byte key. */
export function isVaultKeyConfigured() {
  return getVaultKey() !== null;
}

/**
 * Self-heal a missing vault key: when `PRIVACY_VAULT_KEY` is unset or invalid
 * in both `process.env` and the `.env` file, generate 32 random bytes, write
 * the hex form to `.env` (created if absent), and set `process.env` so the
 * running server picks it up immediately. Any existing INVALID
 * `PRIVACY_VAULT_KEY=` lines (e.g. an uncommented `.env.example` placeholder)
 * are REPLACED, not appended-around — appending would leave the invalid first
 * line winning future reads and silently re-rotate the key on every restart,
 * orphaning previously encrypted rows. Returns `{ generated }`. Never logs
 * the key value.
 */
const keyProvisioning = createSingleFlight();

export function ensureVaultKey({ envPath = resolveEnvPath() } = {}) {
  if (parseKey(process.env.PRIVACY_VAULT_KEY)) return Promise.resolve({ generated: false });
  // Single-flight per env path: two concurrent first writes must share ONE
  // generation — otherwise each mints its own key, one wins the .env write,
  // and the loser's freshly encrypted row is unrecoverable after restart.
  return keyProvisioning.run(envPath, () => provisionVaultKey(envPath));
}

async function provisionVaultKey(envPath) {
  // Re-check inside the flight: a caller that raced in behind an adopt/generate
  // (or a fresh call after the slot cleared) must not rotate an existing key.
  if (parseKey(process.env.PRIVACY_VAULT_KEY)) return { generated: false };

  const fromFile = readKeyFromEnvFile(envPath);
  if (fromFile) {
    process.env.PRIVACY_VAULT_KEY = fromFile;
    return { generated: false };
  }

  const key = randomBytes(KEY_BYTES).toString('hex');
  const existing = await tryReadFile(envPath);
  const content = existing ?? '';
  // Drop any invalid PRIVACY_VAULT_KEY lines (none are valid — checked above).
  const cleaned = content.replace(/^PRIVACY_VAULT_KEY=.*(\r?\n|$)/gm, '');
  const separator = cleaned && !cleaned.endsWith('\n') ? '\n' : '';
  await atomicWrite(envPath, `${cleaned}${separator}PRIVACY_VAULT_KEY=${key}\n`);
  // A brand-new .env holding a key that decrypts every vault record must not
  // be world-readable (atomicWrite gives new files the umask default, commonly
  // 0644). An EXISTING .env keeps whatever mode the user chose — atomicWrite
  // already preserves it, and silently re-chmodding a user's file is worse.
  if (existing === null) await chmod(envPath, 0o600);
  process.env.PRIVACY_VAULT_KEY = key;
  console.log('🔐 Generated PRIVACY_VAULT_KEY and wrote it to .env (vault encryption engaged)');
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
      // Keep only the trailing city/state segments visible. Masking just the
      // FIRST comma segment would leak the street whenever the value starts
      // with a non-street segment ("c/o Adam Eivy, 123 Main St, ...").
      const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length < 2) return '•••';
      const visible = parts.slice(parts.length >= 3 ? -2 : -1);
      return `•••, ${visible.join(', ')}`;
    }
    default:
      return `${value[0]}•••`;
  }
}
