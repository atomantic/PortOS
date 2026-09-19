/**
 * Mind bundle container — passphrase-sealed, install-agnostic AES-256-GCM.
 *
 * This is the format half of Persistent Mind portability (#7621, epic #7620):
 * one file the user downloads on the install their Mind grew up on and opens on
 * another one. It deliberately does NOT reuse `vaultCrypto.js` key resolution —
 * `PRIVACY_VAULT_KEY` is machine-bound, so a bundle sealed with it could never
 * be opened on the destination, which is the entire point. The cipher handling
 * is the same shape; only the key source differs: a `scrypt` key derived from
 * the user's passphrase and a per-bundle random salt.
 *
 * File layout (UTF-8 text, four newline-separated lines):
 *
 *   1  portos-mind-bundle/<containerVersion>
 *   2  <header JSON, one line, CLEARTEXT>
 *   3  <base64 ciphertext>
 *   4  <base64 GCM auth tag>
 *
 * Lines 1–2 are cleartext so a destination install can refuse a bundle it does
 * not understand BEFORE asking the user for a passphrase, and so line 2's exact
 * bytes can serve as the GCM additional-authenticated-data: editing the declared
 * scopes, KDF parameters, or manifest makes the open fail authentication rather
 * than silently changing what the bundle claims to be.
 *
 * What the cleartext header deliberately does NOT carry: per-entry plaintext
 * digests. The issue sketched them as cleartext, but a SHA-256 over
 * `profile.json` is a confirmation oracle over a small guess space (a chosen
 * name, a provider id, a model id) — anyone holding the file could brute-force
 * the Mind's identity without ever knowing the passphrase. Refusal only needs
 * versions, KDF parameters, scopes, and entry names/sizes; per-entry digests
 * are integrity checks for AFTER the open, so they live inside the ciphertext.
 *
 * Forward compatibility is by refusal, never by guessing: an unknown container
 * or payload version throws a named reason instead of applying the parts this
 * install happens to recognize.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import {
  MIND_BUNDLE_CONTAINER_VERSION,
  MIND_BUNDLE_KDF,
  MIND_BUNDLE_MAGIC,
  MIND_BUNDLE_MAX_CHARS,
  MIND_BUNDLE_PASSPHRASE_MAX_CHARS,
  MIND_BUNDLE_PASSPHRASE_MIN_CHARS,
  MIND_BUNDLE_PAYLOAD_VERSION,
  MIND_BUNDLE_REFUSALS,
  PERSISTENT_MIND_BUNDLE_SCOPES,
  mindBundleRefusal,
} from './mindBundleFormat.js';

const scryptAsync = promisify(scrypt);

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = MIND_BUNDLE_KDF.keyBytes;

// 128 * N * r, with headroom. Node's 32 MB default is below what N=32768 needs.
const SCRYPT_MAXMEM = 96 * 1024 * 1024;
// Refuse a header asking for more work than the honest ceiling above: an
// attacker-supplied N is a denial-of-service knob, not a compatibility knob.
const MAX_ACCEPTED_KDF_N = 1_048_576;

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

function requirePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIND_BUNDLE_PASSPHRASE_MIN_CHARS) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.PASSPHRASE_INVALID, `Mind bundle passphrase must be at least ${MIND_BUNDLE_PASSPHRASE_MIN_CHARS} characters`);
  }
  if (passphrase.length > MIND_BUNDLE_PASSPHRASE_MAX_CHARS) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.PASSPHRASE_INVALID, `Mind bundle passphrase must be at most ${MIND_BUNDLE_PASSPHRASE_MAX_CHARS} characters`);
  }
  return passphrase;
}

function deriveBundleKey(passphrase, salt, kdf) {
  if (kdf.name !== 'scrypt') throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.KDF_UNSUPPORTED, `Unsupported mind bundle key derivation "${kdf.name}"`);
  if (!Number.isInteger(kdf.N) || kdf.N < 2 || kdf.N > MAX_ACCEPTED_KDF_N
      || !Number.isInteger(kdf.r) || kdf.r < 1 || kdf.r > 32
      || !Number.isInteger(kdf.p) || kdf.p < 1 || kdf.p > 16
      || kdf.keyBytes !== KEY_BYTES) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.KDF_UNSUPPORTED, 'Mind bundle declares key-derivation parameters this install will not run');
  }
  return scryptAsync(passphrase, salt, KEY_BYTES, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM,
  });
}

const normalizeEntry = (entry) => {
  if (!entry || typeof entry.name !== 'string' || !entry.name) throw new Error('Mind bundle entry requires a name');
  const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
  return { name: entry.name, data };
};

/**
 * Seal entries into one bundle string.
 *
 * `entries` are `{ name, data }` where data is a Buffer or a string — the
 * container is byte-oriented so an avatar image drops in beside the JSON
 * documents without a second code path.
 */
