import { describe, it, expect } from 'vitest';
import {
  isLegacyUniverseTag,
  universeIdFromLegacyTag,
  friendlifyUniverseTags,
} from './catalogUniverseTags.js';

// Match the canonical tag key used by catalogTypes.canonicalTagKey so the
// dedup behavior under test mirrors production.
const canonicalKey = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').toLowerCase() : '');

describe('catalogUniverseTags — legacy tag detection', () => {
  it('recognizes the marker tag case-insensitively', () => {
    expect(isLegacyUniverseTag('from-universe')).toBe(true);
    expect(isLegacyUniverseTag('From-Universe')).toBe(true);
    expect(isLegacyUniverseTag(' from-universe ')).toBe(true);
  });

  it('recognizes id tags by prefix', () => {
    expect(isLegacyUniverseTag('universe:14590a09-5a49-4994-b401-395ee354528d')).toBe(true);
    expect(isLegacyUniverseTag('Universe:abc')).toBe(true);
  });

  it('leaves user tags alone', () => {
    expect(isLegacyUniverseTag('mentor')).toBe(false);
    expect(isLegacyUniverseTag('season-1')).toBe(false);
    expect(isLegacyUniverseTag('multiverse')).toBe(false); // not the prefix `universe:`
    expect(isLegacyUniverseTag(42)).toBe(false);
  });

  it('extracts the universe id from an id tag', () => {
    expect(universeIdFromLegacyTag('universe:u-123')).toBe('u-123');
    expect(universeIdFromLegacyTag('Universe: u-123 ')).toBe('u-123');
    expect(universeIdFromLegacyTag('universe:')).toBeNull();
    expect(universeIdFromLegacyTag('from-universe')).toBeNull();
    expect(universeIdFromLegacyTag('mentor')).toBeNull();
  });
});

describe('catalogUniverseTags — friendlifyUniverseTags', () => {
  const nameFor = (id) => ({ 'u-1': 'My Cool Universe', 'u-2': 'Neon City' }[id] || null);

  it('replaces machine tags with the friendly universe name, preserving user tags', () => {
    const { tags, changed } = friendlifyUniverseTags(
      ['mentor', 'from-universe', 'universe:u-1', 'season-1'],
      nameFor,
      canonicalKey,
    );
    expect(changed).toBe(true);
    expect(tags).toEqual(['mentor', 'season-1', 'My Cool Universe']);
    // No machine tags survive.
    expect(tags.some((t) => isLegacyUniverseTag(t))).toBe(false);
  });

  it('is a no-op when there are no legacy tags', () => {
    const { tags, changed } = friendlifyUniverseTags(['hero', 'noir'], nameFor, canonicalKey);
    expect(changed).toBe(false);
    expect(tags).toEqual(['hero', 'noir']);
  });

  it('leaves a `universe:`-prefixed USER tag untouched when the from-universe marker is absent', () => {
    // The backfill always stamps `from-universe` alongside `universe:<id>`, so
    // without the marker this is a legit user tag — must not be rewritten,
    // dropped, or treated as an unresolved legacy tag.
    const r1 = friendlifyUniverseTags(['universe:marvel', 'hero'], nameFor, canonicalKey);
    expect(r1).toEqual({ tags: ['universe:marvel', 'hero'], changed: false, unresolved: false });
    // Even if the suffix happens to match a real universe id, no marker → no-op.
    const r2 = friendlifyUniverseTags(['universe:u-1'], nameFor, canonicalKey);
    expect(r2).toEqual({ tags: ['universe:u-1'], changed: false, unresolved: false });
  });

  it('PRESERVES an unresolved universe id tag (+ marker) for a later retry and reports NOT changed', () => {
    // The universe name can't resolve yet (it arrived after this ingredient, or
    // the local lookup misses). Dropping the id tag would lose it forever, so we
    // keep it untouched and report changed=false so the row retries next run.
    const { tags, changed } = friendlifyUniverseTags(
      ['hero', 'universe:u-deleted', 'from-universe'],
      nameFor,
      canonicalKey,
    );
    expect(changed).toBe(false);
    expect(tags).toEqual(['hero', 'universe:u-deleted', 'from-universe']);
  });

  it('friendlifies the resolved id but KEEPS an unresolved sibling id (partial resolve)', () => {
    // u-1 resolves, u-deleted doesn't: add the resolved name, drop u-1, keep
    // u-deleted (+ the marker) so the still-unresolved one retries later.
    const { tags, changed } = friendlifyUniverseTags(
      ['hero', 'universe:u-1', 'universe:u-deleted', 'from-universe'],
      nameFor,
      canonicalKey,
    );
    expect(changed).toBe(true);
    expect(tags).toEqual(['hero', 'My Cool Universe', 'universe:u-deleted', 'from-universe']);
  });

  it('dedupes the friendly name against an existing user tag (case-insensitive)', () => {
    const { tags, changed } = friendlifyUniverseTags(
      ['my cool universe', 'universe:u-1', 'from-universe'],
      nameFor,
      canonicalKey,
    );
    // changed because machine tags were stripped, even though no new name added.
    expect(changed).toBe(true);
    expect(tags).toEqual(['my cool universe']);
  });

  it('handles multiple distinct universe ids', () => {
    const { tags } = friendlifyUniverseTags(
      ['universe:u-1', 'universe:u-2', 'from-universe'],
      nameFor,
      canonicalKey,
    );
    expect(tags).toEqual(['My Cool Universe', 'Neon City']);
  });

  it('is idempotent — a second pass over the friendlified set is a no-op', () => {
    const first = friendlifyUniverseTags(['mentor', 'universe:u-1', 'from-universe'], nameFor, canonicalKey);
    const second = friendlifyUniverseTags(first.tags, nameFor, canonicalKey);
    expect(second.changed).toBe(false);
    expect(second.tags).toEqual(first.tags);
  });

  it('tolerates non-array input', () => {
    expect(friendlifyUniverseTags(null, nameFor, canonicalKey)).toEqual({ tags: [], changed: false, unresolved: false });
    expect(friendlifyUniverseTags(undefined, nameFor, canonicalKey)).toEqual({ tags: [], changed: false, unresolved: false });
  });
});
