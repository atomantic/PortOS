import { describe, it, expect } from 'vitest';
import {
  resolveTakeoutInstant,
  resolveLatLng,
  friendlySemanticType,
  visitToCandidate,
  extractVisits,
  takeoutLocationCandidates,
  summarizeLocationCandidates,
  parseTakeoutJsonText,
} from './takeoutLocationImport.js';

// A classic semantic-location-history file (server-side Timeline, pre-2024).
const classicFile = {
  timelineObjects: [
    {
      placeVisit: {
        location: {
          name: 'Blue Bottle Coffee',
          address: '66 Mint St, San Francisco, CA',
          placeId: 'ChIJ-blue-bottle',
          latitudeE7: 377834990,
          longitudeE7: -1224019870,
          semanticType: 'TYPE_SEARCHED_ADDRESS',
        },
        duration: { startTimestamp: '2021-03-01T15:00:00Z', endTimestamp: '2021-03-01T16:30:00Z' },
      },
    },
    // A travel/activity segment — must be dropped (no placeVisit).
    { activitySegment: { distance: 1200 } },
    {
      placeVisit: {
        location: { name: 'Home', placeId: 'ChIJ-home', semanticType: 'TYPE_HOME' },
        // older classic files: epoch-ms strings
        duration: { startTimestampMs: '1614624300000', endTimestampMs: '1614640000000' },
      },
    },
  ],
};

// An on-device Timeline export (2024+).
const onDeviceFile = {
  semanticSegments: [
    {
      startTime: '2024-06-15T09:00:00.000-07:00',
      endTime: '2024-06-15T10:15:00.000-07:00',
      visit: {
        topCandidate: {
          placeId: 'ChIJ-work',
          semanticType: 'INFERRED_WORK',
          placeLocation: { latLng: '37.4220°, -122.0840°' },
        },
      },
    },
    // A travel segment — no `visit`, must be dropped.
    { startTime: '2024-06-15T10:15:00-07:00', endTime: '2024-06-15T10:30:00-07:00', activity: { distanceMeters: 900 } },
  ],
};

describe('resolveTakeoutInstant', () => {
  it('passes ISO-8601 timestamps through (with offset)', () => {
    expect(resolveTakeoutInstant('2024-06-15T09:00:00.000-07:00')).toBe('2024-06-15T16:00:00.000Z');
  });
  it('passes UTC ISO through', () => {
    expect(resolveTakeoutInstant('2021-03-01T15:00:00Z')).toBe('2021-03-01T15:00:00.000Z');
  });
  it('treats all-digit strings as epoch milliseconds', () => {
    expect(resolveTakeoutInstant('1614624300000')).toBe('2021-03-01T18:45:00.000Z');
  });
  it('returns null for empty/unparseable/nullish values', () => {
    expect(resolveTakeoutInstant('')).toBeNull();
    expect(resolveTakeoutInstant(null)).toBeNull();
    expect(resolveTakeoutInstant(undefined)).toBeNull();
    expect(resolveTakeoutInstant('not a date')).toBeNull();
  });
});

describe('resolveLatLng', () => {
  it('converts E7 integers to rounded degrees', () => {
    expect(resolveLatLng({ latitudeE7: 377834990, longitudeE7: -1224019870 }))
      .toEqual({ lat: 37.783499, lng: -122.401987 });
  });
  it('parses a degree-symbol latLng string', () => {
    expect(resolveLatLng({ latLng: '37.4220°, -122.0840°' })).toEqual({ lat: 37.422, lng: -122.084 });
  });
  it('parses a geo: latLng string', () => {
    expect(resolveLatLng({ latLng: 'geo:37.422,-122.084' })).toEqual({ lat: 37.422, lng: -122.084 });
  });
  it('returns null when neither shape yields two coords', () => {
    expect(resolveLatLng({})).toBeNull();
    expect(resolveLatLng({ latLng: 'nope' })).toBeNull();
    expect(resolveLatLng({ latitudeE7: 100 })).toBeNull();
  });
  it('rejects nullish/blank E7 values instead of coercing them to 0', () => {
    // Number(null)/Number('') are both 0 — a coord-less classic visit must stay
    // null, not land on {lat:0,lng:0}.
    expect(resolveLatLng({ latitudeE7: null, longitudeE7: null })).toBeNull();
    expect(resolveLatLng({ latitudeE7: '', longitudeE7: '' })).toBeNull();
    expect(resolveLatLng({ latitudeE7: 377834990, longitudeE7: null })).toBeNull();
  });
});

describe('friendlySemanticType', () => {
  it('maps common Google types to friendly words', () => {
    expect(friendlySemanticType('TYPE_HOME')).toBe('Home');
    expect(friendlySemanticType('INFERRED_WORK')).toBe('Work');
    expect(friendlySemanticType('TYPE_SEARCHED_ADDRESS')).toBe('Searched address');
  });
  it('title-cases unknown types', () => {
    expect(friendlySemanticType('TYPE_GYM')).toBe('Gym');
  });
  it('drops empty/unknown', () => {
    expect(friendlySemanticType(null)).toBeNull();
    expect(friendlySemanticType('UNKNOWN')).toBeNull();
    expect(friendlySemanticType('TYPE_UNKNOWN')).toBeNull();
  });
});

