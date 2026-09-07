/**
 * The CHARACTER-FIRST ARC CONSTRAINT block composes into both planning passes
 * (`buildArcBaseContext` / `buildArcOverviewContext`), so the evolution lens
 * (#6442) is threaded once here rather than at each call site.
 */
import { describe, it, expect } from 'vitest';

import { appendCharacterFirstArcGuidance } from './context.js';

const SHAPE = 'SHAPE GUIDANCE';
const FOUNDATION = 'Mara — theory of control: force keeps her safe';

const arc = (evolution) => ({
  characterId: 'chr-mara',
  characterName: 'Mara',
  want: 'revenge',
  ...(evolution ? { evolution } : {}),
});

describe('appendCharacterFirstArcGuidance — evolution lens', () => {
  it('is byte-identical to the pre-lens block when no arc carries one', () => {
    const withoutLens = appendCharacterFirstArcGuidance(SHAPE, FOUNDATION, [arc()]);
    expect(withoutLens).toContain('Provisional whole-series character arcs:');
    expect(withoutLens).not.toContain('Authored character evolution');
    // The planner must also stay unchanged for a series with no arcs at all.
    expect(appendCharacterFirstArcGuidance(SHAPE, FOUNDATION, undefined))
      .not.toContain('Provisional whole-series character arcs:');
  });

  it('carries the declared outcome and stages alongside the authored arcs', () => {
    const block = appendCharacterFirstArcGuidance(SHAPE, FOUNDATION, [arc({
      outcome: 'partial-open',
      outcomeNote: '',
      stages: [{
        stageId: 'commitment-to-change',
        testedBelief: '',
        externalPressure: '',
        characterChoice: 'lets the feud die',
        causalConsequence: '',
        evidence: null,
      }],
    })]);
    // Planning TOWARD the authored chain is the point — an arc pass that cannot
    // see it invents a second one the editorial checks then flag.
    expect(block).toContain('Authored character evolution (five-stage lens');
    expect(block).toContain('declared outcome: partial-open');
    expect(block).toContain('commitment to change: choice: lets the feud die');
    // The lens follows the arcs section rather than replacing it.
    expect(block.indexOf('Provisional whole-series character arcs:'))
      .toBeLessThan(block.indexOf('Authored character evolution'));
  });

  it('stays a no-op without character foundation text', () => {
    expect(appendCharacterFirstArcGuidance(SHAPE, '', [arc({ outcome: 'full-change', stages: [] })])).toBe(SHAPE);
  });
});
