import { describe, it, expect } from 'vitest';

import {
  foundationInputsHash,
  pickFrameworkFields,
  renderCharacterLine,
} from './foundationJudgeContext.js';

// The optional psychology profile (#6414) has to be invisible until an author
// actually writes one. Two things break loudly if it isn't: every existing
// install's foundation score is invalidated by a hash that gained an empty
// object, and every judge prompt grows a line of "unassessed" noise per cast
// member inside a budget this module works hard to hold.
describe('foundationJudgeContext — optional psychology profile (#6414)', () => {
  const legacyCharacter = {
    id: 'chr-1', name: 'Nera Vost', role: 'lead',
    ghost: 'Left behind on the Kesh run.', lie: 'I only matter if I win.',
  };
  const assessed = {
    ...legacyCharacter,
    psychology: {
      theoryOfControl: 'If I stay useful, nobody leaves.',
      strategy: "Absorbs everyone else's work.",
      protectiveBenefit: 'Never tests whether she would be kept anyway.',
      presentCost: 'A crew that never learns to carry itself.',
      drives: {
        survival: { desire: 'a berth she cannot be put out of', fear: 'being turned out' },
        connection: { desire: 'to be kept', fear: 'being easy to replace' },
        status: { desire: 'to be counted on', fear: 'being read as surplus' },
      },
    },
  };
  const series = { id: 'ser-1', name: 'Example Series', premise: 'A salvage crew.' };
  const universe = { id: 'uni-1', name: 'Example Universe', characters: [legacyCharacter] };

  it('leaves an unassessed character out of the projection and its hash', () => {
    expect(pickFrameworkFields(legacyCharacter)).not.toHaveProperty('psychology');
    // Byte-for-byte the same input hash as before the field existed, so an
    // upgrade does not invalidate a score nobody's data changed.
    expect(foundationInputsHash(series, universe))
      .toBe(foundationInputsHash(series, { ...universe, characters: [{ ...legacyCharacter }] }));
  });

  it('projects the profile — and moves the hash — once one is authored', () => {
    expect(pickFrameworkFields(assessed).psychology.drives.status.fear).toBe('being read as surplus');
    expect(foundationInputsHash(series, { ...universe, characters: [assessed] }))
      .not.toBe(foundationInputsHash(series, universe));
  });

  it('adds the control clause to the roster line only for an assessed character', () => {
    expect(renderCharacterLine(legacyCharacter)).not.toMatch(/control:/);
    const line = renderCharacterLine(assessed);
    expect(line).toMatch(/control: theory: If I stay useful, nobody leaves\./);
    expect(line).toMatch(/status desire: to be counted on, fear: being read as surplus/);
  });

  it('renders an explicit unknown ruling instead of an invented interior', () => {
    const line = renderCharacterLine({
      ...legacyCharacter,
      psychology: { assessment: 'not-applicable', assessmentNote: 'A swarm with no single interior.' },
    });
    expect(line).toMatch(/assessment: not-applicable \(A swarm with no single interior\.\)/);
    expect(line).toMatch(/theory: —/);
  });
});
