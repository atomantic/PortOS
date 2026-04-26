import { describe, it, expect } from 'vitest';
import { peerSocketOptions, peerFetch } from './peerHttpClient.js';

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
});