describe('extractVisits', () => {
  it('extracts classic placeVisit entries and drops travel segments', () => {
    const visits = extractVisits(classicFile);
    expect(visits).toHaveLength(2);
    expect(visits[0]).toMatchObject({
      name: 'Blue Bottle Coffee',
      placeId: 'ChIJ-blue-bottle',
      startTime: '2021-03-01T15:00:00Z',
      lat: 37.783499,
      lng: -122.401987,
    });
    // second visit uses epoch-ms duration keys
    expect(visits[1]).toMatchObject({ name: 'Home', startTime: '1614624300000' });
  });

  it('extracts on-device semanticSegments visits and drops non-visit segments', () => {
    const visits = extractVisits(onDeviceFile);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({
      placeId: 'ChIJ-work',
      semanticType: 'INFERRED_WORK',
      lat: 37.422,
      lng: -122.084,
    });
  });

  it('returns [] for junk / missing arrays', () => {
    expect(extractVisits(null)).toEqual([]);
    expect(extractVisits({})).toEqual([]);
    expect(extractVisits(42)).toEqual([]);
  });
});

describe('visitToCandidate', () => {
  it('maps a classic visit to a place.visit candidate with duration', () => {
    const [visit] = extractVisits(classicFile);
    const c = visitToCandidate(visit);
    expect(c).toMatchObject({
      source: 'location',
      kind: 'place.visit',
      happenedAt: '2021-03-01T15:00:00.000Z',
      durationS: 90 * 60,
      title: 'Blue Bottle Coffee',
    });
    expect(c.summary).toBe('66 Mint St, San Francisco, CA');
    expect(c.metadata).toMatchObject({ placeId: 'ChIJ-blue-bottle', lat: 37.783499, lng: -122.401987 });
  });

  it('falls back to friendly semantic type for the title when no name/address', () => {
    const c = visitToCandidate({ startTime: '2021-01-01T00:00:00Z', semanticType: 'TYPE_HOME', placeId: 'p' });
    expect(c.title).toBe('Home');
  });

  it('builds a stable dedupe key from placeId + visit start', () => {
    const [visit] = extractVisits(classicFile);
    const a = visitToCandidate(visit);
    const b = visitToCandidate({ ...visit });
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.dedupeKey).toBe('location:ChIJ-blue-bottle:2021-03-01T15:00:00.000Z');
  });

  it('uses rounded lat/lng as the dedupe fallback when placeId is absent (no title-only collapse)', () => {
    const base = { startTime: '2021-01-01T12:00:00Z', name: 'Cafe' };
    const a = visitToCandidate({ ...base, lat: 1.1, lng: 2.2 });
    const b = visitToCandidate({ ...base, lat: 3.3, lng: 4.4 });
    // Same title + same instant, different coords — must NOT share a dedupe key.
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
    expect(a.dedupeKey).toContain('1.1,2.2');
  });

  it('leaves durationS null when there is no end time', () => {
    const c = visitToCandidate({ startTime: '2021-01-01T00:00:00Z', name: 'X' });
    expect(c.durationS).toBeNull();
  });

  it('drops visits with no usable start instant', () => {
    expect(visitToCandidate({ name: 'X' })).toBeNull();
    expect(visitToCandidate(null)).toBeNull();
  });
});

describe('takeoutLocationCandidates', () => {
  it('maps a batch and filters unmappable rows', () => {
    const out = takeoutLocationCandidates([...extractVisits(classicFile), { name: 'no-start' }]);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.source === 'location' && c.kind === 'place.visit')).toBe(true);
  });
  it('returns [] for non-arrays', () => {
    expect(takeoutLocationCandidates(null)).toEqual([]);
    expect(takeoutLocationCandidates({})).toEqual([]);
  });
});

describe('summarizeLocationCandidates', () => {
  it('computes range, visit count, unique places, and top places', () => {
    const candidates = takeoutLocationCandidates([
      ...extractVisits(classicFile),
      ...extractVisits(onDeviceFile),
      // a second Blue Bottle visit (same placeId, later day)
      { startTime: '2021-03-05T15:00:00Z', name: 'Blue Bottle Coffee', placeId: 'ChIJ-blue-bottle' },
    ]);
    const s = summarizeLocationCandidates(candidates);
    expect(s.visits).toBe(4);
    expect(s.uniquePlaces).toBe(3); // blue-bottle (x2), home, work
    expect(s.from).toBe('2021-03-01T15:00:00.000Z');
    expect(s.to).toBe('2024-06-15T16:00:00.000Z');
    expect(s.topPlaces[0]).toEqual({ name: 'Blue Bottle Coffee', count: 2 });
  });

  it('handles an empty batch', () => {
    const s = summarizeLocationCandidates([]);
    expect(s).toMatchObject({ visits: 0, uniquePlaces: 0, from: null, to: null });
    expect(s.topPlaces).toEqual([]);
  });

  it('counts unique places by the SAME identity the dedupe key uses (placeId → lat,lng → title)', () => {
    // Two visits: same title, no placeId, DIFFERENT coords — imported distinctly
    // (different dedupe keys), so the preview must also count them as 2 places.
    const candidates = takeoutLocationCandidates([
      { startTime: '2021-01-01T12:00:00Z', name: 'Cafe', lat: 1.1, lng: 2.2 },
      { startTime: '2021-01-02T12:00:00Z', name: 'Cafe', lat: 3.3, lng: 4.4 },
    ]);
    expect(summarizeLocationCandidates(candidates).uniquePlaces).toBe(2);
  });
});

describe('parseTakeoutJsonText', () => {
  it('parses a classic file', () => {
    expect(parseTakeoutJsonText(JSON.stringify(classicFile)).timelineObjects).toHaveLength(3);
  });
  it('throws on malformed JSON', () => {
    expect(() => parseTakeoutJsonText('{not json')).toThrow();
  });
});
