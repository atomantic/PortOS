import { describe, it, expect } from 'vitest';
import { buildRevisionBrief, weakestDimensions, groupCutsByType } from './revisionBrief.js';

const judge = {
  overall: 6.0,
  slopPenalty: 1.0,
  qualityScore: 5.0,
  oneLineVerdict: 'Competent but over-explained; the middle sags.',
  strongestSentences: ['The bell tolled once, and the city held its breath.'],
  weakestSentences: ['She felt a sense of unease wash over her.'],
  topRevisions: ['Cut the interiority in the tavern scene.', 'Land the cliffhanger harder.'],
  dimensions: {
    voiceAdherence: { score: 8, fix: 'Hold the wry narrator voice in the council scene.' },
    beatCoverage: { score: 7, fix: '' },
    characterVoice: { score: 5, fix: 'Give the captain a distinct cadence.', weakestMoment: 'flat dialogue' },
    plantsSeeded: { score: 9, fix: '' },
    proseQuality: { score: 4, fix: 'Vary sentence length; too much uniform rhythm.' },
    continuity: { score: 8, fix: '' },
    canonCompliance: { score: 8, fix: '' },
    loreIntegration: { score: 7, fix: '' },
    engagement: { score: 6, fix: 'Raise stakes earlier.' },
  },
};

const cutComments = [
  { subtype: 'OVER-EXPLAIN', anchorQuote: 'which of course meant that she was afraid', problem: 'x' },
  { subtype: 'REDUNDANT', anchorQuote: 'again, once more, a second time', problem: 'y' },
  { subtype: 'OVER-EXPLAIN', anchorQuote: 'in other words, he was lying', problem: 'z' },
];

describe('weakestDimensions', () => {
  it('returns the lowest-scoring dimensions that carry a note, ascending', () => {
    const weak = weakestDimensions(judge, 3);
    expect(weak.map((d) => d.key)).toEqual(['proseQuality', 'characterVoice', 'engagement']);
    expect(weak[0].label).toBe('Prose quality');
  });
  it('skips dimensions with no fix and no weakestMoment', () => {
    const weak = weakestDimensions(judge, 9);
    expect(weak.find((d) => d.key === 'beatCoverage')).toBeUndefined();
  });
  it('tolerates a missing/empty judge', () => {
    expect(weakestDimensions(null)).toEqual([]);
    expect(weakestDimensions({})).toEqual([]);
  });
});

describe('groupCutsByType', () => {
  it('groups quotes by subtype and dedupes', () => {
    const groups = groupCutsByType([...cutComments, cutComments[0]]);
    expect(groups['OVER-EXPLAIN']).toHaveLength(2);
    expect(groups.REDUNDANT).toHaveLength(1);
  });
  it('falls back to UNCLASSIFIED for a missing subtype', () => {
    const groups = groupCutsByType([{ anchorQuote: 'orphan quote' }]);
    expect(groups.UNCLASSIFIED).toEqual(['orphan quote']);
  });
  it('ignores comments with no quote/problem', () => {
    expect(groupCutsByType([{ subtype: 'FAT' }])).toEqual({});
  });
});

describe('buildRevisionBrief', () => {
  const brief = buildRevisionBrief({
    issue: { number: 3, title: 'The Sundering' },
    judge,
    cutComments,
    panelConsensus: ['The Genre Reader: the tavern scene stalls momentum.'],
    currentChars: 12345,
  });

  it('has all five sections in order', () => {
    const idx = (s) => brief.indexOf(s);
    expect(idx('PROBLEM')).toBeGreaterThanOrEqual(0);
    expect(idx('WHAT TO KEEP')).toBeGreaterThan(idx('PROBLEM'));
    expect(idx('WHAT TO CHANGE')).toBeGreaterThan(idx('WHAT TO KEEP'));
    expect(idx('VOICE RULES')).toBeGreaterThan(idx('WHAT TO CHANGE'));
    expect(idx('TARGET')).toBeGreaterThan(idx('VOICE RULES'));
  });
  it('names the issue and carries the verdict', () => {
    expect(brief).toContain('Issue #3: The Sundering');
    expect(brief).toContain('Competent but over-explained');
  });
  it('protects the strongest sentence in WHAT TO KEEP', () => {
    expect(brief).toContain('The bell tolled once');
  });
  it('lists the judge revisions and grouped cuts in WHAT TO CHANGE', () => {
    expect(brief).toContain('Land the cliffhanger harder.');
    expect(brief).toContain('Cut (OVER-EXPLAIN)');
    expect(brief).toContain('Cut (REDUNDANT)');
  });
  it('carries the voice-adherence fix in VOICE RULES', () => {
    expect(brief).toContain('Hold the wry narrator voice');
  });
  it('mentions the current length in TARGET', () => {
    expect(brief).toContain('12,345');
  });

  it('degrades gracefully with no evidence', () => {
    const bare = buildRevisionBrief({ issue: { number: 1 }, judge: {} });
    expect(bare).toContain('WHAT TO KEEP');
    expect(bare).toContain('No specific edits surfaced');
    expect(bare).toContain('Hold the series voice');
  });
});
