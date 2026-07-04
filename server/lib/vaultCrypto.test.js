/**
 * Vault crypto unit tests (issue #2140) — pure, no DB. Round-trip, tamper
 * detection (GCM auth), key parsing (hex + base64), ensureVaultKey self-heal
 * against a temp .env, and the per-type display masking.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  encryptValue, decryptValue, ensureVaultKey, isVaultKeyConfigured, maskValue,
} from './vaultCrypto.js';

// Fixed 32-byte test key (hex). Never a real key.
const HEX_KEY = 'a'.repeat(64);
const originalKey = process.env.PRIVACY_VAULT_KEY;

afterAll(() => {
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

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
});

describe('maskValue', () => {
  it('masks last-4 types (ssn / phone / financial_account)', () => {
    expect(maskValue('ssn', '123-45-6789')).toBe('••••6789');
    expect(maskValue('phone', '+1 (503) 555-0142')).toBe('••••0142');
    expect(maskValue('financial_account', 'DE89 3704 0044 0532 0130 00')).toBe('••••3000');
  });

  it('keeps the email domain visible', () => {
    expect(maskValue('email', 'john.doe@example.com')).toBe('j•••@example.com');
    expect(maskValue('email', 'no-at-sign')).toBe('••••');
  });

  it('masks the street segment of an address', () => {
    expect(maskValue('address', '123 Main St, Portland, OR 97201')).toBe('•••, Portland, OR 97201');
    expect(maskValue('address', '123 Main St')).toBe('•••');
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
