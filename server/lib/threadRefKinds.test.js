import { describe, it, expect } from 'vitest';
import {
  THREAD_REF_KINDS,
  THREAD_REF_KIND_IDS,
  INTERNAL_THREAD_REF_KINDS,
  EXTERNAL_THREAD_REF_KINDS,
  canonicalThreadRefKind,
  isSafeExternalUrl,
  threadRefLabel,
  threadRefUrl,
} from './threadRefKinds.js';
import { NAV_COMMANDS } from './navManifest.js';

// Every page the manifest knows about, query strings stripped (a nav row may be
// declared as a `?settings=1` variant of the same page path).
const NAV_PATHS = new Set(NAV_COMMANDS.map((c) => c.path.split('?')[0]));

describe('threadRefKinds — registry shape', () => {
  it('every kind carries a label and splits cleanly into internal/external', () => {
    for (const [kind, spec] of Object.entries(THREAD_REF_KINDS)) {
      expect(typeof spec.label, `${kind}.label`).toBe('string');
      expect(spec.label.length, `${kind}.label`).toBeGreaterThan(0);
      expect(typeof spec.external, `${kind}.external`).toBe('boolean');
    }
    expect([...INTERNAL_THREAD_REF_KINDS, ...EXTERNAL_THREAD_REF_KINDS].sort())
      .toEqual([...THREAD_REF_KIND_IDS].sort());
  });

  // The acceptance guard from #7664: a link this table produces has to land on a
  // page the app actually routes. Without it a renamed page leaves ref chips
  // pointing at a 404 and nothing fails.
  it('every internal kind lands on a real NAV_COMMANDS page', () => {
    for (const kind of INTERNAL_THREAD_REF_KINDS) {
      const spec = THREAD_REF_KINDS[kind];
      expect(NAV_PATHS.has(spec.navPath), `${kind} → ${spec.navPath}`).toBe(true);
      // A per-record deep link may go DEEPER than the nav row, but it must stay
      // on that page — `/pipeline/series/:id` under `/pipeline`, never elsewhere.
      const url = threadRefUrl(kind, 'target-id', { catalogType: 'character' });
      expect(url?.startsWith(spec.navPath), `${kind} → ${url}`).toBe(true);
    }
  });

  it('external kinds declare no route — their id IS the URL', () => {
    for (const kind of EXTERNAL_THREAD_REF_KINDS) {
      expect(THREAD_REF_KINDS[kind].navPath, kind).toBeUndefined();
    }
  });
});

describe('threadRefUrl', () => {
  it('builds the four internal link shapes', () => {
    // page-only (no per-record route exists yet)
    expect(threadRefUrl('writers-room', 'w1')).toBe('/writers-room');
    // path segment
    expect(threadRefUrl('universe', 'u1')).toBe('/universes/u1');
    // segment + suffix (an issue opens on its first stage)
    expect(threadRefUrl('issue', 'i1')).toBe('/pipeline/issues/i1/concept');
    // query param (the Daily Log is date-addressed and a journal id IS its date)
    expect(threadRefUrl('brain.journal', '2026-09-19')).toBe('/brain/daily-log?date=2026-09-19');
  });

  it('encodes an id that would otherwise escape its segment or param', () => {
    expect(threadRefUrl('universe', 'a/b?c')).toBe('/universes/a%2Fb%3Fc');
    expect(threadRefUrl('brain.journal', 'a&b=c')).toBe('/brain/daily-log?date=a%26b%3Dc');
  });

  it('uses the resolved catalog type as the ingredient route segment', () => {
    expect(threadRefUrl('catalog.ingredient', 'ing-1', { catalogType: 'character' }))
      .toBe('/catalog/character/ing-1');
  });

  it('degrades an ingredient with no resolved type to the catalog page', () => {
    // The alternative is `/catalog/undefined/ing-1`, which 404s. An unhydrated
    // ref still deserves a link that works.
    expect(threadRefUrl('catalog.ingredient', 'ing-1')).toBe('/catalog');
  });

  it('returns null rather than throwing for a kind this build does not know', () => {
    // A peer on newer code can sync a thread naming a kind added after this
    // build shipped; the chip renders unlinked instead of crashing the page.
    expect(threadRefUrl('some.future.kind', 'x')).toBeNull();
    expect(threadRefUrl('universe', '')).toBeNull();
    expect(threadRefUrl('universe', undefined)).toBeNull();
  });

  it('passes an external id through only when it is a link-safe URL', () => {
    expect(threadRefUrl('github.issue', 'https://github.com/o/r/issues/1'))
      .toBe('https://github.com/o/r/issues/1');
    // The injection this guard exists for: a stored ref is user- or peer-supplied
    // text, and these must never become an href.
    expect(threadRefUrl('url', 'javascript:alert(1)')).toBeNull();
    expect(threadRefUrl('url', 'data:text/html,<script>')).toBeNull();
    expect(threadRefUrl('url', '/relative/path')).toBeNull();
    expect(threadRefUrl('url', 'not a url')).toBeNull();
  });
});

describe('isSafeExternalUrl', () => {
  it('accepts http(s) absolute URLs and nothing else', () => {
    expect(isSafeExternalUrl('http://example.com')).toBe(true);
    expect(isSafeExternalUrl('https://example.com/a?b=c#d')).toBe(true);
    expect(isSafeExternalUrl('ftp://example.com')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
    expect(isSafeExternalUrl(null)).toBe(false);
  });
});

describe('threadRefLabel / canonicalThreadRefKind', () => {
  it('resolves the legacy writersRoom spelling to the canonical kind', () => {
    // Catalog ref rows written before the vocabulary settled still carry this.
    expect(canonicalThreadRefKind('writersRoom')).toBe('writers-room');
    expect(threadRefLabel('writersRoom')).toBe("Writers' Room");
    expect(threadRefUrl('writersRoom', 'w1')).toBe('/writers-room');
  });

  it('falls back to the raw kind rather than rendering empty', () => {
    expect(threadRefLabel('some.future.kind')).toBe('some.future.kind');
    expect(threadRefLabel(undefined)).toBe('');
  });
});
