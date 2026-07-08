import { describe, it, expect } from 'vitest';
import { KIND_META } from './evaluator.js';
import { buildKeepGuidance, buildRevisionBrief } from './polish.js';

describe('KIND_META — polish pass kinds', () => {
  it('includes cuts and revise as body-transform passes', () => {
    expect(KIND_META.cuts).toMatchObject({ stage: 'writers-room-cuts', returnsJson: true, bodyPass: true });
    expect(KIND_META.revise).toMatchObject({ stage: 'writers-room-revise', returnsJson: false, bodyPass: true });
  });

  it('leaves the existing analysis kinds as non-bodyPass', () => {
    for (const kind of ['evaluate', 'format', 'script', 'characters', 'places', 'objects']) {
      expect(KIND_META[kind]).toBeTruthy();
      expect(KIND_META[kind].bodyPass).toBeUndefined();
      expect(typeof KIND_META[kind].stage).toBe('string');
    }
  });

  it('every entry carries a stage + returnsJson boolean', () => {
    for (const [kind, meta] of Object.entries(KIND_META)) {
      expect(typeof meta.stage, `${kind}.stage`).toBe('string');
      expect(typeof meta.returnsJson, `${kind}.returnsJson`).toBe('boolean');
    }
  });
});

describe('buildKeepGuidance', () => {
  it('renders logline + strengths as a bullet list', () => {
    const out = buildKeepGuidance({
      logline: 'A boy finds a dragon.',
      strengths: ['Vivid sensory prose', 'Strong dialogue'],
    });
    expect(out).toContain('- Core story: A boy finds a dragon.');
    expect(out).toContain('- Vivid sensory prose');
    expect(out).toContain('- Strong dialogue');
  });

  it('falls back to a generic preservation note when no strengths', () => {
    expect(buildKeepGuidance({})).toMatch(/existing voice, plot beats/i);
    expect(buildKeepGuidance(null)).toMatch(/existing voice/i);
  });

  it('ignores non-string strengths', () => {
    const out = buildKeepGuidance({ strengths: [null, 42, 'Real strength', ''] });
    expect(out).toBe('- Real strength');
  });
});

describe('buildRevisionBrief', () => {
  it('renders issues (severity + category + note) and suggestions', () => {
    const out = buildRevisionBrief({
      issues: [{ severity: 'major', category: 'pacing', note: 'Act two drags.' }],
      suggestions: [{ target: 'ch3', recommendation: 'Cut the flashback.' }],
    });
    expect(out).toContain('[MAJOR pacing] Act two drags.');
    expect(out).toContain('- Cut the flashback.');
  });

  it('falls back to a light copy-edit instruction when empty', () => {
    expect(buildRevisionBrief({})).toMatch(/light copy-edit/i);
    expect(buildRevisionBrief({ issues: [], suggestions: [] })).toMatch(/light copy-edit/i);
  });

  it('skips malformed issue/suggestion entries', () => {
    const out = buildRevisionBrief({
      issues: [null, { severity: 'minor', note: '' }, { note: 'Real issue.' }],
      suggestions: ['bad', { recommendation: 'Real rec.' }],
    });
    expect(out).toContain('Real issue.');
    expect(out).toContain('Real rec.');
    expect(out).not.toContain('bad');
  });
});
