import { describe, it, expect } from 'vitest';
import {
  slugify,
  parsePlanItems,
  assignMissingIds,
  extractAllIds,
  pickFirstAvailable
} from './planIds.js';

describe('planIds.js', () => {
  describe('slugify', () => {
    it('strips markdown wrappers and produces kebab-case', () => {
      expect(slugify('**Universe Builder redesign — trunks + sub-buckets layout.**'))
        .toBe('universe-builder-redesign-trunks-sub-buckets');
    });

    it('strips inline code and link wrappers', () => {
      expect(slugify('Extract `resolveProviderAndModel({providerId, model})` into `server/lib/promptRunner.js`.'))
        .toBe('extract-resolveproviderandmodel-providerid-model');
    });

    it('strips markdown links to their text', () => {
      expect(slugify('Read [the writer-room doc](./docs/writers-room.md)'))
        .toBe('read-the-writer-room-doc');
    });

    it('truncates at the last dash on or before the 50-char cap', () => {
      const id = slugify('Phase D follow-ups deferred from the Phase D pull request review pass');
      expect(id.length).toBeLessThanOrEqual(50);
      expect(id.endsWith('-')).toBe(false);
      expect(id.startsWith('phase-d-follow-ups')).toBe(true);
    });

    it('returns "item" for an empty / whitespace title', () => {
      expect(slugify('   ')).toBe('item');
      expect(slugify('')).toBe('item');
    });

    it('appends -2, -3 for collisions', () => {
      const taken = new Set(['foo-bar']);
      expect(slugify('Foo Bar', taken)).toBe('foo-bar-2');
      taken.add('foo-bar-2');
      expect(slugify('Foo Bar', taken)).toBe('foo-bar-3');
    });

    it('keeps the collision suffix inside the 50-char cap by trimming the base', () => {
      const taken = new Set(['x'.repeat(50)]);
      const id = slugify('x'.repeat(80), taken);
      expect(id.length).toBeLessThanOrEqual(50);
      expect(id.endsWith('-2')).toBe(true);
    });
  });

  describe('parsePlanItems', () => {
    it('captures checkbox lines, checked state, and existing IDs', () => {
      const md = [
        '## Next Up',
        '- [ ] [foo-bar] **Foo.** Description.',
        '- [x] **Already done.**',
        '  - [ ] Nested sub-item',
        'Some prose that is not a checkbox',
        '- [ ] Plain item <!-- NEEDS_INPUT -->'
      ].join('\n');

      const items = parsePlanItems(md);
      expect(items).toHaveLength(4);
      expect(items[0]).toMatchObject({ id: 'foo-bar', checked: false, indent: '', lineNumber: 2 });
      expect(items[1]).toMatchObject({ id: null, checked: true, lineNumber: 3 });
      expect(items[2]).toMatchObject({ id: null, checked: false, indent: '  ', lineNumber: 4 });
      expect(items[3].needsInput).toBe(true);
    });

    it('returns empty for empty / non-string input', () => {
      expect(parsePlanItems('')).toEqual([]);
      expect(parsePlanItems(null)).toEqual([]);
    });
  });

  describe('extractAllIds', () => {
    it('collects IDs from checkbox lines AND inline brackets, ignoring markdown links', () => {
      const md = [
        '- [ ] [foo] **Foo.**',
        '- [x] [bar-baz] **Bar Baz.**',
        'See [doc](./x.md) for the [legacy-thing] reference and [another](./y.md).'
      ].join('\n');
      const ids = extractAllIds(md);
      expect(ids).toEqual(expect.arrayContaining(['foo', 'bar-baz', 'legacy-thing']));
      expect(ids).not.toContain('doc');
      expect(ids).not.toContain('another');
    });
  });

  describe('assignMissingIds', () => {
    it('assigns IDs only to checkbox lines without one; existing IDs are preserved', () => {
      const md = [
        '- [ ] **Add tests.**',
        '- [ ] [keep-me] **Already IDed.**',
        '- [x] **Old work without an ID.**'
      ].join('\n');
      const { content, assigned } = assignMissingIds(md);
      expect(assigned).toHaveLength(2);
      expect(content).toContain('- [ ] [add-tests] **Add tests.**');
      expect(content).toContain('- [ ] [keep-me] **Already IDed.**');
      expect(content).toContain('- [x] [old-work-without-an-id] **Old work without an ID.**');
    });

    it('is idempotent — running twice produces no further changes', () => {
      const md = '- [ ] **Some item.**\n- [ ] **Another item.**';
      const once = assignMissingIds(md);
      const twice = assignMissingIds(once.content);
      expect(twice.content).toBe(once.content);
      expect(twice.assigned).toHaveLength(0);
    });

    it('respects extraIds (e.g. retired/in-flight slugs) so they are not reused', () => {
      const planMd = '- [ ] **Foo.**';
      const { content } = assignMissingIds(planMd, ['foo']);
      expect(content).toContain('[foo-2]');
      expect(content).not.toContain('[foo] **Foo.**');
    });

    it('handles two items that would collide within the same document', () => {
      const md = '- [ ] **Foo bar.**\n- [ ] **Foo bar.**';
      const { content, assigned } = assignMissingIds(md);
      expect(assigned.map(a => a.id)).toEqual(['foo-bar', 'foo-bar-2']);
      expect(content).toContain('- [ ] [foo-bar] **Foo bar.**');
      expect(content).toContain('- [ ] [foo-bar-2] **Foo bar.**');
    });
  });

  describe('pickFirstAvailable', () => {
    const items = [
      { id: 'a', checked: true, needsInput: false },
      { id: 'b', checked: false, needsInput: true },
      { id: 'c', checked: false, needsInput: false },
      { id: 'd', checked: false, needsInput: false },
      { id: null, checked: false, needsInput: false }
    ];

    it('skips checked, NEEDS_INPUT, and in-flight items', () => {
      const pick = pickFirstAvailable(items, new Set(['c']));
      expect(pick?.id).toBe('d');
    });

    it('returns null when every candidate is filtered', () => {
      const pick = pickFirstAvailable(items, new Set(['c', 'd']));
      expect(pick).toBeNull();
    });

    it('with requireId:false, returns the first unchecked non-NEEDS_INPUT item even without an ID', () => {
      const pick = pickFirstAvailable(
        [{ id: null, checked: false, needsInput: false }],
        new Set(),
        { requireId: false }
      );
      expect(pick?.id).toBeNull();
    });
  });
});
