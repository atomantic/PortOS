import { describe, it, expect } from 'vitest';
import {
  classifyQualification,
  isMajorityHedged,
  detectPlateau,
  decideKeepRevert,
  evaluateRevisionStop,
  HEDGE_PHRASES,
} from './revisionStop.js';

describe('classifyQualification', () => {
  it('flags hedge phrases as hedged (case-insensitive substring)', () => {
    expect(classifyQualification('This is individually fine, but the pacing sags.')).toBe('hedged');
    expect(classifyQualification('A DELIBERATE CHOICE to slow the reveal.')).toBe('hedged');
    expect(classifyQualification('the costs of ambition here are acceptable')).toBe('hedged');
  });
  it('treats a real defect as actionable', () => {
    expect(classifyQualification('The villain\'s motivation is never established.')).toBe('actionable');
  });
  it('defaults empty / non-string to actionable', () => {
    expect(classifyQualification('')).toBe('actionable');
    expect(classifyQualification(null)).toBe('actionable');
    expect(classifyQualification(42)).toBe('actionable');
  });
  it('every HEDGE_PHRASE classifies as hedged', () => {
    for (const p of HEDGE_PHRASES) expect(classifyQualification(`note: ${p} indeed`)).toBe('hedged');
  });
});

describe('isMajorityHedged', () => {
  it('is true only on a strict majority', () => {
    expect(isMajorityHedged(['individually fine', 'deliberate choice', 'real defect here'])).toBe(true);
    expect(isMajorityHedged(['individually fine', 'real defect', 'another real defect'])).toBe(false);
  });
  it('a tie (exactly half) is NOT a majority', () => {
    expect(isMajorityHedged(['individually fine', 'a genuine problem'])).toBe(false);
  });
  it('empty list is not majority-hedged', () => {
    expect(isMajorityHedged([])).toBe(false);
    expect(isMajorityHedged(['', '   '])).toBe(false);
  });
});

describe('detectPlateau', () => {
  it('needs at least two scores', () => {
    expect(detectPlateau([7.5], 0.3)).toBe(false);
    expect(detectPlateau([], 0.3)).toBe(false);
  });
  it('true when the last delta is below the threshold', () => {
    expect(detectPlateau([6.0, 7.0, 7.1], 0.3)).toBe(true);
  });
  it('false when the last delta meets or exceeds the threshold', () => {
    expect(detectPlateau([6.0, 7.0], 0.3)).toBe(false);
    expect(detectPlateau([7.0, 7.4], 0.3)).toBe(false); // 0.4 delta is well above the threshold
  });
  it('ignores non-finite entries', () => {
    expect(detectPlateau([7.0, NaN, 7.1], 0.3)).toBe(true);
  });
});

describe('decideKeepRevert', () => {
  it('keeps when post >= pre', () => {
    expect(decideKeepRevert(6.0, 6.0)).toBe('keep');
    expect(decideKeepRevert(6.0, 7.2)).toBe('keep');
  });
  it('reverts on a genuine regression', () => {
    expect(decideKeepRevert(7.2, 6.0)).toBe('revert');
  });
  it('keeps when either score is unknown (cannot prove a regression)', () => {
    expect(decideKeepRevert(null, 6.0)).toBe('keep');
    expect(decideKeepRevert(6.0, undefined)).toBe('keep');
    expect(decideKeepRevert(NaN, NaN)).toBe('keep');
  });
});

describe('evaluateRevisionStop', () => {
  it('stops at maxCycles regardless of score/findings', () => {
    const r = evaluateRevisionStop({ cyclesRun: 2, minCycles: 1, maxCycles: 2, scoreHistory: [5, 8], findingTexts: ['real defect'] });
    expect(r.stop).toBe(true);
    expect(r.reason).toBe('maxCycles');
  });
  it('does not stop before minCycles even on a plateau', () => {
    const r = evaluateRevisionStop({ cyclesRun: 1, minCycles: 2, maxCycles: 5, scoreHistory: [7.0, 7.05], plateauDelta: 0.3 });
    expect(r.stop).toBe(false);
  });
  it('stops on hedged convergence after minCycles', () => {
    const r = evaluateRevisionStop({
      cyclesRun: 1, minCycles: 1, maxCycles: 5,
      scoreHistory: [6.0, 8.0], plateauDelta: 0.3,
      findingTexts: ['individually fine', 'deliberate choice', 'a real defect'],
    });
    expect(r.stop).toBe(true);
    expect(r.reason).toBe('hedged');
  });
  it('stops on plateau after minCycles when findings are actionable', () => {
    const r = evaluateRevisionStop({
      cyclesRun: 2, minCycles: 1, maxCycles: 5,
      scoreHistory: [7.0, 7.1], plateauDelta: 0.3,
      findingTexts: ['a real defect', 'another problem'],
    });
    expect(r.stop).toBe(true);
    expect(r.reason).toBe('plateau');
  });
  it('keeps cycling when score is still climbing and findings are actionable', () => {
    const r = evaluateRevisionStop({
      cyclesRun: 1, minCycles: 1, maxCycles: 5,
      scoreHistory: [6.0, 7.5], plateauDelta: 0.3,
      findingTexts: ['a real defect'],
    });
    expect(r.stop).toBe(false);
    expect(r.reason).toBe(null);
  });
});
