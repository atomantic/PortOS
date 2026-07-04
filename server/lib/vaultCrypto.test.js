/**
 * Vault crypto unit tests (issue #2140) — pure, no DB. Round-trip, tamper
 * detection (GCM auth), key parsing (hex + base64), ensureVaultKey self-heal
 * against a temp .env, and the per-type display masking.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  encryptValue, decryptValue, ensureVaultKey, isVaultKeyConfigured, maskValue,
  __setVaultEnvPathForTests,
} from './vaultCrypto.js';

// Fixed 32-byte test key (hex). Never a real key.
const HEX_KEY = 'a'.repeat(64);
const originalKey = process.env.PRIVACY_VAULT_KEY;

// Point the module's .env fallback at a nonexistent file so "key not
// configured" tests can't be satisfied by (or write into) the real install's
// .env. Individual tests re-point it at their own temp files.
const NO_ENV = join(tmpdir(), 'vault-crypto-no-such-dir', '.env');
beforeAll(() => __setVaultEnvPathForTests(NO_ENV));

afterAll(() => {
  __setVaultEnvPathForTests(null);
  if (originalKey === undefined) delete process.env.PRIVACY_VAULT_KEY;
  else process.env.PRIVACY_VAULT_KEY = originalKey;
});

describe('isVaultKeyConfigured', () => {
  it('is false when unset or invalid, true for hex and base64 keys', () => {
    delete process.env.PRIVACY_VAULT_KEY;
    expect(isVaultKeyConfigured()).toBe(false);
    process.env.PRIVACY_VAULT_KEY = 'not-a-key';
    expect(isVaultKeyConfigured()).toBe(false);
    process.env.PRIVACY_VAULT_KEY = 'abcd'; // valid base64, wrong length
    expect(isVaultKeyConfigured()).toBe(false);
    process.env.PRIVACY_VAULT_KEY = HEX_KEY;
    expect(isVaultKeyConfigured()).toBe(true);
    process.env.PRIVACY_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
    expect(isVaultKeyConfigured()).toBe(true);
  });
});

describe('encryptValue / decryptValue', () => {
  beforeEach(() => { process.env.PRIVACY_VAULT_KEY = HEX_KEY; });

  it('round-trips plaintext through the v1 format', () => {
    const ct = encryptValue('123-45-6789');
    expect(ct).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(ct).not.toContain('123-45-6789');
    expect(decryptValue(ct)).toBe('123-45-6789');
  });

  it('round-trips unicode and uses a fresh IV per value', () => {
    const plain = 'Å déjà vu — 東京 🏠';
    const a = encryptValue(plain);
    const b = encryptValue(plain);
    expect(a).not.toBe(b); // per-value random IV
    expect(decryptValue(a)).toBe(plain);
    expect(decryptValue(b)).toBe(plain);
  });

  it('throws on a tampered auth tag', () => {
    const [v, iv, tag, ct] = encryptValue('secret').split(':');
    const tagBuf = Buffer.from(tag, 'base64');
    tagBuf[0] ^= 0xff;
    expect(() => decryptValue(`${v}:${iv}:${tagBuf.toString('base64')}:${ct}`)).toThrow();
  });

  it('throws on tampered ciphertext', () => {
    const [v, iv, tag, ct] = encryptValue('secret').split(':');
    const ctBuf = Buffer.from(ct, 'base64');
    ctBuf[0] ^= 0xff;
    expect(() => decryptValue(`${v}:${iv}:${tag}:${ctBuf.toString('base64')}`)).toThrow();
  });

  it('throws on an unknown version or malformed payload', () => {
    const ct = encryptValue('secret');
    expect(() => decryptValue(ct.replace(/^v1:/, 'v2:'))).toThrow(/format/);
    expect(() => decryptValue('garbage')).toThrow(/format/);
    expect(() => decryptValue('v1:AAAA:BBBB:CCCC')).toThrow();
  });

  it('throws when the key is not configured', () => {
    delete process.env.PRIVACY_VAULT_KEY;
    expect(() => encryptValue('x')).toThrow(/PRIVACY_VAULT_KEY/);
    expect(() => decryptValue('v1:a:b:c')).toThrow(/PRIVACY_VAULT_KEY/);
  });
});

describe('key resolution survives a restart (read-path .env fallback)', () => {
  let dir;
  let envPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-restart-'));
    envPath = join(dir, '.env');
    __setVaultEnvPathForTests(envPath);
    delete process.env.PRIVACY_VAULT_KEY;
  });

  afterEach(() => {
    __setVaultEnvPathForTests(NO_ENV);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads decrypt/status from .env when process.env is empty (post-restart)', () => {
    // Simulate: key generated pre-restart lives in .env; process.env is fresh.
    writeFileSync(envPath, `PRIVACY_VAULT_KEY=${HEX_KEY}\n`);
    process.env.PRIVACY_VAULT_KEY = HEX_KEY;
    const ct = encryptValue('survives restart');
    delete process.env.PRIVACY_VAULT_KEY; // the "restart"
    expect(isVaultKeyConfigured()).toBe(true); // status stays truthful
    expect(decryptValue(ct)).toBe('survives restart'); // reveal works without a prior write
    expect(process.env.PRIVACY_VAULT_KEY).toBe(HEX_KEY); // adopted for the fast path
  });

  it('ignores invalid PRIVACY_VAULT_KEY lines and adopts the first valid one', () => {
    writeFileSync(envPath, `PRIVACY_VAULT_KEY=not-a-key\nPRIVACY_VAULT_KEY=${HEX_KEY}\n`);
    expect(isVaultKeyConfigured()).toBe(true);
    expect(process.env.PRIVACY_VAULT_KEY).toBe(HEX_KEY);
  });
});

describe('ensureVaultKey', () => {
  let dir;
  let envPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-crypto-'));
    envPath = join(dir, '.env');
    delete process.env.PRIVACY_VAULT_KEY;
  });

  it('is a no-op when the env key is already valid', async () => {
    process.env.PRIVACY_VAULT_KEY = HEX_KEY;
    expect(await ensureVaultKey({ envPath })).toEqual({ generated: false });
    expect(existsSync(envPath)).toBe(false);
  });

  it('generates a key, appends it to a fresh .env, and engages encryption', async () => {
    expect(await ensureVaultKey({ envPath })).toEqual({ generated: true });
    const content = readFileSync(envPath, 'utf8');
    expect(content).toMatch(/^PRIVACY_VAULT_KEY=[0-9a-f]{64}\n$/m);
    expect(isVaultKeyConfigured()).toBe(true);
    expect(decryptValue(encryptValue('hello'))).toBe('hello');
  });

  it('appends without clobbering existing .env content (even without trailing newline)', async () => {
    writeFileSync(envPath, 'OTHER_VAR=1');
    await ensureVaultKey({ envPath });
    const content = readFileSync(envPath, 'utf8');
    expect(content).toMatch(/^OTHER_VAR=1\nPRIVACY_VAULT_KEY=[0-9a-f]{64}\n$/);
  });

  it('adopts a valid key already present in .env instead of generating a duplicate', async () => {
    writeFileSync(envPath, `PRIVACY_VAULT_KEY=${HEX_KEY}\n`);
    expect(await ensureVaultKey({ envPath })).toEqual({ generated: false });
    expect(process.env.PRIVACY_VAULT_KEY).toBe(HEX_KEY);
    expect(readFileSync(envPath, 'utf8').match(/PRIVACY_VAULT_KEY/g)).toHaveLength(1);
  });

  it('replaces an invalid env value with a freshly generated key', async () => {
    process.env.PRIVACY_VAULT_KEY = 'stale-garbage';
    expect(await ensureVaultKey({ envPath })).toEqual({ generated: true });
    expect(isVaultKeyConfigured()).toBe(true);
  });

  it('REPLACES an invalid PRIVACY_VAULT_KEY line instead of appending a duplicate', async () => {
    // e.g. the user uncommented the .env.example placeholder. Appending around
    // it would let the invalid first line win future reads → silent key
    // rotation on every restart, orphaning previously encrypted rows.
    writeFileSync(envPath, 'OTHER_VAR=1\nPRIVACY_VAULT_KEY=<64 hex chars>\nLAST_VAR=2\n');
    expect(await ensureVaultKey({ envPath })).toEqual({ generated: true });
    const content = readFileSync(envPath, 'utf8');
    expect(content.match(/^PRIVACY_VAULT_KEY=/gm)).toHaveLength(1);
    expect(content).toMatch(/^PRIVACY_VAULT_KEY=[0-9a-f]{64}$/m);
    expect(content).toContain('OTHER_VAR=1');
    expect(content).toContain('LAST_VAR=2');
    // Idempotent across the next "restart": the same key is adopted, not rotated.
    const adopted = process.env.PRIVACY_VAULT_KEY;
    delete process.env.PRIVACY_VAULT_KEY;
    expect(await ensureVaultKey({ envPath })).toEqual({ generated: false });
    expect(process.env.PRIVACY_VAULT_KEY).toBe(adopted);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
});

describe('maskValue', () => {
  it('masks last-4 types (ssn / phone / financial_account)', () => {
    expect(maskValue('ssn', '123-45-6789')).toBe('••••6789');
    expect(maskValue('phone', '+1 (503) 555-0142')).toBe('••••0142');
    expect(maskValue('financial_account', 'DE89 3704 0044 0532 0130 00')).toBe('••••3000');
  });

  it('fully masks a last-4 value of 4 or fewer characters (never full disclosure)', () => {
    expect(maskValue('financial_account', '1234')).toBe('••••');
    expect(maskValue('ssn', '123')).toBe('••••');
    expect(maskValue('phone', 'x1y2')).toBe('••••');
  });

  it('keeps the email domain visible', () => {
    expect(maskValue('email', 'john.doe@example.com')).toBe('j•••@example.com');
    expect(maskValue('email', 'no-at-sign')).toBe('••••');
  });

  it('masks the street segment of an address', () => {
    expect(maskValue('address', '123 Main St, Portland, OR 97201')).toBe('•••, Portland, OR 97201');
    expect(maskValue('address', '123 Main St')).toBe('•••');
    // A leading non-street segment must not shift the street into view.
    expect(maskValue('address', 'c/o Adam Eivy, 123 Main St, Portland, OR 97201')).toBe('•••, Portland, OR 97201');
    // Two segments: only the last is visible (both would disclose the street).
    expect(maskValue('address', '123 Main St, Portland')).toBe('•••, Portland');
  });

  it('falls back to first-char masking for other types', () => {
    expect(maskValue('legal_name', 'Adam Eivy')).toBe('A•••');
    expect(maskValue('dob', '1980-01-02')).toBe('1•••');
    expect(maskValue('custom', 'whatever')).toBe('w•••');
  });

  it('fully masks empty or non-string values', () => {
    expect(maskValue('legal_name', '')).toBe('••••');
    expect(maskValue('ssn', undefined)).toBe('••••');
  });

  it('never returns the plaintext', () => {
    for (const type of ['ssn', 'phone', 'email', 'address', 'legal_name', 'custom']) {
      const masked = maskValue(type, 'sensitive-value@example.com');
      expect(masked).not.toBe('sensitive-value@example.com');
      expect(masked).not.toContain('sensitive-value');
    }
  });
});
