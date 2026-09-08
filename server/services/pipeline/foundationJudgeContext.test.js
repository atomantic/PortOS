import { describe, it, expect } from 'vitest';

import { buildCastIntegrityReport } from '../../lib/characterIntegrity.js';
import {
  buildFoundationContext,
  countFoundationCharacterBlanks,
  countSeriesCastIntegrityFindings,
  foundationInputsHash,
  pickFrameworkFields,
  renderCastIntegrity,
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

// The Series surface of the shared cast-integrity contract (#6415). The judge
// used to hold every series-linked character to one field list, so a declared
// minor role and an author-explained unknown both scored as incomplete leads,
// and the foundation loop's only objective progress measure could not see the
// psychology profile at all.
describe('foundationJudgeContext — cast integrity (#6415)', () => {
  const series = { id: 'ser-2', name: 'Example Series', premise: 'A salvage crew.' };
  // Fully populated framework + psychology, and mutually contradictory: the
  // control belief promises retreat while the want is a public confrontation.
  // Nothing is blank, so no blank count can report it.
  const filledButIncoherent = {
    id: 'chr-lead', name: 'Ada Vance', role: 'protagonist',
    motivations: 'Keep the crew solvent.', ghost: 'Lost the Kesh run.',
    wound: 'Blamed for a wreck she did not cause.', lie: 'I only matter if I win.',
    want: 'To face the board in open session.', need: 'To be kept without winning.',
    psychology: {
      theoryOfControl: 'If nobody looks at me, nothing can be taken.',
      strategy: 'Withdraws before any hearing.',
      protectiveBenefit: 'Never tests whether she would be believed.',
      presentCost: 'A claim that lapses every cycle.',
      drives: {
        survival: { desire: 'a berth', fear: 'the dock' },
        connection: { desire: 'to be kept', fear: 'replacement' },
        status: { desire: 'to be counted on', fear: 'surplus' },
      },
    },
  };
  const minor = { id: 'chr-minor', name: 'Dock Clerk', role: 'minor', motivations: 'Close out the shift.', want: 'A quiet gate.' };
  const explained = {
    id: 'chr-oracle',
    name: 'The Oracle',
    role: 'antagonist',
    psychology: { assessment: 'unknown', assessmentNote: 'Read only through its effects; never given an interior.' },
  };
  const cast = [filledButIncoherent, minor, explained];
  const universe = { id: 'uni-2', name: 'Example Universe', characters: cast };
  const context = () => buildFoundationContext({
    series, universe, canon: { characters: cast }, issues: [], contentMax: 60_000,
  });

  it('reports zero deterministic gaps for a lighter role and an explained unknown', () => {
    // Neither owes the story an origin-damage chain, so neither may be counted
    // as work a character repair still has to do.
    expect(countSeriesCastIntegrityFindings([minor, explained], series)).toBe(0);
    // The same roster held to the old uniform standard is nowhere near clean —
    // that gap is exactly what the depth ruling exists to explain.
    expect(countFoundationCharacterBlanks([minor, explained], series)).toBeGreaterThan(0);
  });

  it('counts the psychology profile no blank-field set reaches', () => {
    const unassessedLead = { ...filledButIncoherent, psychology: undefined };
    // Blank-counting sees no difference: `psychology` is in none of the
    // framework/profile/visual field lists.
    expect(countFoundationCharacterBlanks([unassessedLead], series))
      .toBe(countFoundationCharacterBlanks([filledButIncoherent], series));
    // The integrity count does, which is what lets the foundation loop accept a
    // repair that authored a control belief and its drives.
    expect(countSeriesCastIntegrityFindings([unassessedLead], series))
      .toBeGreaterThan(countSeriesCastIntegrityFindings([filledButIncoherent], series));
  });

  it('hands the judge a binding depth ruling for every series character', () => {
    const { castIntegrity } = context();
    expect(castIntegrity).toContain('Ada Vance');
    expect(castIntegrity).toContain('[full]');
    expect(castIntegrity).toContain('Dock Clerk');
    expect(castIntegrity).toContain('[light]');
    expect(castIntegrity).toContain('The Oracle');
    expect(castIntegrity).toContain('[explained]');
    // A populated-but-incoherent lead has nothing blank, so the deterministic
    // pass must NOT invent a gap for it — the semantic judgement is the judge's
    // job, and the prompt asks for it.
    expect(castIntegrity).toContain('**Ada Vance** [full] — no gaps');
  });

  it('never lets a truncated block read as a clean cast', () => {
    // The header survives any budget; dropped rows are named rather than
    // silently absent, so "no gaps listed" can never mean "nothing was checked".
    const report = buildCastIntegrityReport(cast);
    const tight = renderCastIntegrity(report, { maxChars: 200 });
    expect(tight).toContain('Deterministic pass (no model call) over 3 series-linked characters');
    expect(tight).toMatch(/\[\d+ clean cast-integrity lines? omitted/);
  });
});
