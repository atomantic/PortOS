/**
 * The integrity contract's own guarantees — the ones a route or UI test would
 * only observe indirectly, and the ones that MUST hold no matter what an LLM
 * returns.
 */

import { describe, it, expect } from 'vitest';

import {
  buildCastIntegrityReport,
  castIntegrityPassed,
  characterCompletenessFindings,
  characterFingerprint,
  characterIntegrityDepth,
  characterIntegrityDimensions,
  mergeSemanticFindings,
  readIntegrityField,
  withIntegrityField,
} from './characterIntegrity.js';

/** A fully authored lead — nothing for the deterministic pass to report. */
const lead = () => ({
  id: 'c-lead',
  name: 'Wren Ashcombe',
  role: 'protagonist',
  motivations: 'Wants the survey contract renewed; fears being sent back inland.',
  ghost: 'Her crew drowned on a run she planned.',
  wound: 'She no longer trusts her own judgment under time pressure.',
  lie: 'If I am the one holding the chart, nobody else dies.',
  want: 'Sole command of the northern survey.',
  need: 'That shared command is not the same as being replaceable.',
  psychology: {
    theoryOfControl: 'If I carry every decision myself, the cost lands on me instead of the crew.',
    strategy: 'Takes the night watch alone and rewrites other people’s plans.',
    protectiveBenefit: 'She never has to watch somebody else make the call that kills them.',
    presentCost: 'Nobody on her crew has learned to navigate without her.',
    testingPressure: 'A run she physically cannot take herself.',
    candidateChange: 'Letting a second navigator sign the chart.',
    assessment: 'assessed',
    assessmentNote: '',
    drives: {
      survival: { desire: 'A berth that does not depend on weather luck.', fear: 'Being put ashore.' },
      connection: { desire: 'A crew that stays a full season.', fear: 'Being the reason one leaves.' },
      status: { desire: 'To be the name the harbourmaster asks for.', fear: 'Being read as lucky rather than good.' },
    },
  },
});

