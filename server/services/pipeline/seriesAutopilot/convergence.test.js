import { describe, it, expect } from 'vitest';
import {
  DIVERGENCE_PATIENCE, findingTextOverlap, isBlockingSetRegression, isIsolatedFixSafe,
  isResolveRegression, isTargetedPatchRegression, sameFinding, trackConvergence,
} from './convergence.js';

describe('trackConvergence (pure divergence/oscillation guard — #1571)', () => {
  // Fold a sequence of per-round blocking counts into the final tracker state.
  const fold = (counts) => counts.reduce(trackConvergence, { best: null, sinceBest: 0 });

  it('seeds best on the first measured round (nothing to compare yet)', () => {
    expect(trackConvergence({ best: null, sinceBest: 0 }, 5)).toEqual({ best: 5, sinceBest: 0 });
  });

  it('resets sinceBest on a new low (a profitable resolve pass)', () => {
    expect(trackConvergence({ best: 5, sinceBest: 1 }, 3)).toEqual({ best: 3, sinceBest: 0 });
  });

  it('accrues sinceBest on a stall (equal to the best)', () => {
    expect(trackConvergence({ best: 4, sinceBest: 0 }, 4)).toEqual({ best: 4, sinceBest: 1 });
  });

  it('accrues sinceBest on a regression (a fix introduced a new blocker)', () => {
    expect(trackConvergence({ best: 2, sinceBest: 0 }, 5)).toEqual({ best: 2, sinceBest: 1 });
  });

  it('a strictly-decreasing run never diverges', () => {
    expect(fold([4, 3, 2, 1]).sinceBest).toBeLessThan(DIVERGENCE_PATIENCE);
  });

  it('a flat stall reaches the patience threshold after two non-improving rounds', () => {
    // round 1 seeds best=3; rounds 2 + 3 don't improve → sinceBest hits patience.
    expect(fold([3, 3]).sinceBest).toBeLessThan(DIVERGENCE_PATIENCE);
    expect(fold([3, 3, 3]).sinceBest).toBeGreaterThanOrEqual(DIVERGENCE_PATIENCE);
  });

  it('catches a 2-cycle oscillation a naive prev-round check would miss (#1571)', () => {
    // 5→4→5→4: after round 2 sets best=4, no later round beats it, so sinceBest
    // climbs past patience even though every other round "decreases" vs the prior.
    expect(fold([5, 4, 5, 4]).sinceBest).toBeGreaterThanOrEqual(DIVERGENCE_PATIENCE);
  });
});

describe('isIsolatedFixSafe (pure per-finding patch acceptance, #3780)', () => {
  const f = (problem, location = 'V1', severity = 'high') => ({ severity, location, problem });
  const target = f('volume 1 and volume 2 both stage the first eclipse');
  const other = f('mentor subplot never pays off', 'V3');

  it('keeps a patch that closed its target and left the rest alone', () => {
    expect(isIsolatedFixSafe(target, [target, other], [other])).toBe(true);
  });

  it('keeps an even trade — the target gone, one equally-severe finding in its place', () => {
    // Same shape the round loop's checkpoint already accepts: a tie can be real
    // causal progress, and the divergence guard catches a gate that only trades.
    expect(isIsolatedFixSafe(target, [target, other], [other, f('finale hook is unresolved', 'V4')])).toBe(true);
  });

  it('rejects a patch that only RE-WORDED its target', () => {
    // The verifier restates a standing defect freely; treating fresh prose as
    // closure would bank a patch that fixed nothing and keep its collateral.
    expect(isIsolatedFixSafe(target, [target, other], [
      f('the first eclipse is staged twice — once in each opening volume', 'Volume 2 opening'),
    ])).toBe(false);
  });

  it('rejects a patch that grew the blocking set', () => {
    expect(isIsolatedFixSafe(target, [target, other], [
      other, f('finale hook is unresolved', 'V4'), f('timeline of the siege runs backwards', 'V6'),
    ])).toBe(false);
  });

  it('rejects a same-size swap that made the set MORE severe', () => {
    // Count alone can't see this one: a `medium` traded for a `high` is a worse
    // draft at the same size. Judged by the SAME `isBlockingSetRegression` the
    // whole-round rollback guard uses, so a trade the round tier would revert is
    // never banked by the isolation tier instead.
    const mediumTarget = f('volume 1 and volume 2 both stage the first eclipse', 'V1', 'medium');
    expect(isIsolatedFixSafe(
      mediumTarget,
      [mediumTarget, f('pacing sags mid-volume', 'V2', 'medium')],
      [f('pacing sags mid-volume', 'V2', 'medium'), f('protagonist goal vanishes', 'V5', 'high')],
    )).toBe(false);
  });

  it('keeps a same-size swap that made the set LESS severe', () => {
    // The mirror of the case above — trading a `high` down to a `medium` at an
    // unchanged count is progress, not a regression.
    expect(isIsolatedFixSafe(
      target,
      [target, other],
      [other, f('pacing sags mid-volume', 'V2', 'medium')],
    )).toBe(true);
  });

  it('tolerates missing/garbage inputs', () => {
    expect(isIsolatedFixSafe(target, undefined, undefined)).toBe(true);
    expect(isIsolatedFixSafe(target, null, [target])).toBe(false);
  });
});

