import { describe, it, expect } from 'vitest';
import { decodeBase32, generateHotp, generateTotp, parseTotpSetupKey } from './totp.js';

// RFC 6238 Appendix B seeds: the ASCII string "1234567890" repeated to the
// algorithm's block-friendly length (20 / 32 / 64 bytes).
const SEEDS = {
  SHA1: Buffer.from('12345678901234567890'),
  SHA256: Buffer.from('12345678901234567890123456789012'),
  SHA512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
};

// [unix seconds, SHA1, SHA256, SHA512] — RFC 6238 Appendix B, 8 digits, 30 s step.
const RFC6238_VECTORS = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

// RFC 4648 §10 test vector: "foobar" ↔ MZXW6YTBOI======.
const BASE32_FOOBAR = 'MZXW6YTBOI======';
// "12345678901234567890" in Base32 (the common SHA1 test seed).
const SHA1_SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('generateTotp — RFC 6238 Appendix B', () => {
  it.each(RFC6238_VECTORS)('t=%s matches every algorithm', (seconds, sha1, sha256, sha512) => {
    const now = seconds * 1000;
    expect(generateTotp({ key: SEEDS.SHA1, algorithm: 'SHA1', digits: 8 }, { now }).code).toBe(sha1);
    expect(generateTotp({ key: SEEDS.SHA256, algorithm: 'SHA256', digits: 8 }, { now }).code).toBe(sha256);
    expect(generateTotp({ key: SEEDS.SHA512, algorithm: 'SHA512', digits: 8 }, { now }).code).toBe(sha512);
  });

  it('reports when the current step expires', () => {
    expect(generateTotp({ key: SEEDS.SHA1 }, { now: 59_000 }).expiresAt).toBe(60_000);
    expect(generateTotp({ key: SEEDS.SHA1, period: 60 }, { now: 61_000 }).expiresAt).toBe(120_000);
  });

  it('generates the same code from the Base32 form of the seed', () => {
    const fromKey = generateTotp({ key: SEEDS.SHA1, digits: 8 }, { now: 59_000 }).code;
    expect(generateTotp({ secret: SHA1_SEED_BASE32, digits: 8 }, { now: 59_000 }).code).toBe(fromKey);
  });
});

describe('generateHotp — RFC 4226 Appendix D', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it.each(expected.map((code, counter) => [counter, code]))('counter %s → %s', (counter, code) => {
    expect(generateHotp(SEEDS.SHA1, counter)).toBe(code);
  });
});

describe('decodeBase32', () => {
  it('decodes the RFC 4648 vector, ignoring case, spacing and padding', () => {
    expect(decodeBase32(BASE32_FOOBAR).toString()).toBe('foobar');
    expect(decodeBase32('mzxw 6ytb-oi').toString()).toBe('foobar');
  });

  it('refuses non-alphabet characters without echoing the input', () => {
    expect(() => decodeBase32('MZXW1!')).toThrow('TOTP setup key is not valid Base32');
  });
});

describe('parseTotpSetupKey', () => {
  it('accepts a raw grouped setup key with defaults', () => {
    expect(parseTotpSetupKey('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual({
      secret: SHA1_SEED_BASE32, algorithm: 'SHA1', digits: 6, period: 30,
    });
  });

  it('reads algorithm, digits and period from an otpauth://totp URI', () => {
    const uri = `otpauth://totp/Example:alice@example.com?secret=${SHA1_SEED_BASE32}&issuer=Example&algorithm=SHA256&digits=8&period=60`;
    expect(parseTotpSetupKey(uri)).toEqual({ secret: SHA1_SEED_BASE32, algorithm: 'SHA256', digits: 8, period: 60 });
  });

  it.each([
    ['HOTP URIs', `otpauth://hotp/Example?secret=${SHA1_SEED_BASE32}&counter=1`, 'Only time-based'],
    ['unknown algorithms', `otpauth://totp/x?secret=${SHA1_SEED_BASE32}&algorithm=MD5`, 'algorithm'],
    ['out-of-range digits', `otpauth://totp/x?secret=${SHA1_SEED_BASE32}&digits=4`, 'digits'],
    ['a missing secret', 'otpauth://totp/x?issuer=Example', 'empty'],
    ['short seeds', 'MZXW6YTBOI', 'at least 10 bytes'],
  ])('refuses %s', (_label, input, message) => {
    expect(() => parseTotpSetupKey(input)).toThrow(message);
  });

  it('never puts the submitted secret into the error message', () => {
    const secretish = 'ZZZZ!SECRETVALUE';
    let caught;
    try { parseTotpSetupKey(secretish); } catch (error) { caught = error; }
    expect(caught.code).toBe('INVALID_TOTP_SECRET');
    expect(caught.message).not.toContain('SECRETVALUE');
  });
});
