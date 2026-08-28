import { describe, expect, it } from 'vitest';
import { buildAsyncApiSpec } from './asyncApiSpec.js';

describe('AsyncAPI spec', () => {
  it('builds AsyncAPI 3 channels and direction-aware operations from the socket catalog', () => {
    const spec = buildAsyncApiSpec({ baseUrl: 'https://portos.example.test', version: '1.2.3' });
    expect(spec.asyncapi).toBe('3.0.0');
    expect(spec.info.version).toBe('1.2.3');
    expect(spec.servers.local).toMatchObject({ host: 'portos.example.test', protocol: 'socket.io', pathname: '/socket.io' });
    expect(Object.keys(spec.channels).length).toBeGreaterThan(100);
    expect(Object.values(spec.channels).some((channel) => channel.address === 'cos:mind:event')).toBe(true);
    expect(Object.values(spec.operations).some((operation) => operation.action === 'send')).toBe(true);
    expect(Object.values(spec.operations).some((operation) => operation.action === 'receive')).toBe(true);
    expect(Object.values(spec.components.messages).some((message) => message['x-portos-contract-status'] === 'modeled')).toBe(true);
  });

  it('declares every dynamic channel address parameter', () => {
    const spec = buildAsyncApiSpec({ baseUrl: 'http://example.com', version: '1.2.3' });
    for (const channel of Object.values(spec.channels)) {
      const names = [...channel.address.matchAll(/\{([A-Za-z_$][\w$]*)\}/g)].map((match) => match[1]);
      expect(Object.keys(channel.parameters || {}).sort()).toEqual([...new Set(names)].sort());
    }
  });
});
