/**
 * The author-side review projection (#6417). These are the cases an
 * integration test through `evaluator.js` cannot pin cheaply, because they all
 * turn on the difference between ABSENT and INTENTIONALLY EMPTY:
 *
 *   - an unrated slider axis is `null`, never a low rating;
 *   - an unassessed psychology profile is absent, and a RULED-OUT one is a
 *     real authored decision that must survive with no prose behind it;
 *   - the sanitizer materializes all three drive axes even when one leaf is
 *     filled, so blank axes must not ride into the prompt as empty husks.
 *
 * A projection that got any of those backwards would hand the editorial pass
 * either a page of empty keys or a deliberate decision dressed as a gap.
 */
import { describe, it, expect } from 'vitest';
import { pickCharacterFramework, pickCastFramework } from './characterFramework.js';

const ASSESSED = Object.freeze({
  theoryOfControl: 'If I stay useful, nobody leaves.',
  strategy: 'Takes every shift nobody else wants.',
  protectiveBenefit: '',
  presentCost: '',
  testingPressure: '',
  candidateChange: '',
  assessment: 'assessed',
  assessmentNote: '',
  drives: {
    survival: { desire: '', fear: '' },
    connection: { desire: 'to be kept', fear: '' },
    status: { desire: '', fear: '' },
  },
});

describe('pickCharacterFramework — psychology', () => {
  it('carries the authored leaves and drops the blank ones', () => {
    const out = pickCharacterFramework({ name: 'Wren Calloway', psychology: ASSESSED });
    expect(out.psychology).toEqual({
      theoryOfControl: 'If I stay useful, nobody leaves.',
      strategy: 'Takes every shift nobody else wants.',
      assessment: 'assessed',
      drives: { connection: { desire: 'to be kept' } },
    });
  });

  it('carries a ruled-out assessment and its note as a real assessment', () => {
    const out = pickCharacterFramework({
      name: 'The Tidewall',
      psychology: {
        assessment: 'not-applicable',
        assessmentNote: 'A weather front. It has no interior to read.',
        theoryOfControl: '',
        drives: { survival: { desire: '', fear: '' } },
      },
    });
    expect(out.psychology).toEqual({
      assessment: 'not-applicable',
      assessmentNote: 'A weather front. It has no interior to read.',
    });
  });

  it('omits an unassessed or all-blank profile entirely', () => {
    const blank = {
      theoryOfControl: '', strategy: '', assessment: null, assessmentNote: '',
      drives: { survival: { desire: '', fear: '' } },
    };
    expect(pickCharacterFramework({ name: 'Wren', lie: 'I only matter while useful.', psychology: blank }).psychology)
      .toBeUndefined();
    expect(pickCharacterFramework({ name: 'Wren', lie: 'I only matter while useful.' }).psychology)
      .toBeUndefined();
  });

  it('ignores an assessment value the editor never offers', () => {
    const out = pickCharacterFramework({
      name: 'Wren',
      psychology: { assessment: 'pending', strategy: 'Deflects.' },
    });
    expect(out.psychology).toEqual({ strategy: 'Deflects.' });
  });
});

describe('pickCharacterFramework — sliders', () => {
  it('carries rated axes and drops unrated ones', () => {
    const out = pickCharacterFramework({
      name: 'Wren',
      sliders: { proactivity: 8, likability: null, competence: 7 },
    });
    expect(out.sliders).toEqual({ proactivity: 8, competence: 7 });
  });

  it('omits the block when no axis is rated', () => {
    const out = pickCharacterFramework({
      name: 'Wren',
      lie: 'I only matter while useful.',
      sliders: { proactivity: null, likability: null, competence: null },
    });
    expect(out.sliders).toBeUndefined();
  });

  it('keeps a deliberate low rating', () => {
    expect(pickCharacterFramework({ name: 'Wren', sliders: { likability: 1 } }).sliders)
      .toEqual({ likability: 1 });
  });
});

describe('pickCastFramework', () => {
  it('drops a character whose only framework content is an empty profile', () => {
    const cast = pickCastFramework([
      { name: 'Wren', psychology: { drives: { survival: { desire: '', fear: '' } } }, sliders: { proactivity: null } },
      { name: 'Nils', sliders: { competence: 9 } },
    ]);
    expect(cast).toEqual([{ name: 'Nils', sliders: { competence: 9 } }]);
  });
});
