import { describe, it, expect } from 'vitest';
import {
  REACTOR_MAX_PROMPT_LENGTH, REACTOR_CLIP_FPS, REACTOR_MIN_CLIP_SECONDS,
  REACTOR_MAX_CLIP_SECONDS, REACTOR_CLIP_LENGTHS, REACTOR_DEFAULT_CLIP_LENGTH,
  reactorClipLengthLabel,
} from './reactorVideoClip.js';

describe('reactorVideoClip', () => {
  it('offers only lengths fast-h3 accepts, in ascending order', () => {
    expect(Object.isFrozen(REACTOR_CLIP_LENGTHS)).toBe(true);
    expect([...REACTOR_CLIP_LENGTHS]).toEqual([...REACTOR_CLIP_LENGTHS].sort((a, b) => a - b));
    for (const seconds of REACTOR_CLIP_LENGTHS) {
      expect(seconds).toBeGreaterThanOrEqual(REACTOR_MIN_CLIP_SECONDS);
      expect(seconds).toBeLessThanOrEqual(REACTOR_MAX_CLIP_SECONDS);
    }
    expect(REACTOR_CLIP_LENGTHS).toContain(REACTOR_MIN_CLIP_SECONDS);
    expect(REACTOR_CLIP_LENGTHS).toContain(REACTOR_MAX_CLIP_SECONDS);
    expect(REACTOR_CLIP_LENGTHS).toContain(REACTOR_DEFAULT_CLIP_LENGTH);
  });

  // The whole reason a picker replaced a free-text seconds box is that every
  // offered value has to be one the API can actually render. Anything between
  // the endpoints must land on a whole frame at 24fps.
  it('offers only frame-aligned interior lengths', () => {
    const interior = REACTOR_CLIP_LENGTHS
      .filter((s) => s !== REACTOR_MIN_CLIP_SECONDS && s !== REACTOR_MAX_CLIP_SECONDS);
    expect(interior.length).toBeGreaterThan(0);
    for (const seconds of interior) {
      expect(Number.isInteger(seconds * REACTOR_CLIP_FPS)).toBe(true);
    }
    expect(Number.isInteger(REACTOR_MAX_CLIP_SECONDS * REACTOR_CLIP_FPS)).toBe(true);
  });

  it('names the endpoints so the odd numbers read as bounds, not typos', () => {
    expect(reactorClipLengthLabel(REACTOR_MIN_CLIP_SECONDS)).toBe('5.167 seconds (min)');
    expect(reactorClipLengthLabel(REACTOR_MAX_CLIP_SECONDS)).toBe('14.375 seconds (max)');
    expect(reactorClipLengthLabel(8)).toBe('8 seconds');
  });
});

describe('reactorVideoClip client mirror', () => {
  it('matches client/src/lib/reactorVideoClip.js', async () => {
    // The VideoGen prompt counter and clip-length picker build from the client
    // mirror, which can't import server code. Without this guard the form could
    // go on accepting an 800+ character prompt the API rejects, or offering a
    // clip length the service refuses — exactly the drift that made a long
    // prompt fail at Generate instead of in the field.
    const clientMirror = await import('../../client/src/lib/reactorVideoClip.js');
    expect(clientMirror.REACTOR_MAX_PROMPT_LENGTH).toBe(REACTOR_MAX_PROMPT_LENGTH);
    expect(clientMirror.REACTOR_MIN_CLIP_SECONDS).toBe(REACTOR_MIN_CLIP_SECONDS);
    expect(clientMirror.REACTOR_MAX_CLIP_SECONDS).toBe(REACTOR_MAX_CLIP_SECONDS);
    expect(clientMirror.REACTOR_DEFAULT_CLIP_LENGTH).toBe(REACTOR_DEFAULT_CLIP_LENGTH);
    expect([...clientMirror.REACTOR_CLIP_LENGTHS]).toEqual([...REACTOR_CLIP_LENGTHS]);
    for (const seconds of REACTOR_CLIP_LENGTHS) {
      expect(clientMirror.reactorClipLengthLabel(seconds)).toBe(reactorClipLengthLabel(seconds));
    }
  });
});