export async function sealMindBundle({ entries, scopes, passphrase, createdAt = new Date().toISOString() }) {
  requirePassphrase(passphrase);
  const normalized = (Array.isArray(entries) ? entries : []).map(normalizeEntry);
  if (normalized.length === 0) throw new Error('Mind bundle requires at least one entry');
  const names = normalized.map((entry) => entry.name);
  if (new Set(names).size !== names.length) throw new Error('Mind bundle entry names must be unique');

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveBundleKey(passphrase, salt, MIND_BUNDLE_KDF);

  // Per-entry digests live INSIDE the ciphertext (see the module header).
  const payload = Buffer.from(JSON.stringify({
    payloadVersion: MIND_BUNDLE_PAYLOAD_VERSION,
    entries: normalized.map((entry) => ({
      name: entry.name,
      bytes: entry.data.length,
      sha256: sha256Hex(entry.data),
      dataB64: entry.data.toString('base64'),
    })),
  }), 'utf8');

  const header = {
    magic: MIND_BUNDLE_MAGIC,
    containerVersion: MIND_BUNDLE_CONTAINER_VERSION,
    payloadVersion: MIND_BUNDLE_PAYLOAD_VERSION,
    createdAt,
    scopes: [...(Array.isArray(scopes) ? scopes : [])],
    kdf: { ...MIND_BUNDLE_KDF, saltB64: salt.toString('base64') },
    cipher: { name: CIPHER, ivB64: iv.toString('base64') },
    manifest: normalized.map((entry) => ({ name: entry.name, bytes: entry.data.length })),
  };
  const headerLine = JSON.stringify(header);

  const cipher = createCipheriv(CIPHER, key, iv);
  // The cleartext header is authenticated, so a reader cannot be lied to about
  // the scopes or KDF parameters without failing the open outright.
  cipher.setAAD(Buffer.from(headerLine, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    `${MIND_BUNDLE_MAGIC}/${MIND_BUNDLE_CONTAINER_VERSION}`,
    headerLine,
    ciphertext.toString('base64'),
    tag.toString('base64'),
    '',
  ].join('\n');
}

const isPlainRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Parse and validate the cleartext preamble WITHOUT a passphrase, so a
 * destination install can refuse a bundle it does not understand before asking
 * the user for one. Returns `{ header, headerLine, ciphertext, tag }`.
 */
export function readMindBundleHeader(text) {
  if (typeof text !== 'string' || !text.trim()) throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.NOT_A_BUNDLE, 'Mind bundle is empty');
  // Refuse by length before running scrypt over a file from somewhere else.
  if (text.length > MIND_BUNDLE_MAX_CHARS) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.TOO_LARGE, `Mind bundle is larger than this install will open (limit ${MIND_BUNDLE_MAX_CHARS} characters)`);
  }
  const [magicLine, headerLine, ciphertextB64, tagB64] = text.split('\n');
  const [magic, containerVersion] = String(magicLine || '').split('/');
  if (magic !== MIND_BUNDLE_MAGIC) throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.NOT_A_BUNDLE, 'This file is not a PortOS Mind bundle');
  if (Number(containerVersion) !== MIND_BUNDLE_CONTAINER_VERSION) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.VERSION_UNSUPPORTED, `Mind bundle container version ${containerVersion} is not supported by this install (expected ${MIND_BUNDLE_CONTAINER_VERSION})`);
  }
  if (!headerLine || !ciphertextB64 || !tagB64) throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.DAMAGED, 'Mind bundle is truncated or damaged');

  const header = JSON.parse(headerLine);
  if (!isPlainRecord(header) || header.magic !== MIND_BUNDLE_MAGIC
      || header.containerVersion !== MIND_BUNDLE_CONTAINER_VERSION) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.NOT_A_BUNDLE, 'Mind bundle header does not describe a PortOS Mind bundle');
  }
  if (header.payloadVersion !== MIND_BUNDLE_PAYLOAD_VERSION) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.VERSION_UNSUPPORTED, `Mind bundle payload version ${header.payloadVersion} is not supported by this install (expected ${MIND_BUNDLE_PAYLOAD_VERSION})`);
  }
  if (!Array.isArray(header.scopes) || header.scopes.length === 0
      || header.scopes.some((scope) => !PERSISTENT_MIND_BUNDLE_SCOPES.includes(scope))) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.UNKNOWN_SCOPE, 'Mind bundle declares a scope this install does not understand');
  }
  if (!isPlainRecord(header.cipher) || header.cipher.name !== CIPHER || typeof header.cipher.ivB64 !== 'string') {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.CIPHER_UNSUPPORTED, 'Mind bundle declares a cipher this install does not support');
  }
  if (!isPlainRecord(header.kdf) || typeof header.kdf.saltB64 !== 'string') {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.KDF_UNSUPPORTED, 'Mind bundle is missing its key-derivation parameters');
  }
  if (!Array.isArray(header.manifest)) throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.DAMAGED, 'Mind bundle is missing its entry manifest');

  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const iv = Buffer.from(header.cipher.ivB64, 'base64');
  if (tag.length !== TAG_BYTES || iv.length !== IV_BYTES || ciphertext.length === 0) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.DAMAGED, 'Mind bundle is truncated or damaged');
  }
  return { header, headerLine, ciphertext, tag, iv };
}

