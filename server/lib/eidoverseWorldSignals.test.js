import { describe, expect, it } from 'vitest';
import { eidoverseHostId, eidoversePeerId } from './eidoverseWorldSignals.js';

describe('Eidoverse public identity compatibility', () => {
  // Fixed outputs from the pre-extraction collector: changing these identities
  // breaks persisted world metadata and destination links across upgrades.
  it('preserves namespaces, normalization, fallback selection, and the 256-character input cap', () => {
    const fixtures = [
      ['fixture-instance', 'hst_25cf5b1a0b1f', 'peer-bd6bd9c7a57a'],
      ['\t fixture\u0000instance\u007f \n', 'hst_8df6a4a59860', 'peer-7282d94f0db2'],
      ['', 'hst_fe23cde7412c', 'peer-170b31bba778'],
      [undefined, 'hst_fe23cde7412c', 'peer-170b31bba778'],
      [123, 'hst_fe23cde7412c', 'peer-f486350022b1'],
      ['x'.repeat(257), 'hst_4c1dcf8b9a4e', 'peer-5db89d907972'],
    ];
    for (const [instanceId, hostId, peerId] of fixtures) {
      expect(eidoverseHostId(instanceId)).toBe(hostId);
      expect(eidoversePeerId({ instanceId, id: 'legacy-peer' })).toBe(peerId);
    }
    expect(eidoversePeerId({})).toBe('peer-f486350022b1');
  });
});
