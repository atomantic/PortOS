/**
 * Cross-package parity for the catalog type registry.
 *
 * `server/lib/catalogTypes.js` is the source of truth; `client/src/lib/
 * catalogTypes.js` is a hand-maintained mirror (the client can't import the
 * server module — it pulls in server-only deps via storyBible.js). This suite
 * imports BOTH and asserts the fields the UI relies on stay identical, so a
 * server-side registry change that isn't mirrored to the client fails CI here
 * instead of silently drifting (badge colors, primary-content keys, snippet
 * fallbacks, relation/media kind ids, tag canonicalization).
 *
 * It lives server-side because the server registry can't load under the client
 * (jsdom) runner, but the pure client mirror loads fine here.
 */

import { describe, it, expect } from 'vitest';
import {
  CATALOG_TYPES as SERVER_TYPES,
  RELATION_KINDS as SERVER_REL,
  MEDIA_KINDS as SERVER_MEDIA,
  canonicalTagKey as serverCanonicalTagKey,
} from './catalogTypes.js';
import {
  CATALOG_TYPES as CLIENT_TYPES,
  RELATION_KINDS as CLIENT_REL,
  MEDIA_KINDS as CLIENT_MEDIA,
  canonicalTagKey as clientCanonicalTagKey,
} from '../../client/src/lib/catalogTypes.js';

// The fields the client mirror MUST match the server on — the ones the UI
// reads. `ftsFields` / `extractionShape` / `payloadSchemaVersion` are
// server-only concerns and intentionally not mirrored.
const MIRRORED_FIELDS = ['id', 'label', 'badgeColor', 'primaryContentKey', 'primaryContentLabel', 'snippetFallbackKeys', 'editableListFields'];

describe('catalog type registry — server↔client parity', () => {
  it('exposes the same type ids in the same order', () => {
    expect(CLIENT_TYPES.map((t) => t.id)).toEqual(SERVER_TYPES.map((t) => t.id));
  });

  it('matches every mirrored field for each type', () => {
    for (const s of SERVER_TYPES) {
      const c = CLIENT_TYPES.find((t) => t.id === s.id);
      expect(c, `client mirror missing type ${s.id}`).toBeTruthy();
      for (const f of MIRRORED_FIELDS) {
        expect(c[f], `${s.id}.${f} drifted between server and client`).toEqual(s[f]);
      }
    }
  });

  it('matches relation + media kind ids', () => {
    expect(CLIENT_REL.map((r) => r.id)).toEqual(SERVER_REL.map((r) => r.id));
    expect(CLIENT_MEDIA.map((m) => m.id)).toEqual(SERVER_MEDIA.map((m) => m.id));
  });

  it('canonicalTagKey behaves identically across server and client', () => {
    for (const s of ['Film Noir', 'noir', '  Spaced  Out ', 'UPPER', 'já-vu', '']) {
      expect(clientCanonicalTagKey(s)).toBe(serverCanonicalTagKey(s));
    }
  });
});
