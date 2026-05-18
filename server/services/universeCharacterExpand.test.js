import { describe, it, expect } from 'vitest';
import { applyExpansion } from './universeCharacterExpand.js';

describe('universeCharacterExpand — applyExpansion (no-clobber merge semantics)', () => {
  it('fills blank string fields from the LLM response', () => {
    const target = { name: 'Vale', pronouns: '', age: '', motivations: '' };
    const content = { pronouns: 'she/her', age: '27', motivations: 'survive' };
    const { merged, updatedFields } = applyExpansion(target, content);
    expect(merged.pronouns).toBe('she/her');
    expect(merged.age).toBe('27');
    expect(merged.motivations).toBe('survive');
    expect(updatedFields).toEqual(expect.arrayContaining(['pronouns', 'age', 'motivations']));
    expect(updatedFields).toHaveLength(3);
  });

  it('does NOT clobber a populated string field', () => {
    const target = { name: 'Vale', pronouns: 'they/them', age: '' };
    const content = { pronouns: 'she/her', age: '27' };
    const { merged, updatedFields } = applyExpansion(target, content);
    // pronouns was populated, LLM proposal ignored
    expect(merged.pronouns).toBe('they/them');
    expect(merged.age).toBe('27');
    expect(updatedFields).toEqual(['age']);
  });

  it('treats absent keys as "no opinion" (preserves existing)', () => {
    const target = { name: 'Vale', pronouns: 'they/them', age: '27', motivations: 'survive' };
    const content = {}; // LLM had nothing to add
    const { merged, updatedFields } = applyExpansion(target, content);
    expect(merged.pronouns).toBe('they/them');
    expect(merged.age).toBe('27');
    expect(merged.motivations).toBe('survive');
    expect(updatedFields).toEqual([]);
  });

  it('fills blank list fields with non-empty arrays', () => {
    const target = { name: 'Vale', stats: [], colorPalette: [], expressions: [] };
    const content = {
      stats: [{ label: 'Height', value: "5'7\"" }],
      colorPalette: [{ name: 'amber', hex: '#f59e0b', role: 'skin' }],
      expressions: [{ name: 'neutral', description: 'baseline' }],
    };
    const { merged, updatedFields } = applyExpansion(target, content);
    expect(merged.stats).toHaveLength(1);
    expect(merged.colorPalette).toHaveLength(1);
    expect(merged.expressions).toHaveLength(1);
    expect(updatedFields).toEqual(expect.arrayContaining(['stats', 'colorPalette', 'expressions']));
  });

  it('does NOT clobber a populated list field', () => {
    const target = { name: 'Vale', stats: [{ label: 'Eyes', value: 'amber' }] };
    const content = { stats: [{ label: 'Height', value: "5'7\"" }] };
    const { merged } = applyExpansion(target, content);
    // existing populated list preserved
    expect(merged.stats).toEqual([{ label: 'Eyes', value: 'amber' }]);
  });

  it('ignores non-string proposals for string fields and non-array proposals for list fields', () => {
    const target = { name: 'Vale', pronouns: '', stats: [] };
    const content = { pronouns: 42, stats: { not: 'an array' } };
    const { merged, updatedFields } = applyExpansion(target, content);
    expect(merged.pronouns).toBe('');
    expect(merged.stats).toEqual([]);
    expect(updatedFields).toEqual([]);
  });

  it('ignores LLM-proposed empty strings / empty arrays as "intentional clear, no-op since field already blank"', () => {
    const target = { name: 'Vale', pronouns: '', stats: [] };
    const content = { pronouns: '   ', stats: [] };
    const { merged, updatedFields } = applyExpansion(target, content);
    expect(merged.pronouns).toBe('');
    expect(merged.stats).toEqual([]);
    expect(updatedFields).toEqual([]);
  });

  it('trims string proposals before assignment', () => {
    const target = { name: 'Vale', pronouns: '' };
    const content = { pronouns: '  she/her  ' };
    const { merged } = applyExpansion(target, content);
    expect(merged.pronouns).toBe('she/her');
  });

  it('returns the target untouched when content is null / not an object', () => {
    const target = { name: 'Vale', pronouns: 'they/them' };
    expect(applyExpansion(target, null).merged).toBe(target);
    expect(applyExpansion(target, 'not an object').merged).toBe(target);
    expect(applyExpansion(null, {}).merged).toBeNull();
  });

  it('respects the full extended-field set (smoke check the field list stays in sync)', () => {
    const target = {
      name: 'Vale', pronouns: '', age: '', coreTheme: '', speechAccent: '', visualNotes: '',
      silhouetteNotes: '', postureNotes: '', specialTraits: '', visualIdentity: '',
      motivations: '', likes: '', dislikes: '', mannerisms: '', relationships: '', skills: '',
      stats: [], colorPalette: [], props: [], expressions: [], handGestures: [],
    };
    const content = {
      pronouns: 'she/her', age: '27', coreTheme: 't', speechAccent: 'a', visualNotes: 'v',
      silhouetteNotes: 's', postureNotes: 'p', specialTraits: 'st', visualIdentity: 'vi',
      motivations: 'm', likes: 'l', dislikes: 'd', mannerisms: 'mn', relationships: 'r', skills: 'sk',
      stats: [{ label: 'L', value: 'V' }],
      colorPalette: [{ name: 'n' }],
      props: [{ name: 'n' }],
      expressions: [{ name: 'n' }],
      handGestures: [{ name: 'n' }],
    };
    const { updatedFields } = applyExpansion(target, content);
    // 15 strings + 5 lists = 20 fields total in the expand contract.
    expect(updatedFields).toHaveLength(20);
  });
});
