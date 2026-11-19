import { describe, expect, it } from 'vitest';

import { applyCanonEntryExpansion, } from './universeCanonEntryExpand.js';

const place = (overrides = {}) => ({ id: 'p1', name: 'The Foundry', ...overrides });
const object = (overrides = {}) => ({ id: 'o1', name: 'The Ledger', ...overrides });

describe('applyCanonEntryExpansion', () => {
  it('fills blank fields and reports exactly what it filled', () => {
    const { merged, updatedFields } = applyCanonEntryExpansion('place', place(), {
      description: 'A rolling mill, still hot at midnight.',
      era: 'late-industrial, retrofitted',
    });
    expect(updatedFields).toEqual(['description', 'era']);
    expect(merged.description).toBe('A rolling mill, still hot at midnight.');
  });

  it('never clobbers a populated field', () => {
    const target = place({ description: 'what the writer wrote' });
    const { merged, updatedFields } = applyCanonEntryExpansion('place', target, {
      description: 'what the model would rather have written',
      palette: 'sodium orange on wet slate',
    });
    expect(merged.description).toBe('what the writer wrote');
    expect(updatedFields).toEqual(['palette']);
  });

  it('ignores an empty proposal rather than treating it as a clear', () => {
    // An expand flow has no "clear" intent — an empty value just means the model
    // had nothing to add. (Distinct from the direct-PATCH merge convention,
    // where empty CAN mean clear.)
    const { merged, updatedFields } = applyCanonEntryExpansion('place', place({ era: 'pre-collapse' }), {
      description: '   ',
      era: '',
    });
    expect(updatedFields).toEqual([]);
    expect(merged.era).toBe('pre-collapse');
  });

  it('drops an out-of-vocabulary enum instead of reporting a field the sanitizer will discard', () => {
    // `intExt` only accepts INT/EXT. Accepting the raw proposal would report
    // the field as filled while the next persist silently drops it.
    const { merged, updatedFields } = applyCanonEntryExpansion('place', place(), {
      intExt: 'INTERIOR',
      timeOfDay: 'dusk',
    });
    expect(updatedFields).toEqual(['timeOfDay']);
    expect(merged.intExt).toBeUndefined();
  });

  it('normalizes an enum the model cased differently', () => {
    const { merged, updatedFields } = applyCanonEntryExpansion('place', place(), { intExt: 'int' });
    expect(updatedFields).toEqual(['intExt']);
    expect(merged.intExt).toBe('INT');
  });

  it('fills a place that carries only a slugline', () => {
    // `sanitizePlace` accepts name OR slugline; passing neither through would
    // make every proposal on a slugline-only place unsanitizable and dropped.
    const target = { id: 'p2', slugline: 'EXT. FOUNDRY — DAY' };
    const { updatedFields } = applyCanonEntryExpansion('place', target, { description: 'a yard of cooling slag' });
    expect(updatedFields).toEqual(['description']);
  });

  it('expands objects with their own field set', () => {
    const { merged, updatedFields } = applyCanonEntryExpansion('object', object(), {
      description: 'A hand-bound quarto, spine cracked.',
      significance: 'Everyone in the syndicate wants it burned.',
      // Not an object field — must not leak in from the place half of the prompt.
      weather: 'rain',
    });
    expect(updatedFields).toEqual(['description', 'significance']);
    expect(merged.weather).toBeUndefined();
  });

  it('returns the target untouched for an unknown kind or a malformed payload', () => {
    const target = place();
    expect(applyCanonEntryExpansion('character', target, { description: 'x' })).toEqual({ merged: target, updatedFields: [] });
    expect(applyCanonEntryExpansion('place', target, null)).toEqual({ merged: target, updatedFields: [] });
    expect(applyCanonEntryExpansion('place', null, { description: 'x' })).toEqual({ merged: null, updatedFields: [] });
  });

});
