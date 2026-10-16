import { describe, expect, it } from 'vitest';
import { safeFailureReason } from './fidelityDiagnostic.js';

describe('safeFailureReason', () => {
  it('keeps a plain failure message and its error name', () => {
    expect(safeFailureReason(Error('Fidelity Chrome/FFmpeg toolchain unavailable.'))).toBe('Fidelity Chrome/FFmpeg toolchain unavailable.');
    expect(safeFailureReason(new TypeError('x is not a function'))).toBe('TypeError: x is not a function');
  });

  it.each([
    ['GitHub token', 'request failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefgh'],
    ['bearer header', 'bad header Bearer abc123def456ghi789', 'abc123def456'],
    ['key=value secret', 'env GITHUB_TOKEN=sup3rs3cretvalue rejected', 'sup3rs3cretvalue'],
    ['api key', 'api_key: sk-live-12345678', 'sk-live-12345678'],
    ['email', 'account alice@example.com denied', 'alice@example.com'],
    ['long opaque value', `blob ${'Ab1'.repeat(20)}`, 'Ab1Ab1Ab1Ab1'],
    ['posix home path', 'ENOENT /Users/alice/secret-project/receipt.json', 'alice'],
    ['linux home path', 'cannot read /home/bob/.config/gh/hosts.yml', 'bob'],
    ['IPv4 address', 'connect ECONNREFUSED 192.0.2.10:443', '192.0.2.10'],
    ['quoted secret', 'password="alpha beta" rejected', 'beta'],
    ['windows path', 'missing C:\\Users\\carol\\AppData\\x.json', 'carol'],
  ])('redacts %s', (_label, message, secret) => {
    const reason = safeFailureReason(Error(message));
    expect(reason).not.toContain(secret);
    expect(reason.length).toBeGreaterThan(0);
  });

  it('never echoes a custom error name and bounds the whole reason', () => {
    const custom = Object.assign(Error('boom'), { name: 'Leak /Users/alice\nsecret' });
    expect(safeFailureReason(custom)).toBe('boom');
    const long = Object.assign(new TypeError('word '.repeat(200)));
    expect(safeFailureReason(long).length).toBeLessThanOrEqual(200);
  });

  it('bounds length and returns empty for non-errors', () => {
    expect(safeFailureReason(Error('word '.repeat(200))).length).toBeLessThanOrEqual(200);
    expect(safeFailureReason(undefined)).toBe('');
  });
});
