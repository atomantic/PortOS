import { describe, it, expect } from 'vitest';
import { peerSocketOptions, peerSocketOptionsFor, peerFetch, peerAuthHeaders } from './peerHttpClient.js';

describe('peerHttpClient', () => {
  it('peerSocketOptions disables cert validation for Socket.IO peer connections', () => {
    expect(peerSocketOptions.rejectUnauthorized).toBe(false);
    expect(peerSocketOptions.transports).toContain('websocket');
  });

  it('peerFetch falls through to global fetch for http:// URLs', async () => {
    await expect(peerFetch('http://127.0.0.1:1/should-not-exist', {
      signal: AbortSignal.timeout(50)
    })).rejects.toBeDefined();
  });

  describe('peerAuthHeaders', () => {
    it('returns an empty object when the peer has no credential', () => {
      expect(peerAuthHeaders(null)).toEqual({});
      expect(peerAuthHeaders({})).toEqual({});
      expect(peerAuthHeaders({ auth: null })).toEqual({});
      expect(peerAuthHeaders({ auth: { username: '', password: '' } })).toEqual({});
    });

    it('builds a Basic header from username + password', () => {
      const headers = peerAuthHeaders({ auth: { username: 'alice', password: 's3cret' } });
      expect(headers.Authorization).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
    });

    it('supports a password-only credential (empty username)', () => {
      const headers = peerAuthHeaders({ auth: { password: 'p@ss' } });
      expect(headers.Authorization).toBe(`Basic ${Buffer.from(':p@ss').toString('base64')}`);
    });
  });

  describe('peerSocketOptionsFor', () => {
    it('returns the bare options object when no credential is set', () => {
      expect(peerSocketOptionsFor({})).toBe(peerSocketOptions);
    });

    it('injects extraHeaders with the Basic credential when present', () => {
      const opts = peerSocketOptionsFor({ auth: { username: 'bob', password: 'pw' } });
      expect(opts.rejectUnauthorized).toBe(false);
      expect(opts.extraHeaders.Authorization).toBe(`Basic ${Buffer.from('bob:pw').toString('base64')}`);
    });
  });
});
