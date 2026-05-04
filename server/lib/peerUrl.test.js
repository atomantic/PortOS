import { describe, it, expect } from 'vitest';
import { peerBaseUrl } from './peerUrl.js';

describe('peerBaseUrl', () => {
  it('builds an https URL when peer.host is present', () => {
    expect(peerBaseUrl({ host: 'box.tail-net.ts.net', port: 5555 }))
      .toBe('https://box.tail-net.ts.net:5555');
  });

  it('falls back to http with peer.address when host is absent', () => {
    expect(peerBaseUrl({ address: '100.64.0.1', port: 5555 }))
      .toBe('http://100.64.0.1:5555');
  });

  it('prefers host over address when both are set', () => {
    expect(peerBaseUrl({ host: 'box.example', address: '10.0.0.1', port: 80 }))
      .toBe('https://box.example:80');
  });

  it('uses http when host is empty string (falsy)', () => {
    expect(peerBaseUrl({ host: '', address: '10.0.0.2', port: 5555 }))
      .toBe('http://10.0.0.2:5555');
  });
});
