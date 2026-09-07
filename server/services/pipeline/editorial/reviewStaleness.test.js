/**
 * Source fingerprinting for the five-stage evolution lens (#6442).
 *
 * The lens gets its OWN token (`series.characterArcs.evolution`) rather than
 * riding the broad `series.characterArcs` one, because `character.secondary-arc`
 * and `arc.climax-agency` read the lens but not the want/need/start/end model.
 * These cases pin both halves of that choice: a lens edit must stale every
 * check that reads it, and a want edit must NOT stale the two that never see it.
 */
import { describe, it, expect } from 'vitest';

import { getCheck } from '../../../lib/editorial/index.js';
import { buildEditorialSourceProjection, fingerprintForCheck } from './reviewStaleness.js';

const LENS_ONLY_CHECKS = ['character.secondary-arc', 'arc.climax-agency'];
const ARC_MODEL_CHECKS = ['character.consistency', 'arc.transitions', 'arc.regression'];

const project = (characterArcs) => buildEditorialSourceProjection({
  manuscript: '# Issue 1\n\nMara struck the match.',
  canon: null,
  series: { characterArcs },
  issues: [],
  outline: null,
  editorial: null,
  bible: null,
}).resolvedSources;

const arc = ({ want = 'revenge', outcome = 'full-change' } = {}) => ([{
  characterId: 'chr-mara',
  characterName: 'Mara',
  want,
  transitions: [{ id: 'trn-burn', kind: 'decision', label: 'burns the bridge' }],
  evolution: {
    outcome,
    outcomeNote: '',
    stages: [{
      stageId: 'final-proof',
      testedBelief: '',
      externalPressure: '',
      characterChoice: 'stays',
      causalConsequence: '',
      evidence: null,
    }],
  },
}]);

const fingerprint = (id, arcs) => fingerprintForCheck(getCheck(id), project(arcs));

describe('editorial source fingerprints — character evolution lens', () => {
  it.each([...LENS_ONLY_CHECKS, ...ARC_MODEL_CHECKS])(
    '%s goes stale when the declared outcome changes',
    (id) => {
      expect(fingerprint(id, arc({ outcome: 'full-change' })))
        .not.toBe(fingerprint(id, arc({ outcome: 'tragic-refusal' })));
    },
  );

  it.each(LENS_ONLY_CHECKS)('%s stays fresh when only the want/need model is edited', (id) => {
    // Without the narrow token these two would have to declare the whole
    // `series.characterArcs` source and would re-run on an edit they cannot see.
    expect(fingerprint(id, arc({ want: 'revenge' })))
      .toBe(fingerprint(id, arc({ want: 'peace' })));
  });

  it.each(ARC_MODEL_CHECKS)('%s still goes stale when the want/need model is edited', (id) => {
    expect(fingerprint(id, arc({ want: 'revenge' })))
      .not.toBe(fingerprint(id, arc({ want: 'peace' })));
  });

  it.each([...LENS_ONLY_CHECKS, ...ARC_MODEL_CHECKS])(
    '%s separates a legacy arc with no lens from the same arc once one is authored',
    (id) => {
      // Absent must not hash the same as authored — otherwise a series that just
      // opted into the lens would keep serving findings made without it.
      const [withLens] = arc();
      const { evolution: _dropped, ...withoutLens } = withLens;
      expect(fingerprint(id, [withoutLens])).not.toBe(fingerprint(id, [withLens]));
    },
  );
});
