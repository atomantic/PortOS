import { describe, it, expect } from 'vitest';
import {
  WRITING_LENGTH_TARGETS,
  BOOK_LENGTH_ESTIMATES,
  WRITING_PRINCIPLES,
  PLANNED_ANALYSES,
  classifyByWordCount,
} from './writingGuide.js';

describe('writingGuide data shape', () => {
  it('every length target carries id, label, and word/char bands with labels', () => {
    for (const t of WRITING_LENGTH_TARGETS) {
      expect(typeof t.id).toBe('string');
      expect(t.id.length).toBeGreaterThan(0);
      expect(typeof t.label).toBe('string');
      expect(typeof t.words.label).toBe('string');
      expect(typeof t.chars.label).toBe('string');
      expect(typeof t.core).toBe('boolean');
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
      // null max only allowed as the final, open-ended band.
      if (cur == null) {
        expect(i).toBe(maxes.length - 1);
      } else {
        expect(cur).toBeGreaterThan(prev ?? 0);
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
});
