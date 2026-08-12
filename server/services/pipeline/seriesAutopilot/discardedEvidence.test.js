import { describe, it, expect } from 'vitest';
import { createDiscardedBank, boundDiscarded } from './discardedEvidence.js';
import { AUTOPILOT_DISCARDED_MAX } from '../series.js';

const finding = (problem, location = 'volume 1') => ({ severity: 'high', location, problem });

const FIRST = finding('The mentor subplot vanishes entirely after the second issue.');
const SECOND = finding('The finale resolves offstage inside a single unread letter.');
const THIRD = finding('The visitor has no defined body scale or metabolic support needs.');

describe('createDiscardedBank (#3835)', () => {
  it('accumulates every discarded set, newest first, instead of the last one', () => {
    const bank = createDiscardedBank();
    bank.record([FIRST]);
    bank.record([SECOND]);
    expect(bank.history().map((f) => f.problem)).toEqual([SECOND.problem, FIRST.problem]);
  });

  it('does not re-bank a paraphrase of something it already holds', () => {
    const bank = createDiscardedBank();
    bank.record([FIRST]);
    bank.record([{ ...FIRST, problem: 'the mentor subplot vanishes after the second issue entirely' }]);
    expect(bank.history()).toHaveLength(1);
  });

  it('promotes a re-discarded candidate to the front instead of leaving it below the bound', () => {
    const bank = createDiscardedBank();
    bank.record([FIRST]);
    for (let i = 0; i < AUTOPILOT_DISCARDED_MAX; i += 1) {
      bank.record([finding(`alpha${i} beta${i} gamma${i} delta${i}`, `volume ${i}`)]);
    }
    // FIRST has been pushed past the cap. Discarding it AGAIN is the newest
    // evidence there is — it must reach the very next prompt, not stay trimmed.
    bank.record([FIRST]);
    expect(bank.history()[0].problem).toBe(FIRST.problem);
    expect(bank.history().filter((f) => f.problem === FIRST.problem)).toHaveLength(1);
  });

  it('keeps each key\'s history separate', () => {
    const bank = createDiscardedBank();
    bank.record([FIRST], 'character');
    bank.record([SECOND], 'structure');
    expect(bank.history('character').map((f) => f.problem)).toEqual([FIRST.problem]);
    expect(bank.history('structure').map((f) => f.problem)).toEqual([SECOND.problem]);
    expect(bank.byKey()).toEqual({ character: [FIRST], structure: [SECOND] });
  });

  it('avoid() leads with the call\'s own set, then the carried history, and banks both', () => {
    const bank = createDiscardedBank();
    bank.record([FIRST]);
    expect(bank.avoid([SECOND]).map((f) => f.problem)).toEqual([SECOND.problem, FIRST.problem]);
    expect(bank.history().map((f) => f.problem)).toEqual([SECOND.problem, FIRST.problem]);
  });

  it('avoid() drops carried evidence that is now an active repair target', () => {
    const bank = createDiscardedBank();
    bank.record([FIRST]);
    bank.record([SECOND]);
    // Telling the repairer both "fix this" and "never author this" is contradictory.
    expect(bank.avoid([], [FIRST]).map((f) => f.problem)).toEqual([SECOND.problem]);
    // Filtering the PROMPT does not forget it — a later call still avoids it.
    expect(bank.history().map((f) => f.problem)).toEqual([SECOND.problem, FIRST.problem]);
  });

  it('seeds from a flat prior and re-emits it, so a second pause keeps the first run\'s evidence', () => {
    const bank = createDiscardedBank([FIRST]);
    bank.record([SECOND]);
    expect(bank.all().map((f) => f.problem)).toEqual([SECOND.problem, FIRST.problem]);
  });

  it('seeds from a keyed prior', () => {
    const bank = createDiscardedBank({ character: [FIRST] });
    bank.record([SECOND], 'character');
    bank.record([THIRD], 'craft');
    expect(bank.byKey().character.map((f) => f.problem)).toEqual([SECOND.problem, FIRST.problem]);
    expect(bank.byKey().craft.map((f) => f.problem)).toEqual([THIRD.problem]);
  });

  it('bounds each key at the marker\'s cap, keeping the newest', () => {
    const bank = createDiscardedBank();
    // Wholly disjoint wording per entry — `sameFinding` is deliberately loose
    // about phrasing, so a shared sentence frame would read as one repeat.
    const distinct = (i) => finding(`alpha${i} beta${i} gamma${i} delta${i}`, `volume ${i}`);
    for (let i = 0; i < AUTOPILOT_DISCARDED_MAX + 5; i += 1) bank.record([distinct(i)]);
    const history = bank.history();
    expect(history).toHaveLength(AUTOPILOT_DISCARDED_MAX);
    expect(history[0].problem).toBe(distinct(AUTOPILOT_DISCARDED_MAX + 4).problem);
  });

  it('byKey() drops keys that banked nothing', () => {
    const bank = createDiscardedBank();
    bank.record([], 'character');
    expect(bank.byKey()).toEqual({});
  });

  it('boundDiscarded tolerates a non-array', () => {
    expect(boundDiscarded(null)).toEqual([]);
  });
});
