import { describe, it, expect } from 'vitest';
import { dominant, projectAnalyzedPoints } from './editorialRoadmap.js';

describe('dominant', () => {
  it('returns the most frequent non-empty string', () => {
    expect(dominant(['dread', 'dread', 'hope'])).toBe('dread');
  });

  it('ignores empty/falsy values and returns "" for an empty list', () => {
    expect(dominant(['', null, undefined])).toBe('');
    expect(dominant([])).toBe('');
  });

  it('breaks ties toward the first to reach the max (insertion order)', () => {
    // hope and dread both appear twice; hope reaches 2 first → wins deterministically.
    expect(dominant(['hope', 'dread', 'hope', 'dread'])).toBe('hope');
  });
});

describe('projectAnalyzedPoints', () => {
  it('keeps only analyzed points with a non-null plot (0 is valid)', () => {
    const roadmap = [
      { issueId: 'a', analyzed: true, plot: 0 },
      { issueId: 'b', analyzed: false, plot: null },
      { issueId: 'c', analyzed: true, plot: 80 },
    ];
    const pts = projectAnalyzedPoints(roadmap);
    expect(pts.map((p) => p.issueId)).toEqual(['a', 'c']);
  });

  it('positions each point by its index in the FULL roadmap (frac), skipping gaps', () => {
    const roadmap = [
      { issueId: 'a', analyzed: true, plot: 10 },   // index 0 → frac 0
      { issueId: 'b', analyzed: false, plot: null }, // gap
      { issueId: 'c', analyzed: true, plot: 30 },   // index 2 → frac 1
    ];
    const pts = projectAnalyzedPoints(roadmap);
    expect(pts).toHaveLength(2);
    expect(pts[0].frac).toBe(0);
    expect(pts[1].frac).toBe(1);
  });

  it('places a single analyzed point at frac 1 (no divide-by-zero)', () => {
    expect(projectAnalyzedPoints([{ analyzed: true, plot: 50 }])[0].frac).toBe(1);
  });

  it('returns [] for an empty or missing roadmap', () => {
    expect(projectAnalyzedPoints([])).toEqual([]);
    expect(projectAnalyzedPoints()).toEqual([]);
  });
});
