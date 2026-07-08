import { describe, it, expect, afterEach } from 'vitest';
import { isTokenExpired, withExpiry, getRedirectUri } from './spotifyAuth.js';

describe('spotifyAuth pure helpers', () => {
  describe('withExpiry', () => {
    it('stamps an absolute expires_at from expires_in seconds', () => {
      const now = 1_700_000_000_000;
      const tokens = withExpiry({ access_token: 'a', expires_in: 3600 }, now);
      expect(tokens.expires_at).toBe(now + 3600 * 1000);
      expect(tokens.access_token).toBe('a');
    });

    it('sets expires_at to null when expires_in is absent/non-numeric', () => {
      expect(withExpiry({ access_token: 'a' }).expires_at).toBeNull();
      expect(withExpiry({ access_token: 'a', expires_in: 'nope' }).expires_at).toBeNull();
    });
  });

  describe('isTokenExpired', () => {
    const now = 1_700_000_000_000;

    it('is false for a token comfortably before expiry', () => {
      expect(isTokenExpired({ access_token: 'a', expires_at: now + 600_000 }, now)).toBe(false);
    });

    it('is true within the refresh skew window', () => {
      expect(isTokenExpired({ access_token: 'a', expires_at: now + 30_000 }, now, 60_000)).toBe(true);
    });

    it('is true past expiry', () => {
      expect(isTokenExpired({ access_token: 'a', expires_at: now - 1 }, now)).toBe(true);
    });

    it('treats a missing access_token or expires_at as expired', () => {
      expect(isTokenExpired({ expires_at: now + 600_000 }, now)).toBe(true);
      expect(isTokenExpired({ access_token: 'a' }, now)).toBe(true);
      expect(isTokenExpired(null, now)).toBe(true);
    });
  });

  describe('getRedirectUri', () => {
    const savedEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it('honors an explicit SPOTIFY_REDIRECT_URI override', () => {
      process.env.SPOTIFY_REDIRECT_URI = 'https://example.test/api/spotify/oauth/callback';
      expect(getRedirectUri()).toBe('https://example.test/api/spotify/oauth/callback');
    });

    it('builds the callback path from PUBLIC_HOST/PORT otherwise', () => {
      delete process.env.SPOTIFY_REDIRECT_URI;
      process.env.PUBLIC_HOST = 'myhost';
      process.env.PORT = '5555';
      expect(getRedirectUri()).toBe('http://myhost:5555/api/spotify/oauth/callback');
    });
  });
});
