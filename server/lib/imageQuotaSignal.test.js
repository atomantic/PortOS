import { describe, it, expect } from 'vitest';
import {
  parseQuotaDeferral, parseGoDuration, formatDeferral, MAX_QUOTA_DEFERRAL_MS,
} from './imageQuotaSignal.js';

// Verbatim shapes recorded by this install on 2026-10-17. Antigravity relays
// generate_image's failure through whatever prose the driving agent chose, so
// the same outage produced three different wrappings within one afternoon. They
// are fixtures precisely because the wrapping is NOT stable — a parser written
// against one of them silently stops working on the next.
const NARRATED = 'Agy did not produce an image at the directed path. Agy said: "I have delegated the image generation request to the `image-generator` subagent and am waiting for it to finish generating the comic page. The `generate_image` tool failed due to a rate-limit / quota exhaustion error: - **Error:** `429 RESOURCE_EXHAUSTED: "You have exhausted your capacity on this model. Your quota will reset after 2h26m1s."`"';
const BLOCKQUOTED = 'Agy did not produce an image at the directed path. Agy said: "Generating the comic page image via the `image-generator` subagent. The `generate_image` tool failed due to a rate-limit / quota exhaustion error: > `429 RESOURCE_EXHAUSTED: "You have exhausted your capacity on this model. Your quota will reset after 4h12m35s."`"';
const FENCED = 'Agy did not produce an image at the directed path. Agy said: "``` image failed to generate: failed to generate content: 429 Too Many Requests, body: {"error": {"code": 429, "message": "You have exhausted your capacity on this model. Your quota will reset after 2h29m35s.", "status": "RESOURCE_EXHAUSTED"}} ```"';

describe('parseQuotaDeferral', () => {
  it.each([
    ['narrated bullet form', NARRATED, 2 * 3600 + 26 * 60 + 1],
    ['blockquote form', BLOCKQUOTED, 4 * 3600 + 12 * 60 + 35],
    ['fenced JSON body form', FENCED, 2 * 3600 + 29 * 60 + 35],
  ])('reads the reset out of the %s', (_label, text, expectedSeconds) => {
    expect(parseQuotaDeferral(text, { now: 0 })).toEqual({
      resumeAt: expectedSeconds * 1000,
      resetsInMs: expectedSeconds * 1000,
    });
  });

  // The failure text embeds the agent's own words about the page being drawn,
  // so a comic script is effectively untrusted input to this parser. Parking
  // the whole render queue for hours because a character mentioned a quota
  // would be a worse bug than the one this fixes.
  it.each([
    ['prose mentioning a quota office and a duration', 'KITTA: "The quota office resets in 3h20m, they said." She did not believe it.'],
    ['an exhaustion marker with no stated reset', 'Agy said: "429 RESOURCE_EXHAUSTED: capacity gone." No reset was given.'],
    ['a reset with no exhaustion marker', 'The render pipeline resets in 45m for maintenance.'],
    ['a bare number where a duration belongs', 'RESOURCE_EXHAUSTED. Your quota will reset after 12.'],
    ['empty input', ''],
    ['a non-string', null],
  ])('returns null for %s', (_label, text) => {
    expect(parseQuotaDeferral(text, { now: 0 })).toBeNull();
  });

  it('refuses a deferral longer than the cap rather than parking for a day', () => {
    const text = 'RESOURCE_EXHAUSTED: Your quota will reset after 48h0m0s.';
    expect(parseQuotaDeferral(text, { now: 0 })).toBeNull();
    const withinCap = 'RESOURCE_EXHAUSTED: Your quota will reset after 23h0m0s.';
    expect(parseQuotaDeferral(withinCap, { now: 0 })?.resetsInMs).toBe(23 * 3600 * 1000);
    expect(MAX_QUOTA_DEFERRAL_MS).toBe(24 * 3600 * 1000);
  });

  it('refuses a sub-second reset that would re-dispatch into the same wall', () => {
    expect(parseQuotaDeferral('RESOURCE_EXHAUSTED: Your quota will reset after 0s.', { now: 0 })).toBeNull();
  });

  it('anchors resumeAt to the supplied clock', () => {
    const now = 1_700_000_000_000;
    expect(parseQuotaDeferral(NARRATED, { now }).resumeAt).toBe(now + (2 * 3600 + 26 * 60 + 1) * 1000);
  });
});

describe('parseGoDuration', () => {
  it.each([
    ['2h26m1s', 8_761_000],
    ['45m10s', 2_710_000],
    ['30s', 30_000],
    ['1h', 3_600_000],
  ])('parses %s', (text, expected) => {
    expect(parseGoDuration(text)).toBe(expected);
  });

  it.each(['12', 'soon', '', '2 hours', '2h30'])('rejects %s', (text) => {
    expect(parseGoDuration(text)).toBeNull();
  });
});

describe('formatDeferral', () => {
  it.each([
    [8_761_000, '2h26m'],
    [3_600_000, '1h'],
    [2_710_000, '45m'],
    [30_000, '30s'],
    [0, 'now'],
    [-5, 'now'],
  ])('renders %i as %s', (ms, expected) => {
    expect(formatDeferral(ms)).toBe(expected);
  });
});
