import { describe, it, expect } from 'vitest';
import { isManifestEnvelope, diffManifestSlots } from './syncManifest.js';

describe('isManifestEnvelope', () => {
  it('accepts a well-formed manifest response', () => {
    expect(isManifestEnvelope({ checksum: 'abc', data: { instances: {} } })).toBe(true);
  });

  // `fetchPeer` returns null for a 404 — which is exactly what a source peer
  // running the pre-manifest code does with this endpoint. Every non-envelope
  // must read as "no manifest" so the puller falls back to the whole snapshot
  // instead of silently syncing nothing.
  it.each([
    ['a legacy peer 404 (null)', null],
    ['a checksum-only response', { checksum: 'abc' }],
    ['a snapshot response (data, no instances map)', { checksum: 'abc', data: { sessions: [] } }],
    ['an instances array rather than a map', { checksum: 'abc', data: { instances: [] } }],
    ['a manifest with no checksum', { data: { instances: {} } }],
  ])('rejects %s', (_label, value) => {
    expect(isManifestEnvelope(value)).toBe(false);
  });
});

describe('diffManifestSlots', () => {
  const local = {
    'inst-a': '2026-09-01T10:00:00.000Z',
    'inst-b': '2026-09-01T10:00:00.000Z',
  };

  it('returns only the slots whose remote stamp advanced', () => {
    expect(diffManifestSlots({
      'inst-a': '2026-09-01T11:00:00.000Z',
      'inst-b': '2026-09-01T10:00:00.000Z',
    }, local)).toEqual(['inst-a']);
  });

  it('returns nothing when every slot matches', () => {
    expect(diffManifestSlots({ ...local }, local)).toEqual([]);
  });

  it('takes a slot we have never seen', () => {
    expect(diffManifestSlots({ 'inst-c': '2026-09-01T09:00:00.000Z' }, local)).toEqual(['inst-c']);
  });

  it('leaves a slot where our copy is newer', () => {
    expect(diffManifestSlots({ 'inst-a': '2026-08-30T00:00:00.000Z' }, local)).toEqual([]);
  });

  it('ignores an unparseable remote stamp rather than fetching on it forever', () => {
    expect(diffManifestSlots({ 'inst-a': 'not-a-date', 'inst-z': null }, local)).toEqual([]);
  });

  it('sorts the result so the request URL is deterministic', () => {
    expect(diffManifestSlots({ 'inst-z': '2026-10-01T00:00:00.000Z', 'inst-c': '2026-10-01T00:00:00.000Z' }, local))
      .toEqual(['inst-c', 'inst-z']);
  });

  it('treats a missing local manifest as "we hold nothing"', () => {
    expect(diffManifestSlots({ 'inst-a': '2026-09-01T10:00:00.000Z' }, undefined)).toEqual(['inst-a']);
  });

  it('returns nothing for a non-map remote', () => {
    expect(diffManifestSlots(null, local)).toEqual([]);
  });
});