describe('characterIntegrityDepth', () => {
  it('holds an ordinary lead to the full framework', () => {
    expect(characterIntegrityDepth(lead())).toBe('full');
  });

  it.each([
    ['a declared minor role', { id: 'x', role: 'minor dockhand' }],
    ['a background player', { id: 'x', role: 'Background — market crowd' }],
    ['a declared flat arc', { id: 'x', role: 'protagonist', arcType: 'flat' }],
  ])('holds %s to lighter requirements', (_label, entry) => {
    expect(characterIntegrityDepth(entry)).toBe('light');
  });

  it('does not read "extra" out of a longer word', () => {
    expect(characterIntegrityDepth({ id: 'x', role: 'extraordinary envoy' })).toBe('full');
  });

  it('treats an EXPLAINED unknown as a finished assessment, not a gap', () => {
    const hive = {
      id: 'x',
      role: 'antagonist',
      psychology: { assessment: 'not-applicable', assessmentNote: 'A distributed fungal intelligence with no legible interior.' },
    };
    expect(characterIntegrityDepth(hive)).toBe('explained');
    expect(characterCompletenessFindings(hive)).toEqual([]);
    expect(characterIntegrityDimensions(hive)).toEqual([]);
  });

  it('still reports an UNEXPLAINED unknown — the note is what makes it an assessment', () => {
    const findings = characterCompletenessFindings({
      id: 'x', role: 'antagonist', psychology: { assessment: 'unknown', assessmentNote: '' },
    });
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe('characterCompletenessFindings', () => {
  it('finds nothing on a fully authored lead', () => {
    expect(characterCompletenessFindings(lead())).toEqual([]);
  });

  it('reports ONE psychology gap for an untouched character, not nine leaves', () => {
    const findings = characterCompletenessFindings({ id: 'x', name: 'Blank', role: 'protagonist' });
    const psych = findings.filter((f) => f.field.startsWith('psychology'));
    expect(psych).toHaveLength(1);
    expect(psych[0].field).toBe('psychology');
  });

  it('walks into the leaves once the profile is partly authored', () => {
    const entry = lead();
    entry.psychology.drives.status.fear = '';
    entry.psychology.theoryOfControl = '';
    const fields = characterCompletenessFindings(entry).map((f) => f.field);
    expect(fields).toContain('psychology.theoryOfControl');
    expect(fields).toContain('psychology.drives.status.fear');
    expect(fields).not.toContain('psychology.drives.survival.desire');
  });

  it('asks a light-depth character only for the conscious pursuit', () => {
    const fields = characterCompletenessFindings({ id: 'x', name: 'Dockhand', role: 'minor' }).map((f) => f.field);
    expect(fields).toEqual(['motivations', 'want']);
  });

  it('reports every finding as `missing` — it never judges populated prose', () => {
    const entry = lead();
    entry.want = 'stuff';
    expect(characterCompletenessFindings(entry)).toEqual([]);
  });
});

describe('buildCastIntegrityReport coverage', () => {
  const cast = [lead(), { id: 'c-2', name: 'Second', role: 'protagonist' }];

  it('lists out-of-scope characters as not-reviewed rather than omitting them', () => {
    const report = buildCastIntegrityReport(cast, { characterIds: ['c-lead'] });
    const second = report.coverage.find((c) => c.characterId === 'c-2');
    expect(second.status).toBe('not-reviewed');
    expect(report.castCount).toBe(2);
    expect(report.reviewedCount).toBe(1);
  });

  it('never counts a deterministic pass as a clean review', () => {
    const report = buildCastIntegrityReport([lead()]);
    expect(report.coverage[0].status).toBe('passed');
    // Blank-complete is exactly the case this issue exists for.
    expect(castIntegrityPassed(report)).toBe(false);
  });

  it('an empty cast is not a pass', () => {
    expect(castIntegrityPassed(buildCastIntegrityReport([]))).toBe(false);
  });
});

describe('mergeSemanticFindings', () => {
  const cast = [lead(), { id: 'c-2', name: 'Second', role: 'minor' }];
  const base = () => buildCastIntegrityReport(cast);

  const semantic = (over = {}) => ({
    characterId: 'c-lead',
    field: 'lie',
    kind: 'underspecified',
    dimension: 'control-predicts-behavior',
    evidence: 'The stated belief is about chart-holding, but the personality shows her delegating freely.',
    suggestion: 'Name the moment she refuses to hand over the chart.',
    ...over,
  });

  it('accepts a well-formed finding and flips the character to `findings`', () => {
    const report = mergeSemanticFindings(base(), {
      characters: cast, findings: [semantic()], reviewedIds: ['c-lead', 'c-2'],
    });
    expect(report.findings.map((f) => f.field)).toContain('lie');
    expect(report.coverage.find((c) => c.characterId === 'c-lead').status).toBe('findings');
  });

  it.each([
    ['an unknown character', { characterId: 'c-nope' }],
    ['an unknown field path', { field: 'wardrobes' }],
    ['an unknown kind', { kind: 'vibes' }],
    ['an unknown dimension', { dimension: 'made-up' }],
    ['no evidence', { evidence: '   ' }],
  ])('drops a finding naming %s', (_label, over) => {
    const report = mergeSemanticFindings(base(), {
      characters: cast, findings: [semantic(over)], reviewedIds: ['c-lead', 'c-2'],
    });
    expect(report.findings.filter((f) => f.dimension)).toEqual([]);
  });

  it('drops a dimension the character’s depth excuses', () => {
    // `c-2` is a minor role → light depth, which does not ask about origin.
    const report = mergeSemanticFindings(base(), {
      characters: cast,
      findings: [semantic({ characterId: 'c-2', field: 'ghost', dimension: 'origin-supports-control' })],
      reviewedIds: ['c-lead', 'c-2'],
    });
    expect(report.findings.some((f) => f.dimension === 'origin-supports-control')).toBe(false);
  });

  it('marks characters the batch never reached as truncated, not passed', () => {
    const report = mergeSemanticFindings(base(), {
      characters: cast, findings: [], reviewedIds: ['c-lead'], truncated: true,
    });
    expect(report.coverage.find((c) => c.characterId === 'c-2').status).toBe('truncated');
    expect(castIntegrityPassed(report)).toBe(false);
  });

  it('a fully reviewed, finding-free cast is the ONLY thing that passes', () => {
    const clean = [lead()];
    const report = mergeSemanticFindings(buildCastIntegrityReport(clean), {
      characters: clean, findings: [], reviewedIds: ['c-lead'],
    });
    expect(castIntegrityPassed(report)).toBe(true);
  });

  it('ignores findings about a character the batch did not review', () => {
    const report = mergeSemanticFindings(base(), {
      characters: cast, findings: [semantic()], reviewedIds: ['c-2'],
    });
    expect(report.findings.some((f) => f.dimension)).toBe(false);
  });

  it('keeps the deterministic finding when the model names the same field', () => {
    const blank = [{ id: 'c-3', name: 'Blank', role: 'protagonist' }];
    const report = mergeSemanticFindings(buildCastIntegrityReport(blank), {
      characters: blank,
      findings: [semantic({ characterId: 'c-3', field: 'lie', kind: 'missing', evidence: 'no lie' })],
      reviewedIds: ['c-3'],
    });
    const lieFindings = report.findings.filter((f) => f.characterId === 'c-3' && f.field === 'lie');
    expect(lieFindings).toHaveLength(1);
    expect(lieFindings[0].dimension).toBeNull();
  });
});

describe('fingerprints', () => {
  it('changes when an integrity field changes', () => {
    const before = characterFingerprint(lead());
    const after = characterFingerprint({ ...lead(), lie: 'something else' });
    expect(after).not.toBe(before);
  });

  it('changes when a psychology LEAF changes', () => {
    const entry = lead();
    const before = characterFingerprint(entry);
    entry.psychology.drives.status.fear = 'different';
    expect(characterFingerprint(entry)).not.toBe(before);
  });

  it('does NOT change on an unrelated edit — a re-render must not stale a review', () => {
    const before = characterFingerprint(lead());
    expect(characterFingerprint({ ...lead(), wardrobes: [{ name: 'coat', description: 'x' }], voiceId: 'v1' }))
      .toBe(before);
  });

  it('cannot be forged by a delimiter inside an authored field', () => {
    const a = characterFingerprint({ ...lead(), lie: 'a|b', want: 'c' });
    const b = characterFingerprint({ ...lead(), lie: 'a', want: 'b|c' });
    expect(a).not.toBe(b);
  });
});

describe('integrity field paths', () => {
  it('reads and writes a psychology drive leaf without clobbering its siblings', () => {
    const entry = lead();
    const next = withIntegrityField(entry, 'psychology.drives.status.fear', 'Being called lucky.');
    expect(readIntegrityField(next, 'psychology.drives.status.fear')).toBe('Being called lucky.');
    expect(next.psychology.drives.status.desire).toBe(entry.psychology.drives.status.desire);
    expect(next.psychology.drives.survival.fear).toBe(entry.psychology.drives.survival.fear);
    expect(next.psychology.theoryOfControl).toBe(entry.psychology.theoryOfControl);
  });

  it('materializes the psychology container on a character that has none', () => {
    const next = withIntegrityField({ id: 'x' }, 'psychology.theoryOfControl', 'rule');
    expect(next.psychology.theoryOfControl).toBe('rule');
  });

  it('refuses a path outside the contract rather than writing it', () => {
    const entry = { id: 'x' };
    expect(withIntegrityField(entry, 'physicalDescription', 'nope')).toBe(entry);
    expect(readIntegrityField({ physicalDescription: 'a' }, 'physicalDescription')).toBe('');
  });
});
