import { describe, it, expect } from 'vitest';
import {
  WHOLE_SONG_SCOPE,
  HISTORY_MAX,
  LEARNED_PERCENT,
  LEARNED_STREAK,
  WEAK_PERCENT,
  deriveTrainingSections,
  recordAttempt,
  scopeStats,
  wholeSongStats,
  weakestSections,
  memorizationPercent,
  hideLevelFor,
} from './songProgress.js';

const HEADER = ['clef: treble', 'key: G', 'time: 4/4', 'tempo: 68'].join('\n');
const TWO_SECTION_SCORE = [
  HEADER,
  '',
  '| [G] D4q(If) D4q(you) | [G] B4h(miss) |',
  '| [Em] B4h(on) | [C] C5q(know) G4q(am) |',
  '',
  '| [Am7] E4h(gone) | [D7] A4q(hear) |',
].join('\n');

describe('deriveTrainingSections', () => {
  it('splits the score body into blank-line-separated sections, header preserved', () => {
    const sections = deriveTrainingSections(TWO_SECTION_SCORE);
    expect(sections).toHaveLength(2);
    // Each section's sliced score carries the header so it renders/grades alone.
    expect(sections[0].score.startsWith(HEADER)).toBe(true);
    expect(sections[1].score.startsWith(HEADER)).toBe(true);
    // Positional, stable ids.
    expect(sections.map((s) => s.id)).toEqual(['sec-1', 'sec-2']);
    // First block: two lines of two measures each = 4; second block: 2.
    expect(sections[0].measures).toBe(4);
    expect(sections[1].measures).toBe(2);
    // Running measure offset.
    expect(sections[0].startMeasure).toBe(0);
    expect(sections[1].startMeasure).toBe(4);
  });

  it('labels sections from matching lyric sections when provided', () => {
    const sections = deriveTrainingSections(TWO_SECTION_SCORE, [
      { label: 'Verse 1' }, { label: 'Chorus' },
    ]);
    expect(sections[0].label).toBe('Verse 1');
    expect(sections[1].label).toBe('Chorus');
  });

  it('falls back to positional labels without lyric sections', () => {
    const sections = deriveTrainingSections(TWO_SECTION_SCORE);
    expect(sections[0].label).toBe('Section 1');
    expect(sections[1].label).toBe('Section 2');
  });

  it('returns [] for a score with no music body', () => {
    expect(deriveTrainingSections(HEADER)).toEqual([]);
    expect(deriveTrainingSections('')).toEqual([]);
    expect(deriveTrainingSections(null)).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const crlf = TWO_SECTION_SCORE.replace(/\n/g, '\r\n');
    expect(deriveTrainingSections(crlf)).toHaveLength(2);
  });
});

describe('recordAttempt', () => {
  it('appends a graded attempt newest-last under the scope, immutably', () => {
    const before = { history: {} };
    const after = recordAttempt(before, 'sec-1', { percentInTune: 90, graded: 4 });
    expect(after).not.toBe(before);
    expect(before.history).toEqual({}); // input untouched
    expect(after.history['sec-1']).toHaveLength(1);
    expect(after.history['sec-1'][0].percentInTune).toBe(90);
    expect(after.history['sec-1'][0].graded).toBe(4);
    expect(typeof after.history['sec-1'][0].at).toBe('string');
  });

  it('drops a zero-note take (no signal)', () => {
    const after = recordAttempt(null, 'sec-1', { percentInTune: 0, graded: 0 });
    expect(after.history['sec-1']).toBeUndefined();
  });

  it('clamps percent into 0..100', () => {
    const after = recordAttempt(null, WHOLE_SONG_SCOPE, { percentInTune: 250, graded: 3 });
    expect(after.history[WHOLE_SONG_SCOPE][0].percentInTune).toBe(100);
  });

  it('bounds the per-scope history to HISTORY_MAX (keeps the newest)', () => {
    let p = null;
    for (let i = 0; i < HISTORY_MAX + 10; i += 1) {
      p = recordAttempt(p, 'sec-1', { percentInTune: i % 100, graded: 2 });
    }
    expect(p.history['sec-1']).toHaveLength(HISTORY_MAX);
    // Last appended wins the tail.
    const lastPct = (HISTORY_MAX + 9) % 100;
    expect(p.history['sec-1'][HISTORY_MAX - 1].percentInTune).toBe(lastPct);
  });
});

