import { describe, it, expect } from 'vitest';
import {
  slugify,
  parsePlanItems,
  assignMissingIds,
  extractAllIds,
  pickFirstAvailable,
  diagnoseUnpickablePlan,
  extractSlugFromRef
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

    it('marks items whose preceding line is a `> ⚠️ DRIFT:` blockquote', () => {
      const md = [
        '## Next Up',
        '- [ ] [a] Clean item',
        '> ⚠️ DRIFT: function removed in #100',
        '- [ ] [b] Stale item',
        '- [ ] [c] Another clean item'
      ].join('\n');
      const items = parsePlanItems(md);
      expect(items[0].drifted).toBe(false);
      expect(items[1].drifted).toBe(true);
      expect(items[2].drifted).toBe(false);
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
      { id: 'a', checked: true, needsInput: false, drifted: false },
      { id: 'b', checked: false, needsInput: true, drifted: false },
      { id: 'c', checked: false, needsInput: false, drifted: false },
      { id: 'd', checked: false, needsInput: false, drifted: false },
      { id: null, checked: false, needsInput: false, drifted: false }
    ];

    it('skips checked, NEEDS_INPUT, and in-flight items', () => {
      const pick = pickFirstAvailable(items, new Set(['c']));
      expect(pick?.id).toBe('d');
    });

    it('returns null when every candidate is filtered', () => {
      const pick = pickFirstAvailable(items, new Set(['c', 'd']));
      expect(pick).toBeNull();
    });

    it('skips drifted items', () => {
      const itemsWithDrift = [
        { id: 'a', checked: false, needsInput: false, drifted: true },
        { id: 'b', checked: false, needsInput: false, drifted: false }
      ];
      const pick = pickFirstAvailable(itemsWithDrift);
      expect(pick?.id).toBe('b');
    });

    it('with requireId:false, returns the first unchecked non-NEEDS_INPUT item even without an ID', () => {
      const pick = pickFirstAvailable(
        [{ id: null, checked: false, needsInput: false, drifted: false }],
        new Set(),
        { requireId: false }
      );
      expect(pick?.id).toBeNull();
    });
  });

  describe('diagnoseUnpickablePlan', () => {
    it('flags missing/empty PLAN.md', () => {
      expect(diagnoseUnpickablePlan('')).toMatch(/missing or empty/);
      expect(diagnoseUnpickablePlan(null)).toMatch(/missing or empty/);
    });

    it('flags a plan with only checked items', () => {
      const md = '# Plan\n\n- [x] [a] Done one\n- [x] [b] Done two';
      expect(diagnoseUnpickablePlan(md)).toMatch(/no unchecked items/);
    });

    it('flags a plan with no checkbox items at all', () => {
      expect(diagnoseUnpickablePlan('# Plan\n\nNo checkboxes here.')).toMatch(/no unchecked items/);
    });

    it('flags when every unchecked item is NEEDS_INPUT', () => {
      const md = [
        '# Plan',
        '- [ ] [a] Item one <!-- NEEDS_INPUT -->',
        '- [ ] [b] Item two <!-- NEEDS_INPUT -->'
      ].join('\n');
      expect(diagnoseUnpickablePlan(md)).toMatch(/blocked on human input/);
    });

    it('flags when every unchecked item is preceded by a DRIFT marker', () => {
      const md = [
        '# Plan',
        '> ⚠️ DRIFT: function removed in #100',
        '- [ ] [a] Item one',
        '> ⚠️ DRIFT: file deleted',
        '- [ ] [b] Item two'
      ].join('\n');
      expect(diagnoseUnpickablePlan(md)).toMatch(/blocked on human input/);
    });

    it('flags when remaining items are all in-flight + NEEDS_INPUT mix', () => {
      const md = [
        '# Plan',
        '- [ ] [a] In flight elsewhere',
        '- [ ] [b] Blocked <!-- NEEDS_INPUT -->'
      ].join('\n');
      expect(diagnoseUnpickablePlan(md, new Set(['a']))).toMatch(/claimed by other agents/);
    });

    it('returns null when at least one item is pickable', () => {
      const md = [
        '# Plan',
        '- [ ] [a] Free to pick',
        '- [ ] [b] Blocked <!-- NEEDS_INPUT -->'
      ].join('\n');
      expect(diagnoseUnpickablePlan(md)).toBeNull();
    });

    it('returns null for the mixed missing-IDs case so do-replan can still run', () => {
      // The agent's Phase 1 step 2 handles missing IDs by exiting cleanly,
      // but that path is fast and `do-replan` is the recovery — not a skip
      // case for plan-task dispatch.
      const md = [
        '# Plan',
        '- [ ] Item without an ID'
      ].join('\n');
      expect(diagnoseUnpickablePlan(md)).toBeNull();
    });

    it('accepts an array as inFlightIds (not just a Set)', () => {
      const md = [
        '# Plan',
        '- [ ] [a] One',
        '- [ ] [b] Blocked <!-- NEEDS_INPUT -->'
      ].join('\n');
      expect(diagnoseUnpickablePlan(md, ['a'])).toMatch(/claimed by other agents/);
    });

    it('reuses pre-parsed items when supplied (no second parse)', () => {
      const md = [
        '# Plan',
        '- [ ] [a] One <!-- NEEDS_INPUT -->',
        '- [ ] [b] Two <!-- NEEDS_INPUT -->'
      ].join('\n');
      const items = parsePlanItems(md);
      expect(diagnoseUnpickablePlan(null, new Set(), items)).toMatch(/blocked on human input/);
    });
  });

  describe('extractSlugFromRef', () => {
    it('extracts the slug from claim/<slug>', () => {
      expect(extractSlugFromRef('claim/foo-bar')).toBe('foo-bar');
      expect(extractSlugFromRef('claim/some-slug-with-dashes-50chars')).toBe('some-slug-with-dashes-50chars');
    });

    it('strips a single leading remote prefix before matching claim/', () => {
      expect(extractSlugFromRef('origin/claim/foo')).toBe('foo');
      expect(extractSlugFromRef('upstream/claim/bar')).toBe('bar');
      expect(extractSlugFromRef('fork-remote/claim/baz')).toBe('baz');
    });

    it('extracts the slug-position segment from cos/<task>/<slug>/<agent>', () => {
      expect(extractSlugFromRef('cos/some-task/my-slug/agent-id')).toBe('my-slug');
      expect(extractSlugFromRef('origin/cos/task/slug/agent')).toBe('slug');
    });

    it('returns null for unrelated refs (the false-positive case)', () => {
      // Without this gate, a slug literally named "main"/"fix"/etc. would be
      // falsely flagged as in-flight against virtually every branch.
      expect(extractSlugFromRef('main')).toBeNull();
      expect(extractSlugFromRef('release')).toBeNull();
      expect(extractSlugFromRef('feature/foo')).toBeNull();
      expect(extractSlugFromRef('origin/main')).toBeNull();
      expect(extractSlugFromRef('origin/HEAD')).toBeNull();
      expect(extractSlugFromRef('fix-typo')).toBeNull();
      expect(extractSlugFromRef('refs/tags/v1.0.0')).toBeNull();
    });

    it('returns null for malformed cos refs', () => {
      expect(extractSlugFromRef('cos/task/slug')).toBeNull(); // missing agent segment
      expect(extractSlugFromRef('cos/task/slug/agent/extra')).toBeNull(); // too many segments
    });

    it('returns null for non-string / empty input', () => {
      expect(extractSlugFromRef('')).toBeNull();
      expect(extractSlugFromRef(null)).toBeNull();
      expect(extractSlugFromRef(undefined)).toBeNull();
    });

    it('rejects symbolic-ref alias lines that older git versions emit', () => {
      // `--format=%(refname:short)` strips these, but defense-in-depth covers
      // any caller that switches branch listings.
      expect(extractSlugFromRef('origin/HEAD -> origin/main')).toBeNull();
      expect(extractSlugFromRef('HEAD')).toBeNull();
    });

    it('greedy-captures everything after claim/ (slugs are kebab-case in practice)', () => {
      // Pins the current behavior: if a slug ever contained a `/`, the gate
      // would compare against the full string. Slugs are slash-free today;
      // this test fails loudly if that ever changes.
      expect(extractSlugFromRef('claim/foo/bar')).toBe('foo/bar');
    });
  });
});
