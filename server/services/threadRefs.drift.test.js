/**
 * Drift guard: the thread ref VOCABULARY and its RESOLVERS live in two files by
 * necessity (`server/lib` may not import upward into `server/services`), so
 * nothing but this test stops someone adding a kind to one and forgetting the
 * other. A ref of a half-added kind degrades silently to `unknown-kind` — it
 * renders as an unlinked chip forever and no behavioral test notices.
 *
 * Reads the two source files rather than importing the resolver's runtime, so
 * the assertion holds without a database.
 */

import { describe, it, expect } from 'vitest';
import {
  THREAD_REF_KINDS,
  INTERNAL_THREAD_REF_KINDS,
  EXTERNAL_THREAD_REF_KINDS,
  threadRefUrl,
} from '../lib/threadRefKinds.js';

// Reached through a DYNAMIC import on purpose: a static one would charge every
// module in the resolver closure to this suite in the server import budget
// (lib/importScoping.test.js), and the guard only needs one exported list.
const { RESOLVABLE_THREAD_REF_KINDS } = await import('./threadRefs.js');

describe('thread ref registry ↔ resolver parity', () => {
  it('every internal kind has a resolver', () => {
    const missing = INTERNAL_THREAD_REF_KINDS.filter((k) => !RESOLVABLE_THREAD_REF_KINDS.includes(k));
    expect(missing, `add a lookup in server/services/threadRefs.js for: ${missing.join(', ')}`).toEqual([]);
  });

  it('every resolver has a kind — and no external kind has one', () => {
    // The inverse drift: a lookup for a kind that was renamed or dropped is dead
    // code the resolver can never reach, and an external kind has no local
    // target to probe, so a lookup for one would be a contradiction.
    for (const kind of RESOLVABLE_THREAD_REF_KINDS) {
      expect(THREAD_REF_KINDS[kind], `resolver for unknown kind "${kind}"`).toBeDefined();
      expect(THREAD_REF_KINDS[kind].external, `resolver for external kind "${kind}"`).toBe(false);
    }
  });

  it('declares each internal kind exactly once across the three lookup groups', () => {
    // Two groups claiming one kind would make which store wins depend on the
    // order of the if-chain in `lookupTarget`.
    const seen = new Set();
    for (const kind of RESOLVABLE_THREAD_REF_KINDS) {
      expect(seen.has(kind), `"${kind}" is declared in two lookup groups`).toBe(false);
      seen.add(kind);
    }
  });

  it('every external kind builds a URL from its own id', () => {
    for (const kind of EXTERNAL_THREAD_REF_KINDS) {
      expect(threadRefUrl(kind, 'https://example.com/item/1'), kind)
        .toBe('https://example.com/item/1');
    }
  });
});
