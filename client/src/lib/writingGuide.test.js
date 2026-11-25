import { describe, it, expect } from 'vitest';
import {
  WRITING_LENGTH_TARGETS,
  BOOK_LENGTH_ESTIMATES,
  WRITING_PRINCIPLES,
  PLANNED_ANALYSES,
} from './writingGuide.js';

describe('writingGuide data shape', () => {
  it('every length target carries id, label, and word/char/page/chapter bands with labels', () => {
    for (const t of WRITING_LENGTH_TARGETS) {
      expect(typeof t.id).toBe('string');
      expect(t.id.length).toBeGreaterThan(0);
      expect(typeof t.label).toBe('string');
      expect(typeof t.words.label).toBe('string');
      expect(typeof t.chars.label).toBe('string');
      expect(typeof t.pages.label).toBe('string');
      expect(typeof t.chapters.label).toBe('string');
      expect(typeof t.core).toBe('boolean');
    }
  });

  it('marks single-sitting forms with null chapter bounds and chapter-bearing forms with numeric ones', () => {
    const chapters = Object.fromEntries(
      WRITING_LENGTH_TARGETS.map((t) => [t.id, t.chapters]),
    );
    // Forms typically read in one sitting carry null min/max bounds; the label
    // still renders so the card has a uniform shape.
    for (const id of ['microfiction', 'flash-fiction', 'short-story']) {
      expect(chapters[id].min).toBeNull();
      expect(chapters[id].max).toBeNull();
    }
    // Longer forms have numeric bounds.
    for (const id of ['novelette', 'novella', 'novel']) {
      expect(typeof chapters[id].min).toBe('number');
      expect(typeof chapters[id].max).toBe('number');
    }
  });

  it('preserves the four core categories from the brief', () => {
    const core = WRITING_LENGTH_TARGETS.filter((t) => t.core).map((t) => t.id);
    expect(core).toEqual(['microfiction', 'flash-fiction', 'short-story', 'novelette']);
  });

  it('orders the ladder by ascending upper word bound (with one open-ended top band)', () => {
    const maxes = WRITING_LENGTH_TARGETS.map((t) => t.words.max);
    for (let i = 1; i < maxes.length; i++) {
      const prev = maxes[i - 1];
      const cur = maxes[i];
      // A null max is only allowed on the final, open-ended band — and any prior
      // band must therefore have a finite max (a null `prev` here means an
      // open-ended band was misplaced earlier in the ladder).
      expect(prev).not.toBeNull();
      if (cur == null) {
        expect(i).toBe(maxes.length - 1);
      } else {
        expect(cur).toBeGreaterThan(prev);
      }
    }
  });

  it('book estimates carry page label, words/page, and word/char bands', () => {
    expect(BOOK_LENGTH_ESTIMATES.length).toBeGreaterThan(0);
    for (const b of BOOK_LENGTH_ESTIMATES) {
      expect(typeof b.label).toBe('string');
      expect(typeof b.wordsPerPage).toBe('string');
      expect(typeof b.words.label).toBe('string');
      expect(typeof b.chars.label).toBe('string');
    }
  });

  it('exposes principle groups with rules and at least one planned analysis', () => {
    expect(WRITING_PRINCIPLES.length).toBeGreaterThan(0);
    for (const g of WRITING_PRINCIPLES) {
      expect(typeof g.title).toBe('string');
      expect(Array.isArray(g.rules)).toBe(true);
      expect(g.rules.length).toBeGreaterThan(0);
    }
    expect(PLANNED_ANALYSES.some((a) => a.id === 'emotional-roadmap')).toBe(true);
  });
});

// @vitest-environment node
