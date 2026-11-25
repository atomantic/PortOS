import { describe, it, expect } from 'vitest';
import {
  PRACTICE_GROUPS,
  PRACTICE_ENTRIES,
  TAG_LABELS,
  filterPracticeGroups,
} from './practiceCatalog';
import { POST_TOPICS, DRILL_LABELS, DRILL_DESCRIPTIONS, DRILL_PRACTICE_LINKS } from './constants';
import {
  RHETORIC_MODES,
  MEMORY_PRACTICE_MODES,
  ELEMENTS_PRACTICE_MODES,
  MORSE_MODES,
  MORSE_REFERENCE_VIEWS,
} from './trainerModes';

describe('practice catalog coverage', () => {
  // The whole point of the library is that NOTHING is undiscoverable. If a topic
  // gains a drill type and the catalog is derived correctly, this passes for
  // free; if someone hand-lists entries instead, it fails.
  it('lists every drill type owned by every registered topic', () => {
    const catalogued = new Set(PRACTICE_ENTRIES.map(e => e.drillType).filter(Boolean));
    const missing = POST_TOPICS.flatMap(t => t.drillTypes).filter(type => !catalogued.has(type));
    expect(missing).toEqual([]);
  });

  it('gives every drill-type entry a human label and a description', () => {
    const bare = PRACTICE_ENTRIES
      .filter(e => e.drillType)
      .filter(e => !e.label || e.label === e.drillType || !e.description);
    expect(bare.map(e => e.drillType)).toEqual([]);
  });

  // Rhetoric is the reason this page exists — it shipped with no link anywhere in
  // the app. This asserts the whole surface, not just that one group: every mode
  // every standalone trainer serves must be linked from the library, so the same
  // bug can't come back one mode at a time.
  it.each([
    ['rhetoric', RHETORIC_MODES, (id) => `/post/rhetoric/${id}`],
    ['elements', ELEMENTS_PRACTICE_MODES, (id) => `/post/memory/elements/${id}`],
    ['morse', MORSE_MODES, (id) => `/post/morse/${id}`],
    ['reference', MORSE_REFERENCE_VIEWS, (id) => `/post/morse?ref=${id}`],
  ])('links every mode the %s trainer serves', (_name, modes, href) => {
    const linked = new Set(PRACTICE_ENTRIES.map(e => e.to));
    expect(modes.map(m => href(m.id)).filter(to => !linked.has(to))).toEqual([]);
  });

  it('lists every memorization study mode, which has no per-mode URL of its own', () => {
    const memorization = PRACTICE_GROUPS.find(g => g.id === 'memorization');
    const labels = memorization.entries.map(e => e.label);
    expect(MEMORY_PRACTICE_MODES.map(m => m.label).filter(l => !labels.includes(l))).toEqual([]);
  });

  it('links every drill type that has a standalone trainer', () => {
    for (const [type, to] of Object.entries(DRILL_PRACTICE_LINKS)) {
      const entry = PRACTICE_ENTRIES.find(e => e.drillType === type);
      // memory-element-study has no topic entry (it is not a session drill), so
      // only assert the link when the type is catalogued as a drill.
      if (entry) expect(entry.to, type).toBe(to);
    }
  });

  it('tags a session drill as in-session and an AI drill as needing a provider', () => {
    const multiplication = PRACTICE_ENTRIES.find(e => e.drillType === 'multiplication');
    expect(multiplication.tags).toContain('session');
    expect(multiplication.tags).not.toContain('ai');
    expect(multiplication.to).toBeNull();

    const bridge = PRACTICE_ENTRIES.find(e => e.drillType === 'bridge-word');
    expect(bridge.tags).toEqual(expect.arrayContaining(['session', 'standalone', 'ai']));
  });

  it('uses only declared tags', () => {
    const unknown = PRACTICE_ENTRIES.flatMap(e => e.tags).filter(tag => !TAG_LABELS[tag]);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('has unique entry ids within each group', () => {
    for (const group of PRACTICE_GROUPS) {
      const ids = group.entries.map(e => e.id);
      expect(new Set(ids).size, group.id).toBe(ids.length);
    }
  });
});

describe('filterPracticeGroups', () => {
  it('returns every group unchanged for an empty query', () => {
    const all = filterPracticeGroups('');
    expect(all).toHaveLength(PRACTICE_GROUPS.length);
    expect(all.flatMap(g => g.entries)).toHaveLength(PRACTICE_ENTRIES.length);
  });

  it('drops groups with no surviving entries', () => {
    const groups = filterPracticeGroups('iambic');
    expect(groups.map(g => g.id)).toEqual(['rhetoric']);
    expect(groups[0].entries.map(e => e.label)).toEqual(['Iambic Pentameter']);
  });

  it('matches a group by its own label so "morse" finds the trainers and the charts', () => {
    const ids = filterPracticeGroups('morse').map(g => g.id);
    expect(ids).toContain('morse');
    expect(ids).toContain('reference');
  });

  it('returns nothing for a query that matches no practice', () => {
    expect(filterPracticeGroups('zzzznotathing')).toEqual([]);
  });
});

describe('drill description coverage', () => {
  // A drill type that ships a label but no description renders a blank card in
  // the library AND a blank subtitle in Drill Config, which both read the map.
  it('describes every labelled drill type', () => {
    const missing = Object.keys(DRILL_LABELS).filter(type => !DRILL_DESCRIPTIONS[type]);
    expect(missing).toEqual([]);
  });

  it('does not describe a type that has no label', () => {
    const orphans = Object.keys(DRILL_DESCRIPTIONS).filter(type => !DRILL_LABELS[type]);
    expect(orphans).toEqual([]);
  });
});
