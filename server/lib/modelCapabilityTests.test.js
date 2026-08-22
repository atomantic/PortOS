import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_TESTS,
  HEROS_JOURNEY_BEATS,
  VISION_FIXTURE_KEYWORDS,
  applicabilityFor,
  applicableTests,
  findKeyword,
  getCapabilityTest,
  rollUpVerdict,
  scoreKeywords,
  scoreSandboxRepair,
  scoreStoryBeats,
} from './modelCapabilityTests.js';

const visionTest = getCapabilityTest('image-analysis');
const sandboxTest = getCapabilityTest('sandbox-repair');

describe('applicabilityFor', () => {
  it('applies a test only where the model claims the capability', () => {
    expect(applicabilityFor(visionTest, ['chat', 'vision']).state).toBe('applicable');
  });

  it('reports an unclaimed capability as not-applicable, never as a failure', () => {
    const result = applicabilityFor(visionTest, ['chat', 'tools']);
    expect(result.state).toBe('not-applicable');
    expect(result.missing).toEqual(['vision']);
    expect(result.reason).toContain('vision');
  });

  it('separates "the runtime said nothing" from "the model claims nothing"', () => {
    // `null` — a bare endpoint that reports ids only. The claim is unverified,
    // so the test stays on offer rather than being hidden.
    expect(applicabilityFor(visionTest, null).state).toBe('unknown');
    // `[]` — a runtime that answered. That IS an answer: no vision badge.
    expect(applicabilityFor(visionTest, []).state).toBe('not-applicable');
  });

  it('never lets a preferred-but-missing capability block a test', () => {
    // sandbox-repair requires `tools` and merely prefers `code`.
    expect(sandboxTest.prefers).toContain('code');
    expect(applicabilityFor(sandboxTest, ['chat', 'tools']).state).toBe('applicable');
  });

  it('covers every shipped test for one model', () => {
    expect(applicableTests(['chat', 'tools', 'vision']).map((t) => t.state))
      .toEqual(CAPABILITY_TESTS.map(() => 'applicable'));
  });
});

describe('scoreKeywords', () => {
  const answer = 'A red bicycle leans by a blue bench. A dog sits under it, beside a lit street lamp, and the sign reads 3.';

  it('passes when every required term is present and counts the bonus separately', () => {
    const scored = scoreKeywords(answer, VISION_FIXTURE_KEYWORDS);
    expect(scored.verdict).toBe('passed');
    expect(scored.requiredHit).toBe(scored.requiredTotal);
    expect(scored.bonusHit).toBe(scored.bonusTotal);
  });

  it('still passes when only bonus terms are missed — bonus can never fail a run', () => {
    const scored = scoreKeywords('A bicycle, a bench, a dog and a lamp.', VISION_FIXTURE_KEYWORDS);
    expect(scored.verdict).toBe('passed');
    expect(scored.bonusHit).toBe(0);
    expect(scored.summary).toContain('0 of 3 bonus');
  });

  it('fails once most required terms are missing', () => {
    expect(scoreKeywords('Some kind of outdoor scene at night.', VISION_FIXTURE_KEYWORDS).verdict).toBe('failed');
  });

  it('does not credit a negated mention', () => {
    expect(findKeyword('There is no dog in the picture.', { any: ['dog'] }).hit).toBe(false);
    expect(findKeyword('A dog sits there.', { any: ['dog'] }).hit).toBe(true);
  });

  it('matches on word boundaries, so a substring is not a hit', () => {
    expect(findKeyword('A bikeshed stands there.', { any: ['bike'] }).hit).toBe(false);
    expect(findKeyword('rendered at 1024x300', { any: ['3'] }).hit).toBe(false);
    expect(findKeyword('the sign shows a 3', { any: ['3'] }).hit).toBe(true);
  });

  it('tolerates a phrase broken across a wrapped line', () => {
    expect(findKeyword('beside a lamp\n   post at the kerb', { any: ['lamp post'] }).hit).toBe(true);
  });
});

describe('scoreStoryBeats', () => {
  const outline = HEROS_JOURNEY_BEATS.map((b, i) => `${i + 1}. ${b.label}\nSomething happens.`).join('\n\n');

  it('passes a complete, in-order outline', () => {
    const scored = scoreStoryBeats(outline);
    expect(scored.verdict).toBe('passed');
    expect(scored.found).toBe(HEROS_JOURNEY_BEATS.length);
    expect(scored.inOrder).toBe(true);
  });

  it('reports a short outline as partial rather than failed', () => {
    const short = HEROS_JOURNEY_BEATS.slice(0, 9).map((b) => b.label).join('\n');
    const scored = scoreStoryBeats(short);
    expect(scored.verdict).toBe('partial');
    expect(scored.found).toBe(9);
  });

  it('judges ordering only over the beats that are present', () => {
    // Beat 3 missing, everything else in sequence: short one beat, not jumbled.
    const gapped = HEROS_JOURNEY_BEATS.filter((b) => b.id !== 'refusal').map((b) => b.label).join('\n');
    expect(scoreStoryBeats(gapped).inOrder).toBe(true);
  });

  it('flags a genuinely reordered outline', () => {
    const reversed = [...HEROS_JOURNEY_BEATS].reverse().map((b) => b.label).join('\n');
    const scored = scoreStoryBeats(reversed);
    expect(scored.inOrder).toBe(false);
    expect(scored.summary).toContain('out of order');
  });

  it('marks each beat found or missing by id', () => {
    const scored = scoreStoryBeats('Ordinary world. Then the ordeal.');
    expect(scored.beats.find((b) => b.id === 'ordinary-world').hit).toBe(true);
    expect(scored.beats.find((b) => b.id === 'elixir').hit).toBe(false);
    // A miss records no position — never -1, which would sort ahead of a real one.
    expect(scored.beats.find((b) => b.id === 'elixir').at).toBeNull();
  });
});

describe('scoreSandboxRepair', () => {
  it('passes only when the test command actually exits 0', () => {
    expect(scoreSandboxRepair({ moduleChanged: true, fixturesIntact: true, testsPass: true, toolCalls: 3 }).verdict).toBe('passed');
  });

  it('fails a model that edited the test instead of the module, even when tests pass', () => {
    const scored = scoreSandboxRepair({ moduleChanged: true, fixturesIntact: false, testsPass: true, toolCalls: 4 });
    expect(scored.verdict).toBe('failed');
    expect(scored.summary).toContain('edited the test');
  });

  it('records a written-but-still-failing attempt as partial', () => {
    expect(scoreSandboxRepair({ moduleChanged: true, fixturesIntact: true, testsPass: false }).verdict).toBe('partial');
  });

  it('fails a model that never wrote anything', () => {
    const scored = scoreSandboxRepair({ moduleChanged: false, fixturesIntact: true, testsPass: false });
    expect(scored.verdict).toBe('failed');
    expect(scored.summary).toContain('never wrote a fix');
  });
});

describe('rollUpVerdict', () => {
  it('takes the worst verdict recorded', () => {
    expect(rollUpVerdict(['passed', 'partial', 'failed'])).toBe('failed');
    expect(rollUpVerdict(['passed', 'partial'])).toBe('partial');
    expect(rollUpVerdict(['passed', 'passed'])).toBe('passed');
  });

  it('is null when nothing has been run — never "passed" by default', () => {
    expect(rollUpVerdict([])).toBeNull();
    expect(rollUpVerdict([undefined, null])).toBeNull();
  });
});

