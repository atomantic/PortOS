import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// peerFetch resolves this install's federation identity through a dynamic
// import of the instances service; stub it so the header assertions don't
// depend on (or create) a real instance identity on disk.
let selfInstanceId = 'self-instance-id';
vi.mock('../services/instances.js', () => ({
  getInstanceId: async () => selfInstanceId,
  UNKNOWN_INSTANCE_ID: 'unknown',
}));

import {
  peerSocketOptions,
  peerSocketOptionsFor,
  peerFetch,
  peerAuthHeaders,
  __resetSelfInstanceIdForTests,
} from './peerHttpClient.js';

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

  describe('peerFetch headers', () => {
    const realFetch = globalThis.fetch;
    let calls;

    beforeEach(() => {
      selfInstanceId = 'self-instance-id';
      __resetSelfInstanceIdForTests();
      calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true };
      };
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      __resetSelfInstanceIdForTests();
    });

    it('identifies this install with X-PortOS-Instance-Id on every hop', async () => {
      await peerFetch('http://peer.example/api/peer-sync/record');
      expect(calls[0].options.headers['X-PortOS-Instance-Id']).toBe('self-instance-id');
    });

    it('sends the instance id alongside the peer Basic credential', async () => {
      await peerFetch('http://peer.example/api/peer-sync/record', {}, { auth: { username: 'alice', password: 'pw' } });
      expect(calls[0].options.headers['X-PortOS-Instance-Id']).toBe('self-instance-id');
      expect(calls[0].options.headers.Authorization).toBe(`Basic ${Buffer.from('alice:pw').toString('base64')}`);
    });

    it('lets explicit caller headers win', async () => {
      await peerFetch('http://peer.example/x', { headers: { 'X-PortOS-Instance-Id': 'explicit' } });
      expect(calls[0].options.headers['X-PortOS-Instance-Id']).toBe('explicit');
    });

    it('does not send the header twice when the caller overrides it in another casing', async () => {
      await peerFetch('http://peer.example/x', { headers: { 'x-portos-instance-id': 'explicit' } });
      const sent = Object.keys(calls[0].options.headers).filter((k) => k.toLowerCase() === 'x-portos-instance-id');
      expect(sent).toEqual(['x-portos-instance-id']);
      expect(calls[0].options.headers['x-portos-instance-id']).toBe('explicit');
    });

    it('does not send the Basic credential twice when the caller sets its own', async () => {
      await peerFetch('http://peer.example/x', { headers: { authorization: 'Bearer t' } }, { auth: { password: 'pw' } });
      const sent = Object.keys(calls[0].options.headers).filter((k) => k.toLowerCase() === 'authorization');
      expect(sent).toEqual(['authorization']);
    });

    it('omits the header entirely when this install has no identity yet', async () => {
      selfInstanceId = 'unknown';
      __resetSelfInstanceIdForTests();
      await peerFetch('http://peer.example/x');
      expect(calls[0].options.headers['X-PortOS-Instance-Id']).toBeUndefined();
    });
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
