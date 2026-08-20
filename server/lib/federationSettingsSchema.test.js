import { describe, it, expect } from 'vitest';
import { federationSettingsSchema } from './validation.js';

// #4348 — `federation.mediaRouting` decides where UNATTENDED renders go, so a
// shape that slips past validation becomes a job silently routed at the wrong
// peer (or a route the UI can never clear).
describe('federationSettingsSchema.mediaRouting', () => {
  const parse = (mediaRouting) => federationSettingsSchema.safeParse({ mediaRouting });

  it('accepts a fully specified route', () => {
    const result = parse({ image: { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-base' } });
    expect(result.success).toBe(true);
    expect(result.data.mediaRouting.image.modelId).toBe('sdxl-base');
  });

  it('accepts null as the way to turn a kind back off', () => {
    expect(parse({ image: null, video: null }).success).toBe(true);
  });

  it('accepts an absent slice — routing is opt-in', () => {
    expect(federationSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a partial route rather than storing a peer with no model', () => {
    expect(parse({ image: { peerId: 'peer-1' } }).success).toBe(false);
    expect(parse({ image: { peerId: 'peer-1', engine: 'comfy' } }).success).toBe(false);
    expect(parse({ image: { engine: 'comfy', modelId: 'm' } }).success).toBe(false);
  });

  it('rejects an empty identifier that would resolve to no peer at all', () => {
    expect(parse({ image: { peerId: '   ', engine: 'comfy', modelId: 'm' } }).success).toBe(false);
  });

  it('rejects unknown fields inside a route so a stray key cannot ride into the marker', () => {
    expect(parse({ image: { peerId: 'p', engine: 'e', modelId: 'm', url: 'http://example.com' } }).success)
      .toBe(false);
  });

  it('carries an unknown ROUTING kind through, so a downgrade round trip keeps a newer config', () => {
    const result = parse({ audio: { peerId: 'p', engine: 'e', modelId: 'm' } });
    expect(result.success).toBe(true);
    expect(result.data.mediaRouting.audio).toBeTruthy();
  });

  it('keeps validating the pre-existing federation keys alongside routing', () => {
    const result = federationSettingsSchema.safeParse({
      strictPullAuthorization: true,
      mediaProvider: { enabled: true, maxQueuedJobs: 2 },
      mediaRouting: { video: { peerId: 'p', engine: 'e', modelId: 'm' } },
    });
    expect(result.success).toBe(true);
    expect(result.data.strictPullAuthorization).toBe(true);
    expect(result.data.mediaProvider.maxQueuedJobs).toBe(2);
  });
});