/**
 * Open a sealed bundle. Throws on an unsupported version, a damaged file, a
 * wrong passphrase, or any tampering — the GCM tag covers both the ciphertext
 * and the cleartext header, so there is no partial-trust path out of here.
 */
export async function openMindBundle({ text, passphrase }) {
  requirePassphrase(passphrase);
  const { header, headerLine, ciphertext, tag, iv } = readMindBundleHeader(text);
  const key = await deriveBundleKey(passphrase, Buffer.from(header.kdf.saltB64, 'base64'), header.kdf);

  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAAD(Buffer.from(headerLine, 'utf8'));
  decipher.setAuthTag(tag);
  // GCM cannot tell a wrong passphrase from a modified file, and neither may
  // this refusal: naming which one it was would make the error an oracle for
  // anyone holding the file. `final()` throws synchronously, so the
  // translation rides a promise chain rather than a try/catch (AGENTS.md).
  const plaintext = await Promise.resolve()
    .then(() => Buffer.concat([decipher.update(ciphertext), decipher.final()]))
    .catch(() => {
      throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.AUTH_FAILED, 'Could not open this Mind bundle: the passphrase is wrong, or the file changed after it was sealed.');
    });
  const payload = JSON.parse(plaintext.toString('utf8'));

  if (!isPlainRecord(payload) || payload.payloadVersion !== MIND_BUNDLE_PAYLOAD_VERSION || !Array.isArray(payload.entries)) {
    throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.PAYLOAD_UNSUPPORTED, 'Mind bundle payload is not in a shape this install understands');
  }
  const entries = payload.entries.map((entry) => {
    const data = Buffer.from(entry.dataB64, 'base64');
    const digest = Buffer.from(sha256Hex(data), 'utf8');
    const declared = Buffer.from(String(entry.sha256), 'utf8');
    if (digest.length !== declared.length || !timingSafeEqual(digest, declared)) {
      throw mindBundleRefusal(MIND_BUNDLE_REFUSALS.INTEGRITY_FAILED, `Mind bundle entry "${entry.name}" failed its integrity check`);
    }
    return { name: entry.name, data };
  });
  return { header, entries };
}