describe('isResolveRegression (pure resolve-round damage check)', () => {
  const f = (problem, location = 'V1', severity = 'high') => ({ severity, location, problem });

  it('flags a round that grew the blocking set while leaving what it targeted standing', () => {
    // The observed shape: one finding in, three out, the original still there.
    expect(isResolveRegression([f('both volumes stage the first eclipse')], [
      f('both volumes stage the first eclipse'),
      f('volume 3 drops the mentor subplot', 'V3'),
      f('finale hook never pays off', 'V4'),
    ])).toBe(true);
  });

  it('lets a round stand when it closed everything it targeted, even if latent findings surfaced', () => {
    // Growth alone is not damage — this round did its job and exposed work that
    // was already there. The divergence guard picks it up if the loop stalls.
    expect(isResolveRegression([f('both volumes stage the first eclipse')], [
      f('volume 3 drops the mentor subplot', 'V3'),
      f('finale hook never pays off', 'V4'),
    ])).toBe(false);
  });

  it('never flags a round that held the line or improved', () => {
    const before = [f('a'), f('b', 'V2')];
    expect(isResolveRegression(before, before)).toBe(false);          // stalled → divergence guard's job
    expect(isResolveRegression(before, [f('a')])).toBe(false);        // improved
    expect(isResolveRegression(before, [])).toBe(false);              // cleared
  });

  it('tolerates missing/garbage inputs', () => {
    expect(isResolveRegression(undefined, undefined)).toBe(false);
    expect(isResolveRegression(null, [f('a')])).toBe(false);
  });

  it('still flags the regression when the verifier PARAPHRASES the finding it left standing', () => {
    // The failure mode that let the observed 1 → 3 → 5 divergence through: the
    // second verify call restates the same defect in its own words and at a
    // re-labelled location. A prose fingerprint reads that as a brand-new
    // finding, concludes the round closed what it targeted, and commits the
    // damage. Identity has to survive the re-wording.
    expect(isResolveRegression(
      [f('volume 1 and volume 2 both stage the first eclipse', 'Volume 1 → Volume 2')],
      [
        f('the eclipse is presented as a first-time event in two separate volumes', 'Volume 2 opening'),
        f('mentor subplot never pays off', 'V3'),
        f('finale hook is unresolved', 'V4'),
      ],
    )).toBe(true);
  });

  it('matches a restatement that only re-words the OPENING clause', () => {
    // The narrow shape a leading-prefix fingerprint misses: same defect, same
    // place, but the verifier opens the sentence differently on the second call.
    expect(sameFinding(
      f('the mentor subplot introduced in the opening never pays off', 'V3'),
      f('nothing ever pays off the mentor subplot introduced in the opening', 'V3'),
    )).toBe(true);
  });

  it('matches a re-punctuated, re-cased, re-pluralized restatement', () => {
    expect(sameFinding(
      { severity: 'high', location: 'V1', problem: 'Both volumes stage the first eclipse.' },
      { severity: 'medium', location: 'v1', problem: 'both   volume stages the first eclipse' },
    )).toBe(true);
  });

  it('does not fuse two findings that merely share the structural vocabulary', () => {
    // "volume"/"episode"/"arc" appear in nearly every finding — they must not be
    // what makes two of them look like one, or the guard reverts good rounds.
    expect(findingTextOverlap('volume 3 drops the mentor subplot', 'volume 3 has no ticking clock'))
      .toBeLessThan(0.4);
    expect(sameFinding(f('the mentor subplot is dropped', 'V3'), f('the finale hook is unresolved', 'V4')))
      .toBe(false);
    // A single shared word is a coincidence, not an identity: both of these
    // reduce to {fix} once the structural nouns are dropped, which would
    // otherwise score a perfect 1.0 containment.
    expect(sameFinding(f('fix volume 3', 'volume 3'), f('fix arc one', 'arc one'))).toBe(false);
  });

  it('needs the PROBLEM to agree — a shared location alone is not one finding', () => {
    // Two genuinely different defects routinely sit in the same volume. Fusing
    // them would revert a round that closed what it targeted and merely exposed
    // something else next door — the over-strict rollback this guard must avoid.
    expect(sameFinding(f('the eclipse is staged twice', 'volume 3'), f('the mentor never returns', 'volume 3')))
      .toBe(false);
    // Naming the same place only LOWERS how much of the prose has to agree.
    expect(sameFinding(
      f('the eclipse is staged twice across the opening volumes', 'volume 3'),
      f('eclipse staged as a first-time event in two places, and the mentor thread also stalls here', 'volume 3 — act two'),
    )).toBe(true);
    // Whole-word location containment: a label can't swallow a longer one that
    // starts the same way.
    expect(sameFinding(f('x', 'V1'), f('y', 'V10'))).toBe(false);
    expect(sameFinding(f('x', 'volume 3'), f('y', 'volume 30'))).toBe(false);
  });
});

