import { describe, it, expect } from 'vitest';
import { parseCatalogDraft, dedupDrafts, emptyCatalogDraft } from './catalogExtractionDraft.js';

const parsed = (draft, corpus) => parseCatalogDraft(JSON.stringify({ ...emptyCatalogDraft(), ...draft }), { corpus });

describe('catalog chunk graph identity', () => {
  it('keeps same-name entities and ambiguous aliases distinct, without inventing cross-chunk links', () => {
    const first = parsed({ objects: [
      { draftId: 'p1', name: 'Pistol', aliases: ['The weapon'], evidence: ['first pistol'] },
      { draftId: 'p2', name: 'Pistol', aliases: ['The weapon'], evidence: ['second pistol'] },
    ] }, 'first pistol and second pistol. The weapon.');
    const second = parsed({ objects: [
      { draftId: 'p1', name: 'The weapon', evidence: ['The weapon'] },
    ] }, 'The weapon');
    const out = dedupDrafts([first, second]);
    expect(out.objects).toHaveLength(3);
    expect(new Set(out.objects.map(entry => entry.draftId)).size).toBe(3);
    expect(out.relationships).toEqual([]);
    const nameOnly = dedupDrafts([first, first]);
    expect(nameOnly.objects).toHaveLength(4);
  });

  it('unions supported facts/evidence and remaps repeated local IDs and duplicate edges', () => {
    const first = parsed({
      characters: [{ draftId: 'person', name: 'Example Captain', aliases: ['Rook'], evidence: ['Example Captain owns the inherited pistol'] }],
      objects: [{ draftId: 'item', name: 'Pistol', sourceIdentity: 'inherited pistol', description: 'Inherited from an aunt.', evidence: ['inherited pistol'] }],
      relationships: [{ fromDraftId: 'item', toDraftId: 'person', kind: 'owned-by', evidence: 'Example Captain owns the inherited pistol' }],
    }, 'Example Captain owns the inherited pistol. Example Captain is called Rook.');
    const second = parsed({
      characters: [{ draftId: 'person', name: 'Rook', background: 'Returns to the station.', evidence: ['Rook still owns the inherited pistol'] }],
      objects: [{ draftId: 'item', name: 'Pistol', sourceIdentity: 'inherited pistol', description: 'Used to signal the train.', evidence: ['inherited pistol signals the train'] }],
      relationships: [
        { fromDraftId: 'item', toDraftId: 'person', kind: 'owned-by', evidence: 'Rook still owns the inherited pistol' },
        { fromDraftId: 'item', toDraftId: 'person', kind: 'owned-by', evidence: 'Rook still owns the inherited pistol' },
      ],
    }, 'Rook still owns the inherited pistol. The inherited pistol signals the train.');
    const out = dedupDrafts([first, second]);
    expect(out.characters).toHaveLength(1);
    expect(out.characters[0].background).toBe('Returns to the station.');
    expect(out.objects).toHaveLength(1);
    expect(out.objects[0].description).toContain('Inherited from an aunt.');
    expect(out.objects[0].description).toContain('Used to signal the train.');
    expect(out.objects[0].evidence).toHaveLength(2);
    expect(out.relationships).toEqual([{
      fromDraftId: out.objects[0].draftId, toDraftId: out.characters[0].draftId, kind: 'owned-by',
      evidence: 'Example Captain owns the inherited pistol\nRook still owns the inherited pistol',
    }]);
  });

  it('keeps complete candidates when a merge would lose facts at a field cap', () => {
    const make = letter => parsed({ objects: [{ draftId: 'x', name: 'Pistol', sourceIdentity: 'inherited pistol',
      significance: letter.repeat(800), evidence: ['inherited pistol'] }] }, 'inherited pistol');
    const out = dedupDrafts([make('a'), make('b')]);
    expect(out.objects).toHaveLength(2);
    expect(out.objects.map(entry => entry.significance)).toEqual(['a'.repeat(800), 'b'.repeat(800)]);
  });

  it.each([
    { fromDraftId: 'item', toDraftId: 'item', kind: 'related-to' },
    { fromDraftId: 'person', toDraftId: 'item', kind: 'owned-by' },
  ])('rejects invalid edge semantics before returning candidates: %s', edge => {
    expect(() => parsed({
      characters: [{ draftId: 'person', name: 'Owner', evidence: ['source'] }],
      objects: [{ draftId: 'item', name: 'Pistol', evidence: ['source'] }],
      relationships: [{ ...edge, evidence: 'source' }],
    }, 'source')).toThrow();
  });
});
