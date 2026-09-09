import { describe, it, expect } from 'vitest';
import { beeperSettingsSchema } from './mediaValidation.js';

// SEC-2: `settings.beeper.baseUrl` is prefixed onto every Beeper API call AND
// the realtime WebSocket URL with `Authorization: Bearer <vault token>`
// attached, so a value pointed at an attacker-controlled host turns one
// settings PUT into a credential exfiltration (SSRF). Loopback-only by
// default; `allowNonLoopbackBaseUrl` is the explicit, off-by-default opt-in.
describe('beeperSettingsSchema — baseUrl (SEC-2)', () => {
  const parse = (baseUrl, extra = {}) => beeperSettingsSchema.safeParse({ baseUrl, ...extra });

  it('rejects a value that is not a URL at all', () => {
    expect(parse('not-a-url').success).toBe(false);
  });

  it('rejects a file: URL', () => {
    expect(parse('file:///etc/passwd').success).toBe(false);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(parse('ftp://host').success).toBe(false);
  });

  it('rejects a bare hostname with no scheme', () => {
    expect(parse('example.com').success).toBe(false);
  });

  it('rejects a non-loopback http(s) origin without the opt-in', () => {
    expect(parse('https://example.com').success).toBe(false);
    expect(parse('http://example.com:23373').success).toBe(false);
  });

  it('accepts the shipped loopback default', () => {
    expect(parse('http://127.0.0.1:23373').success).toBe(true);
  });

  it('accepts every loopback spelling', () => {
    for (const origin of ['http://localhost:23373', 'http://127.0.0.5:8443', 'https://[::1]:23373']) {
      expect(parse(origin).success).toBe(true);
    }
  });

  it('accepts a non-loopback origin WITH the opt-in', () => {
    expect(parse('https://example.com', { allowNonLoopbackBaseUrl: true }).success).toBe(true);
  });

  it('still rejects a malformed value even with the opt-in set', () => {
    expect(parse('not-a-url', { allowNonLoopbackBaseUrl: true }).success).toBe(false);
  });

  it('rejects a bare origin carrying a path, query, or credentials', () => {
    expect(parse('http://127.0.0.1:23373/api').success).toBe(false);
    expect(parse('http://127.0.0.1:23373?x=1').success).toBe(false);
    expect(parse('http://user:pass@127.0.0.1:23373').success).toBe(false);
  });

  it('is a no-op when baseUrl is absent — the field stays optional', () => {
    expect(beeperSettingsSchema.safeParse({ enabled: true }).success).toBe(true);
  });

  it('still rejects an unknown key (.strict())', () => {
    expect(beeperSettingsSchema.safeParse({ token: 'smuggled' }).success).toBe(false);
  });
});