describe('isTargetedPatchRegression (bounded exact-text damage check)', () => {
  const f = (problem, location = 'V1', severity = 'medium') => ({ severity, location, problem });

  it('keeps a sparse patch that closed its target when an exhaustive judge exposes unrelated latent blockers', () => {
    expect(isTargetedPatchRegression(
      [f('the recovery order expires before the mandatory rest completes')],
      [
        f('the destination tow has no established local route', 'V3', 'high'),
        f('the inherited seal kit has no supplier setup', 'V2'),
      ],
    )).toBe(false);
  });

  it('rejects a sparse patch when its target survives alongside new blockers or returns more severe', () => {
    const target = f('the recovery order expires before the mandatory rest completes');
    expect(isTargetedPatchRegression([target], [
      target,
      f('the inherited seal kit has no supplier setup', 'V2'),
    ])).toBe(true);
    expect(isTargetedPatchRegression([target], [
      f('mandatory recovery outlasts the resource order', 'V1', 'high'),
    ])).toBe(true);
  });
});

describe('isBlockingSetRegression (arc rollback ordering)', () => {
  const f = (severity, problem) => ({ severity, problem, location: 'V1' });

  it('rejects an equal-count candidate whose severity mix got worse', () => {
    expect(isBlockingSetRegression(
      [f('high', 'recovery chronology'), f('medium', 'stale milestone')],
      [f('high', 'new canon violation'), f('high', 'stale milestone')],
    )).toBe(true);
  });

  it('keeps an equal-count candidate whose severity mix improved or held', () => {
    const before = [f('high', 'canon violation'), f('medium', 'stale milestone')];
    expect(isBlockingSetRegression(before, [
      f('medium', 'narrower handoff'), f('medium', 'stale milestone'),
    ])).toBe(false);
    expect(isBlockingSetRegression(before, before)).toBe(false);
  });

  it('preserves blocker count as the primary ordering signal', () => {
    expect(isBlockingSetRegression(
      [f('high', 'one blocker')],
      [f('medium', 'first blocker'), f('medium', 'second blocker')],
    )).toBe(true);
    expect(isBlockingSetRegression(
      [f('medium', 'first blocker'), f('medium', 'second blocker')],
      [f('high', 'one blocker')],
    )).toBe(false);
  });

  it('tolerates missing inputs', () => {
    expect(isBlockingSetRegression(undefined, undefined)).toBe(false);
    expect(isBlockingSetRegression(undefined, [f('high', 'new blocker')])).toBe(true);
  });
});
