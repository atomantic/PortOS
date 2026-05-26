import { describe, it, expect } from 'vitest';
import {
  WRITING_LENGTH_TARGETS,
  BOOK_LENGTH_ESTIMATES,
  WRITING_PRINCIPLES,
  PLANNED_ANALYSES,
  classifyByWordCount,
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

describe('classifyByWordCount', () => {
  it('rejects invalid input with null', () => {
    expect(classifyByWordCount(undefined)).toBeNull();
    expect(classifyByWordCount(NaN)).toBeNull();
    expect(classifyByWordCount(-10)).toBeNull();
    expect(classifyByWordCount('1000')).toBeNull();
  });

  it('labels counts within a band', () => {
    expect(classifyByWordCount(0).id).toBe('microfiction');
    expect(classifyByWordCount(500).id).toBe('microfiction');
    expect(classifyByWordCount(900).id).toBe('flash-fiction');
    expect(classifyByWordCount(5000).id).toBe('short-story');
    expect(classifyByWordCount(12000).id).toBe('novelette');
    expect(classifyByWordCount(25000).id).toBe('novella');
  });

  it('rounds a gap count up to the next band', () => {
    // 600 sits between microfiction (≤500) and flash (750–1000) → rounds to flash.
    expect(classifyByWordCount(600).id).toBe('flash-fiction');
    // 1200 sits between flash (≤1000) and short story (1500–7500) → short story.
    expect(classifyByWordCount(1200).id).toBe('short-story');
  });

  it('treats anything above every band as a novel', () => {
    expect(classifyByWordCount(500000).id).toBe('novel');
  });

  it('assigns shared boundary values to the higher band', () => {
    // Adjacent bands share boundary values by literary convention (the lower
    // band's max equals the higher band's min). Classification must be
    // deterministic, with the higher band owning the boundary.
    expect(classifyByWordCount(7500).id).toBe('novelette'); // short-story.max === novelette.min
    expect(classifyByWordCount(17500).id).toBe('novella'); // novelette.max === novella.min
    expect(classifyByWordCount(40000).id).toBe('novel'); // novella.max === novel.min
    // One word below each boundary still lands in the lower band.
    expect(classifyByWordCount(7499).id).toBe('short-story');
    expect(classifyByWordCount(17499).id).toBe('novelette');
    expect(classifyByWordCount(39999).id).toBe('novella');
  });
});
