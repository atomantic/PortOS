/**
 * The registry's job is to make a new ingest source DECLARE its extraction
 * lens. These pin that contract — the lens used to be a private two-element
 * Set inside catalogExtraction.js, where adding a source kind gave you a
 * working route that silently read a memoir through the fiction lens (#7609).
 */
import { describe, it, expect } from 'vitest';

import {
  SCRAP_SOURCE_KINDS,
  SCRAP_SOURCE_KIND_IDS,
  isFactualSourceKind,
} from './catalogSourceKinds.js';

describe('catalogSourceKinds', () => {
  it('forces every source kind to declare its lens explicitly', () => {
    // An entry that merely OMITS `factual` would read as fiction by accident
    // rather than by decision — which is the failure this registry exists to
    // stop. A new ingest path must answer the question.
    for (const kind of SCRAP_SOURCE_KINDS) {
      expect(typeof kind.id, `${kind.id} id`).toBe('string');
      expect(typeof kind.label, `${kind.id} label`).toBe('string');
      expect(typeof kind.factual, `${kind.id} must declare factual`).toBe('boolean');
    }
  });

  it('keeps the Zod enum ids in lockstep with the registry', () => {
    // catalogValidation.js gates the local ingest routes on these ids; a
    // registry entry missing from the enum is an ingest route that 400s.
    expect([...SCRAP_SOURCE_KIND_IDS]).toEqual(SCRAP_SOURCE_KINDS.map((k) => k.id));
    expect(new Set(SCRAP_SOURCE_KIND_IDS).size).toBe(SCRAP_SOURCE_KIND_IDS.length);
  });

  it('reads first-person capture as factual and everything else as fiction', () => {
    expect(isFactualSourceKind('voice-memo')).toBe(true);
    expect(isFactualSourceKind('brain-bridge')).toBe(true);
    expect(isFactualSourceKind('paste')).toBe(false);
    expect(isFactualSourceKind('url')).toBe(false);
  });

  it('reads an unknown kind as non-factual', () => {
    // A newer peer can sync a kind this build does not enumerate (the
    // sync-apply path takes a loose string, not this enum). The fiction lens
    // is what every extraction rendered before #7609, so it is the safe answer
    // for a kind we cannot classify — never a guess that invents a real person.
    expect(isFactualSourceKind('kind-from-a-newer-peer')).toBe(false);
    expect(isFactualSourceKind(undefined)).toBe(false);
    expect(isFactualSourceKind('')).toBe(false);
  });

  it('is frozen against mutation by a consumer', () => {
    expect(Object.isFrozen(SCRAP_SOURCE_KINDS)).toBe(true);
    expect(SCRAP_SOURCE_KINDS.every(Object.isFrozen)).toBe(true);
  });
});
