import { describe, expect, it } from 'vitest';
import * as limits from './referenceLimits.js';
import * as capabilities from './imageGenCapabilities.js';
import * as conditioning from './musicVideoConditioning.js';

describe('shared reference limits', () => {
  it('keeps the original exports on the modules that used to own them', () => {
    expect(capabilities.IMAGE_REFERENCE_REQUEST_LIMIT).toBe(limits.IMAGE_REFERENCE_REQUEST_LIMIT);
    expect(conditioning.MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT).toBe(limits.MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT);
    expect(conditioning.MUSIC_VIDEO_MAX_REFERENCE_CHOICES).toBe(limits.IMAGE_REFERENCE_REQUEST_LIMIT);
  });
});
