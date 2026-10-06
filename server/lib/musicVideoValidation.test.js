import { describe, it, expect } from 'vitest';
import { musicVideoPublishPrepareSchema } from './musicVideoValidation.js';

describe('musicVideoPublishPrepareSchema (DistroKid release answers)', () => {
  const parse = (body) => musicVideoPublishPrepareSchema.safeParse(body);

  it('accepts the release answers the publish panel sends', () => {
    expect(parse({ genre: 'Electronic', secondaryGenre: 'Pop', language: 'English', songwriterRole: 'both', newArtistProfile: false, preserveCaps: true, performerName: 'Alice Example', performerRole: 'Vocals', producerName: 'Alice Example', previewStartSec: 42 }).success).toBe(true);
  });

  it('refuses an unknown songwriter role, an out-of-range preview start, and unknown keys', () => {
    expect(parse({ songwriterRole: 'producer' }).success).toBe(false);
    expect(parse({ previewStartSec: -1 }).success).toBe(false);
    expect(parse({ previewStartSec: 3601 }).success).toBe(false);
    expect(parse({ stores: ['spotify'] }).success).toBe(false);
  });
});
