import { describe, it, expect } from 'vitest';
import { applyEditedSections, sectionsFromLyricSpans, remapScenesToSections } from './musicVideoSections.js';

const prior = [
  { label: 'Section 1', startSec: 0, endSec: 20, energy: 0.4 },
  { label: 'Section 2', startSec: 20, endSec: 60, energy: 1 },
];

describe('applyEditedSections', () => {
  it('splits a section and keeps its energy by overlap', () => {
    const out = applyEditedSections([
      { label: 'Intro', startSec: 0, endSec: 20 },
      { label: 'Chorus', startSec: 20, endSec: 40 },
      { label: 'Post-chorus', startSec: 40, endSec: 60 },
    ], prior, 60);
    expect(out.map((s) => s.energy)).toEqual([0.4, 1, 1]);
    expect(out.every((s) => s.labelSource === 'manual')).toBe(true);
  });

  it('merges sections, averaging energy weighted by overlap', () => {
    const [only] = applyEditedSections([{ label: 'All', startSec: 0, endSec: 60 }], prior, 60);
    expect(only.energy).toBeCloseTo((20 * 0.4 + 40) / 60, 3);
  });

  it.each([
    ['a gap', [{ label: 'A', startSec: 0, endSec: 10 }, { label: 'B', startSec: 20, endSec: 60 }]],
    ['an overlap', [{ label: 'A', startSec: 0, endSec: 30 }, { label: 'B', startSec: 20, endSec: 60 }]],
    ['a short section', [{ label: 'A', startSec: 0, endSec: 0.2 }, { label: 'B', startSec: 0.2, endSec: 60 }]],
    ['a blank name', [{ label: ' ', startSec: 0, endSec: 60 }]],
    ['an early end', [{ label: 'A', startSec: 0, endSec: 50 }]],
    ['a late start', [{ label: 'A', startSec: 5, endSec: 60 }]],
  ])('rejects %s', (_name, sections) => {
    expect(() => applyEditedSections(sections, prior, 60)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('sectionsFromLyricSpans', () => {
  const cues = [{ text: 'a', startSec: 10, endSec: 14 }, { text: 'b', startSec: 30, endSec: 34 }];
  const markers = [{ type: 'section', label: 'Chorus', kind: 'chorus', line: 0 }, { type: 'section', label: 'Post-chorus', kind: 'other', line: 1 }];

  it('tiles the song with Intro, the lyric sections and Outro', () => {
    const out = sectionsFromLyricSpans(cues, markers, 60);
    expect(out.map((s) => s.label)).toEqual(['Intro', 'Chorus', 'Post-chorus', 'Outro']);
    expect(() => applyEditedSections(out, prior, 60)).not.toThrow();
  });

  it('is empty without timed sections', () => {
    expect(sectionsFromLyricSpans([], markers, 60)).toEqual([]);
  });
});

describe('remapScenesToSections', () => {
  it('re-points section-tied scenes by midpoint and leaves untied ones', () => {
    const sections = [{ label: 'A', startSec: 0, endSec: 10 }, { label: 'B', startSec: 10, endSec: 20 }];
    const [tied, free] = remapScenesToSections([
      { sectionIndex: 0, sectionLabel: 'Old', startSec: 12, endSec: 18 },
      { sectionIndex: null, sectionLabel: null, startSec: 12, endSec: 18 },
    ], sections);
    expect(tied).toMatchObject({ sectionIndex: 1, sectionLabel: 'B' });
    expect(free.sectionLabel).toBeNull();
  });
});