describe('scopeStats', () => {
  it('returns a zeroed shape for an un-attempted scope', () => {
    expect(scopeStats({ history: {} }, 'sec-1')).toEqual({
      attempts: 0, best: 0, average: 0, last: 0, streak: 0, learned: false,
    });
    expect(scopeStats(null, 'sec-1').attempts).toBe(0);
  });

  it('computes best, average, last from history', () => {
    let p = null;
    p = recordAttempt(p, 'sec-1', { percentInTune: 40, graded: 5 });
    p = recordAttempt(p, 'sec-1', { percentInTune: 90, graded: 5 });
    p = recordAttempt(p, 'sec-1', { percentInTune: 50, graded: 5 });
    const st = scopeStats(p, 'sec-1');
    expect(st.attempts).toBe(3);
    expect(st.best).toBe(90);
    expect(st.average).toBe(60); // (40+90+50)/3
    expect(st.last).toBe(50);
  });

  it('flips learned after a streak of LEARNED_STREAK takes at/above threshold', () => {
    let p = null;
    // One below-threshold then a fresh streak — streak counts from the newest back.
    p = recordAttempt(p, 'sec-1', { percentInTune: 50, graded: 5 });
    for (let i = 0; i < LEARNED_STREAK - 1; i += 1) {
      p = recordAttempt(p, 'sec-1', { percentInTune: LEARNED_PERCENT + 5, graded: 5 });
    }
    expect(scopeStats(p, 'sec-1').learned).toBe(false); // one short of the streak
    p = recordAttempt(p, 'sec-1', { percentInTune: LEARNED_PERCENT, graded: 5 });
    const st = scopeStats(p, 'sec-1');
    expect(st.streak).toBe(LEARNED_STREAK);
    expect(st.learned).toBe(true);
  });

  it('a below-threshold take breaks the streak (learned drops)', () => {
    let p = null;
    for (let i = 0; i < LEARNED_STREAK; i += 1) {
      p = recordAttempt(p, 'sec-1', { percentInTune: 95, graded: 5 });
    }
    expect(scopeStats(p, 'sec-1').learned).toBe(true);
    p = recordAttempt(p, 'sec-1', { percentInTune: 40, graded: 5 });
    const st = scopeStats(p, 'sec-1');
    expect(st.streak).toBe(0);
    expect(st.learned).toBe(false);
  });

  it('wholeSongStats reads the whole-song sentinel scope', () => {
    const p = recordAttempt(null, WHOLE_SONG_SCOPE, { percentInTune: 70, graded: 8 });
    expect(wholeSongStats(p).attempts).toBe(1);
    expect(wholeSongStats(p).best).toBe(70);
  });
});

describe('weakestSections', () => {
  const sections = [
    { id: 'sec-1', label: 'A' },
    { id: 'sec-2', label: 'B' },
    { id: 'sec-3', label: 'C' },
  ];

  it('surfaces un-attempted sections first, then lowest average', () => {
    let p = null;
    // sec-1 solid, sec-2 weak, sec-3 never attempted.
    p = recordAttempt(p, 'sec-1', { percentInTune: 95, graded: 5 });
    p = recordAttempt(p, 'sec-2', { percentInTune: 30, graded: 5 });
    const weak = weakestSections(p, sections);
    // sec-1 is solid (≥ WEAK_PERCENT) so it drops off.
    expect(weak.map((s) => s.id)).toEqual(['sec-3', 'sec-2']);
    expect(weak[0].stats.attempts).toBe(0); // never-attempted first
  });

  it('omits sections at or above WEAK_PERCENT', () => {
    const p = recordAttempt(
      recordAttempt(recordAttempt(null, 'sec-1', { percentInTune: WEAK_PERCENT, graded: 5 }),
        'sec-2', { percentInTune: WEAK_PERCENT, graded: 5 }),
      'sec-3', { percentInTune: WEAK_PERCENT, graded: 5 },
    );
    expect(weakestSections(p, sections)).toEqual([]);
  });
});

describe('memorizationPercent', () => {
  const sections = [{ id: 'sec-1' }, { id: 'sec-2' }];

  it('is the share of learned sections', () => {
    let p = null;
    expect(memorizationPercent(p, sections)).toBe(0);
    for (let i = 0; i < LEARNED_STREAK; i += 1) {
      p = recordAttempt(p, 'sec-1', { percentInTune: 95, graded: 5 });
    }
    expect(memorizationPercent(p, sections)).toBe(50); // 1 of 2 learned
  });

  it('is 0 with no sections', () => {
    expect(memorizationPercent({ history: {} }, [])).toBe(0);
  });
});

describe('hideLevelFor', () => {
  it('maps the rolling average to a progressive hiding level', () => {
    expect(hideLevelFor(0)).toBe('show');
    expect(hideLevelFor(WEAK_PERCENT)).toBe('dim');
    expect(hideLevelFor(LEARNED_PERCENT)).toBe('hide');
    expect(hideLevelFor(95)).toBe('blind');
    expect(hideLevelFor(100)).toBe('blind');
  });

  it('treats invalid input as the lowest level', () => {
    expect(hideLevelFor(NaN)).toBe('show');
    expect(hideLevelFor(null)).toBe('show');
  });
});
