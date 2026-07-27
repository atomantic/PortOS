import { describe, it, expect } from 'vitest';
import {
  GROK_VIDEO_DURATIONS, GROK_VIDEO_DEFAULT_DURATION, resolveGrokDuration, nearestGrokDuration,
} from './grokVideoClip.js';

describe('grokVideoClip', () => {
  // The list is the measured answer (#3022), not grok's documented one — three
  // renders requesting 2s/3s/6s all returned the same 6.04s clip. Locking it
  // down here so a future "shorter clips save render time" change has to come
  // with a new measurement rather than an assumption.
  it('offers exactly the clip lengths grok delivers', () => {
    expect(GROK_VIDEO_DURATIONS).toEqual([6, 10]);
    expect(Object.isFrozen(GROK_VIDEO_DURATIONS)).toBe(true);
  });

  it('defaults to the shortest deliverable clip', () => {
    expect(GROK_VIDEO_DEFAULT_DURATION).toBe(Math.min(...GROK_VIDEO_DURATIONS));
  });

  it('passes through a length grok offers', () => {
    for (const d of GROK_VIDEO_DURATIONS) expect(resolveGrokDuration(d)).toBe(d);
    expect(resolveGrokDuration('10')).toBe(10); // multipart bodies arrive as strings
  });

  it.each([
    ['a length grok clamps away', 2],
    ['zero', 0],
    ['a negative', -6],
    ['a non-numeric string', 'six'],
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
  ])('falls back to the default for %s', (_label, input) => {
    expect(resolveGrokDuration(input)).toBe(GROK_VIDEO_DEFAULT_DURATION);
  });

  // `Number([10])` is 10, so a bare Number() coercion would accept an array as
  // a "supported" length. 10 is deliberately used here (not 6) so the assertion
  // can't pass by coincidentally matching the default.
  it('does not coerce a non-scalar into a supported length', () => {
    expect(resolveGrokDuration([10])).toBe(GROK_VIDEO_DEFAULT_DURATION);
    expect(resolveGrokDuration({ valueOf: () => 10 })).toBe(GROK_VIDEO_DEFAULT_DURATION);
  });
});

describe('nearestGrokDuration — translating another backend\'s continuous length (#3135)', () => {
  it('rounds UP to the shortest clip that covers the request', () => {
    // Rounding down would truncate the beat, and there is no render-time or cost
    // saving at a shorter clip, so covering the request is free.
    expect(nearestGrokDuration(1)).toBe(6);
    expect(nearestGrokDuration(6)).toBe(6);
    expect(nearestGrokDuration(7)).toBe(10);
    expect(nearestGrokDuration(8)).toBe(10);
    expect(nearestGrokDuration(10)).toBe(10);
  });

  it('clamps a request longer than the longest clip', () => {
    expect(nearestGrokDuration(30)).toBe(10);
    expect(nearestGrokDuration(600)).toBe(10);
  });

  it('accepts a numeric string', () => {
    expect(nearestGrokDuration('8')).toBe(10);
  });

  it.each([
    ['zero', 0], ['a negative', -6], ['a non-numeric string', 'six'],
    ['null', null], ['undefined', undefined], ['NaN', NaN],
    ['a non-scalar', [8]],
  ])('falls back to the default for %s', (_label, input) => {
    expect(nearestGrokDuration(input)).toBe(GROK_VIDEO_DEFAULT_DURATION);
  });

  it('differs from resolveGrokDuration exactly where it should', () => {
    // resolveGrokDuration VALIDATES an already-grok-shaped request (a third value
    // is bad input at the route boundary); nearestGrokDuration TRANSLATES a
    // continuous one. 8s must not silently become 6s.
    expect(resolveGrokDuration(8)).toBe(6);
    expect(nearestGrokDuration(8)).toBe(10);
  });
});

describe('grokVideoClip client mirror', () => {
  it('matches client/src/lib/grokVideoClip.js', async () => {
    // The walk workflow's Clip picker builds its options from the client mirror,
    // which can't import server code. Without this guard the picker could go on
    // offering a length the server rejects (or stop offering one it accepts) —
    // the same silent drift #3022 was filed to end. If this fails, update the
    // client file to match the server list.
    const clientMirror = await import('../../client/src/lib/grokVideoClip.js');
    expect(clientMirror.GROK_VIDEO_DURATIONS).toEqual([...GROK_VIDEO_DURATIONS]);
    expect(clientMirror.GROK_VIDEO_DEFAULT_DURATION).toBe(GROK_VIDEO_DEFAULT_DURATION);
  });
});
