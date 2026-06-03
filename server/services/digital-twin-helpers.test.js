import { describe, it, expect } from 'vitest';
import { resolveTestPersona, parseBulletList } from './digital-twin-helpers.js';

// resolveTestPersona maps a persona id (as passed to a test runner) into the
// `{ personaId, personaName }` fields stamped on a run-history entry, so a run
// can be attributed to the persona it embodied. No id (or an unknown id) yields
// `{}` — the base-twin run, which leaves the history entry persona-free.
describe('resolveTestPersona', () => {
  const personas = [
    { id: 'p1', name: 'Professional', instructions: '...' },
    { id: 'p2', name: 'Casual', instructions: '...' }
  ];

  it('returns the id + name for a matching persona', () => {
    expect(resolveTestPersona(personas, 'p2')).toEqual({ personaId: 'p2', personaName: 'Casual' });
  });

  it('returns {} for a base-twin run (no persona id)', () => {
    expect(resolveTestPersona(personas, null)).toEqual({});
    expect(resolveTestPersona(personas, undefined)).toEqual({});
    expect(resolveTestPersona(personas, '')).toEqual({});
  });

  it('returns {} when the id does not match a stored persona', () => {
    expect(resolveTestPersona(personas, 'ghost')).toEqual({});
  });

  it('tolerates a missing/non-array personas list', () => {
    expect(resolveTestPersona(undefined, 'p1')).toEqual({});
    expect(resolveTestPersona(null, 'p1')).toEqual({});
  });
});

// parseBulletList turns a markdown bullet block (the "Values at Stake" /
// "Boundary Tested" sections of a suite) into a trimmed string array. Shared by
// the values-alignment and adversarial-boundary suite parsers.
describe('parseBulletList', () => {
  it('parses dash and asterisk bullets, trimming each item', () => {
    expect(parseBulletList('- integrity\n* craftsmanship\n-  reliability ')).toEqual([
      'integrity', 'craftsmanship', 'reliability'
    ]);
  });

  it('drops blank lines', () => {
    expect(parseBulletList('- a\n\n- b\n')).toEqual(['a', 'b']);
  });

  it('returns an empty array for empty or non-string input', () => {
    expect(parseBulletList('')).toEqual([]);
    expect(parseBulletList(null)).toEqual([]);
    expect(parseBulletList(undefined)).toEqual([]);
  });
});
