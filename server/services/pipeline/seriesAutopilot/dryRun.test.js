import { describe, it, expect } from 'vitest';
import { summarizePlanCost } from './convergence.js';
import { buildDryRunPlan } from './dryRun.js';
import { resolveNextStep } from './stepResolver.js';

const VALID_SCRIPT = 'PAGE 1\nPANEL 1\nA scene.';
const ready = (output = 'x') => ({ status: 'ready', output });

describe('dry-run plan ↔ resolveNextStep drift guard (#1577)', () => {
  // buildDryRunPlan is kept in sync with resolveNextStep BY HAND (see the comment
  // above buildDryRunPlan). This guard runs BOTH against the same fixtures and
  // asserts they enumerate the SAME step kinds in the SAME order AND the SAME
  // per-step counts — so a future edit that adds/removes/reorders a step, or that
  // diverges a plan `count` formula (textNeeded / visualNeeded / beatsNeeded /
  // ordered.length) from the resolver's actual per-issue/per-season looping, fails
  // here instead of silently advertising a plan execute won't follow.
  //
  // Scope: this verifies plan ↔ RESOLVER parity. `completeStep` re-implements the
  // dispatch's runState effects (it does not drive the real dispatchStep), so a
  // change to dispatch that preserves step kinds/order/counts is out of scope.
  //
  // Fidelity note: the fixtures all have their issues already present (no empty
  // seasons), so no generation step CREATES new downstream work mid-walk. That's
  // the regime where the two are contractually identical — the dry-run plan is a
  // snapshot prediction of the CURRENT records, not a recursive expansion of
  // issues a generateEpisodes step would later add. generateArc / generateEpisodes
  // parity is covered separately by the dedicated plan tests.

  const freshRunState = () => ({
    locksUnlocked: false,
    characterFoundationEstablished: false, arcAttempted: false, arcSpineVerified: false, arcVerified: false, foundationGated: false, beatContinuityChecked: false,
    editorialReviewed: false, reverseOutlineRefreshed: false,
    editorialChecksReviewed: false, editorialHealthReady: false, canonVerified: false,
    episodesAttempted: new Set(), beatsAttempted: new Set(), textAttempted: new Set(),
    scriptChecked: new Set(), visualDrafted: new Set(),
  });

  // Advance runState + fixture exactly as the execute dispatch would once the
  // given step "completes" — flipping the precise predicate each downstream gate
  // reads: runState marks for the boolean/set gates, and issue/season CONTENT for
  // the content gates (beats → idea.output, text → required scripts, visuals →
  // rendered pages) so the resolver actually advances past them.
  const completeStep = (step, issues, runState, edRounds) => {
    switch (step.kind) {
      case 'unlockLocks':
        runState.locksUnlocked = true;
        break;
      case 'characterFoundation':
        runState.characterFoundationEstablished = true;
        break;
      case 'generateArc':
      case 'generateEpisodes':
        // These steps CREATE downstream work (seasons / issues) that buildDryRunPlan
        // intentionally does NOT predict from a snapshot — so a fixture that reaches
        // them is outside this guard's plan↔resolver-parity scope and would produce a
        // misleading false failure. Generation parity is covered by the dedicated
        // generateArc / generateEpisodes cases above; keep these fixtures populated.
        throw new Error(`drift guard: fixture reached "${step.kind}" — parity guard requires fully-populated fixtures (arc present + every season seeded with issues)`);
      case 'verifyArc':
        runState.arcVerified = true;
        break;
      case 'verifyArcSpine':
        runState.arcSpineVerified = true;
        break;
      case 'foundationGate':
        runState.foundationGated = true;
        break;
      case 'beatSheet':
        issues.filter((i) => i.seasonId === step.seasonId)
          .forEach((i) => { i.stages = { ...i.stages, idea: ready() }; });
        runState.beatsAttempted.add(step.seasonId);
        break;
      case 'beatContinuity':
        runState.beatContinuityChecked = true;
        break;
      case 'pilotDraft':
      case 'textStages': {
        runState.editorialReviewed = false;
        // Satisfy textReady for every script format (comic + tv) so the mutator
        // stays target-agnostic.
        const issue = issues.find((i) => i.id === step.issueId);
        issue.stages = { ...issue.stages, comicScript: ready(VALID_SCRIPT), teleplay: ready() };
        runState.textAttempted.add(step.issueId);
        break;
      }
      case 'scriptVerify':
        runState.scriptChecked.add(step.issueId);
        break;
      case 'pilotReview':
        runState.pilotReviewed = true;
        runState.editorialReviewed = true;
        break;
      case 'editorialReview':
        runState.editorialReviewed = true;
        // Mirror runEditorial: maxEditorialRounds === 0 marks the whole editorial
        // gate (reverse-outline + checks + health) done in one shot, so the
        // resolver advances straight past them — matching the plan's omission.
        if (edRounds === 0) {
          runState.reverseOutlineRefreshed = true;
          runState.editorialChecksReviewed = true;
          runState.editorialHealthReady = true;
        }
        break;
      case 'reverseOutline':
        runState.reverseOutlineRefreshed = true;
        break;
      case 'editorialChecks':
        runState.editorialChecksReviewed = true;
        break;
      case 'editorialHealthGate':
        runState.editorialHealthReady = true;
        break;
      case 'canonVerify':
        runState.canonVerified = true;
        break;
      case 'visualDraft': {
        const issue = issues.find((i) => i.id === step.issueId);
        issue.stages = {
          ...issue.stages,
          comicPages: {
            cover: { proofImage: { jobId: 'c' } },
            backCover: { proofImage: { jobId: 'b' } },
            pages: [{ panels: [{ description: 'x' }], proofImage: { jobId: 'p' } }],
          },
        };
        runState.visualDrafted.add(step.issueId);
        break;
      }
      default:
        throw new Error(`drift guard: unhandled step kind "${step.kind}" — add a completeStep branch`);
    }
  };

  // Collapse a flat list of emitted step kinds into the plan's shape: one
  // `{ kind, count }` entry per consecutive run. The resolver emits per-issue /
  // per-season steps one at a time (a run of N identical consecutive kinds); the
  // plan represents that same work as a single entry with `count: N`.
  const compress = (kinds) => kinds.reduce((out, kind) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.count += 1;
    else out.push({ kind, count: 1 });
    return out;
  }, []);

  // Walk resolveNextStep the way execute does — apply each step's effect, re-resolve
  // — collecting the ordered sequence of emitted step kinds (with repeats), then
  // compress to the plan's `{ kind, count }` shape.
  const simulateExecuteEntries = (series, issues, options) => {
    const working = issues.map((i) => ({ ...i, stages: { ...i.stages } }));
    const runState = freshRunState();
    const edRounds = Number.isInteger(options?.maxEditorialRounds) ? options.maxEditorialRounds : undefined;
    const emitted = [];
    for (let guard = 0; guard < 200; guard += 1) {
      const step = resolveNextStep(series, working, runState, options);
      if (step.kind === 'done') return compress(emitted);
      emitted.push(step.kind);
      completeStep(step, working, runState, edRounds);
    }
    throw new Error('drift guard: simulation did not converge to done within 200 steps');
  };

  // The plan carries extra annotation fields (note, etc.); compare only kind + count.
  const planEntries = (series, issues, options) =>
    buildDryRunPlan(series, issues, options).map((p) => ({ kind: p.kind, count: p.count }));

  const baseComic = () => ({ targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] });
  const baseTv = () => ({ targetFormat: 'tv', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] });
  const bareIssue = () => [{ id: 'iss1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
  // Two seasons, one bare issue each — exercises per-SEASON multiplicity (beatSheet
  // count 2) AND per-ISSUE multiplicity (textStages / scriptVerify / visualDraft
  // count 2), so the count formulas and the consecutive-run compression are tested.
  const twoSeasonComic = () => ({
    targetFormat: 'comic', arc: { logline: 'L', summary: 'S' },
    seasons: [{ id: 'se1', number: 1 }, { id: 'se2', number: 2 }],
  });
  const twoIssues = () => [
    { id: 'iss1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} },
    { id: 'iss2', seasonId: 'se2', number: 1, arcPosition: 2, stages: {} },
  ];

  const cases = [
    { name: 'comic + visual (full pipeline)', series: baseComic(), issues: bareIssue(), options: {} },
    { name: 'comic, text-only target (no canon/visual)', series: baseComic(), issues: bareIssue(), options: { target: 'text' } },
    { name: 'comic, editorial rounds 0 (skips editorial gate)', series: baseComic(), issues: bareIssue(), options: { maxEditorialRounds: 0 } },
    { name: 'tv (no comic script / canon / visual)', series: baseTv(), issues: bareIssue(), options: {} },
    { name: 'comic + visual, 2 seasons × 1 issue (per-step multiplicity)', series: twoSeasonComic(), issues: twoIssues(), options: {} },
    { name: 'comic + unlock-for-run pre-pass', series: baseComic(), issues: bareIssue(), options: { unlockForRun: true } },
  ];

  for (const c of cases) {
    it(`enumerates identical step kinds + counts in identical order — ${c.name}`, () => {
      // buildDryRunPlan reads the records as-is; the simulation walks fresh copies,
      // so the two never share mutable state.
      const plan = planEntries(c.series, c.issues, c.options);
      const executed = simulateExecuteEntries(c.series, c.issues, c.options);
      expect(executed.length).toBeGreaterThan(0);
      expect(executed).toEqual(plan);
    });
  }
});

describe('buildDryRunPlan', () => {
  it('dry-run previews duplicate-volume repair without charging episode generation for absorbed records', () => {
    const duplicate = {
      targetFormat: 'comic', arc: { logline: 'L', summary: 'S' },
      // A lock makes the empty first record the survivor; the issue-bearing
      // duplicate is absorbed and its issue must be projected onto that survivor.
      seasons: [{ id: 'se1', number: 1, locked: true }, { id: 'dup1', number: 1 }],
    };
    const plan = buildDryRunPlan(duplicate, [
      { id: 'i1', seasonId: 'dup1', number: 1, arcPosition: 1, stages: {} },
    ], {});
    expect(plan[0]).toMatchObject({ kind: 'repairArcStructure', estActions: 0 });
    expect(plan.some((entry) => entry.kind === 'generateEpisodes')).toBe(false);
  });

  it('stops the plan at duplicate-volume repair when the arc is locked', () => {
    const series = {
      targetFormat: 'comic',
      arc: { logline: 'L', summary: 'S' },
      locked: { arc: true },
      seasons: [{ id: 'se1', number: 1 }, { id: 'dup1', number: 1 }],
    };

    expect(buildDryRunPlan(series, [], {})).toEqual([
      expect.objectContaining({ kind: 'repairArcStructure', count: 1, estActions: 0 }),
    ]);

    const unlockedPlan = buildDryRunPlan(series, [], { unlockForRun: true });
    expect(unlockedPlan.slice(0, 2)).toEqual([
      expect.objectContaining({ kind: 'unlockLocks', estActions: 0 }),
      expect.objectContaining({ kind: 'repairArcStructure', estActions: 0 }),
    ]);
    expect(unlockedPlan).toContainEqual({ kind: 'generateEpisodes', count: 1, estActions: 1 });
    expect(series.locked.arc).toBe(true);
    expect(series.seasons).toHaveLength(2);
  });

  it('projects arc generation without the foundation prerequisite when foundation rounds are zero', () => {
    const plan = buildDryRunPlan({ targetFormat: 'comic', seasons: [] }, [], { maxFoundationRounds: 0 });
    expect(plan[0]).toEqual(expect.objectContaining({ kind: 'generateArc', count: 1, estActions: 1 }));
    const kinds = plan.map((step) => step.kind);
    expect(kinds).not.toContain('characterFoundation');
    expect(kinds).not.toContain('foundationGate');
  });

  it('dry-run plan includes generateArc for an arc-only series (parity with execute)', () => {
    const plan = buildDryRunPlan(
      { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [] }, [], {},
    );
    expect(plan.slice(0, 2).map((step) => step.kind)).toEqual(['characterFoundation', 'generateArc']);
  });

  it('dry-run plan omits editorialChecks + editorialHealthGate when editorial rounds are 0', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const kinds = (opts) => buildDryRunPlan(series, issues, opts).map((p) => p.kind);
    // With editorial enabled (default), the reverse-outline refresh (#1349), both
    // registry checks + health gate appear.
    expect(kinds({})).toEqual(expect.arrayContaining(['pilotReview', 'reverseOutline', 'editorialChecks', 'editorialHealthGate']));
    // The reverse-outline refresh is enumerated BEFORE the editorial checks it feeds.
    const defaultKinds = kinds({});
    expect(defaultKinds.indexOf('reverseOutline')).toBeLessThan(defaultKinds.indexOf('editorialChecks'));
    // With maxEditorialRounds:0, execute mode skips the whole editorial gate — the
    // plan must omit the reverse-outline refresh and both checks too.
    const skipped = kinds({ maxEditorialRounds: 0 });
    expect(skipped).toContain('editorialReview'); // shown as "skipped (0 rounds)"
    expect(skipped).not.toContain('reverseOutline');
    expect(skipped).not.toContain('editorialChecks');
    expect(skipped).not.toContain('editorialHealthGate');
  });

  it('dry-run plan annotates the editorial-checks step with a per-run subset (#1575)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const noteFor = (opts) => buildDryRunPlan(series, issues, opts)
      .find((p) => p.kind === 'editorialChecks')?.note;
    // No subset → the plan advertises the full enabled set.
    expect(noteFor({})).toMatch(/enabled editorial checks/);
    // A subset → the plan says how many checks will run instead of implying all.
    expect(noteFor({ editorialCheckIds: ['pacing', 'continuity'] })).toMatch(/subset of 2 editorial check/);
    // An empty array is treated as "no override" — back to the full set.
    expect(noteFor({ editorialCheckIds: [] })).toMatch(/enabled editorial checks/);
  });

  it('annotates every dry-run step with an estActions estimate (#1576)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [
      { id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} },
      { id: 'i2', seasonId: 'se1', number: 2, arcPosition: 2, stages: {} },
    ];
    const plan = buildDryRunPlan(series, issues, {});
    // Every step carries a numeric estimate.
    expect(plan.every((p) => Number.isFinite(p.estActions))).toBe(true);
    const byKind = Object.fromEntries(plan.map((p) => [p.kind, p]));
    // verifyArc: each round checks the whole arc + one volume, then resolves
    // between rounds → 3*(1+1)+2 = 8 — plus the per-finding isolation pass the
    // gate can escalate to inside a round (#3780): an attempt costs a resolve +
    // an arc verify + one volume verify = 3, so the 8-call budget buys 2 → +6.
    expect(byKind.verifyArc.estActions).toBe(14);
    // textStages: one child action per not-yet-text-ready issue (2 here).
    expect(byKind.pilotDraft.estActions).toBe(1);
    expect(byKind.textStages.estActions).toBe(1);
    // Pure-gate steps that bill nothing against the cap are zero-cost.
    expect(byKind.editorialHealthGate.estActions).toBe(0);
  });

  it('scales verify/editorial estActions with the per-run round caps (#1576)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const actionsFor = (opts, kind) => buildDryRunPlan(series, issues, opts)
      .find((p) => p.kind === kind)?.estActions;
    // 0 rounds → the loop is skipped → 0 actions.
    expect(actionsFor({ maxArcVerifyRounds: 0 }, 'verifyArc')).toBe(0);
    // 1 round → whole-arc + one-volume verify, no resolve → 2 actions. Isolation
    // needs a second round to verify what it kept, so it projects nothing here.
    expect(actionsFor({ maxArcVerifyRounds: 1 }, 'verifyArc')).toBe(2);
    // 4 rounds → 4 arc verifies + 4 volume verifies + 3 resolves → 11, plus the
    // isolation pass's 2 attempts × 3 calls (#3780) → 17.
    expect(actionsFor({ maxArcVerifyRounds: 4 }, 'verifyArc')).toBe(17);
    // …and a run that declined it gets the round-based estimate back.
    expect(actionsFor({ maxArcVerifyRounds: 4, maxArcIsolationAttempts: 0 }, 'verifyArc')).toBe(11);
    expect(actionsFor({ maxArcVerifyRounds: 4, maxArcResolveRetries: 0 }, 'verifyArc')).toBe(11);
    // Editorial review follows the same convergence shape.
    expect(actionsFor({ maxEditorialRounds: 2 }, 'pilotReview')).toBe(3);
  });

  it('estimates editorialChecks LLM fan-out as issues × enabled LLM checks (#1576)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [
      { id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} },
      { id: 'i2', seasonId: 'se1', number: 2, arcPosition: 2, stages: {} },
      { id: 'i3', seasonId: 'se1', number: 3, arcPosition: 3, stages: {} },
    ];
    const stepFor = (ctx) => buildDryRunPlan(series, issues, {}, ctx)
      .find((p) => p.kind === 'editorialChecks');
    // 2 enabled LLM checks × 3 issues = 6 LLM calls; the pass bills 1 cos action.
    const two = stepFor({ editorialLlmCheckCount: 2 });
    expect(two.estLlmCalls).toBe(6);
    expect(two.estActions).toBe(1);
    expect(two.note).toMatch(/~6 LLM call/);
    // No enabled LLM check → no cos action billed and no LLM calls.
    const none = stepFor({ editorialLlmCheckCount: 0 });
    expect(none.estActions).toBe(0);
    expect(none.estLlmCalls).toBe(0);
  });

  it('summarizePlanCost totals estActions and estLlmCalls across the plan (#1576)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const plan = buildDryRunPlan(series, issues, {}, { editorialLlmCheckCount: 3 });
    const totals = summarizePlanCost(plan);
    const manualActions = plan.reduce((s, p) => s + (p.estActions || 0), 0);
    const manualLlm = plan.reduce((s, p) => s + (p.estLlmCalls || 0), 0);
    expect(totals.estActions).toBe(manualActions);
    expect(totals.estLlmCalls).toBe(manualLlm);
    // Single issue × 3 LLM checks → 3 editorial-check LLM calls in the total.
    expect(totals.estLlmCalls).toBe(3);
    // A non-array (defensive) summarizes to zeroes.
    expect(summarizePlanCost(null)).toEqual({ estActions: 0, estLlmCalls: 0 });
  });

  it('dry-run plan surfaces the effective readiness gate on the health-gate step (#1580)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const gateNote = (opts) => buildDryRunPlan(series, issues, opts)
      .find((p) => p.kind === 'editorialHealthGate')?.note;
    // No override → the plan shows the default gate.
    expect(gateNote({})).toMatch(/gate: noOpenHigh$/);
    // A per-run override is reflected in the plan note.
    expect(gateNote({ readinessGate: 'none' })).toMatch(/gate: none$/);
    expect(gateNote({ readinessGate: 'noOpenHighOrMedium' })).toMatch(/gate: noOpenHighOrMedium$/);
    // An invalid gate falls through to the default.
    expect(gateNote({ readinessGate: 'bogus' })).toMatch(/gate: noOpenHigh$/);
  });

  it('dry-run plan annotates the editorial-checks step with the pause threshold when armed (#1613)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const noteFor = (opts) => buildDryRunPlan(series, issues, opts)
      .find((p) => p.kind === 'editorialChecks')?.note;
    // Off (default / 0) → no pause annotation.
    expect(noteFor({})).not.toMatch(/pauses at/);
    expect(noteFor({ checkFindingsPauseThreshold: 0 })).not.toMatch(/pauses at/);
    // Armed → the threshold is surfaced in the note.
    expect(noteFor({ checkFindingsPauseThreshold: 5 })).toMatch(/pauses at ≥ 5 high finding/);
  });

  it('dry-run plan lists the revision cycle after the health gate when enabled', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const plan = buildDryRunPlan(series, issues, { revisionEnabled: true, revisionMaxCycles: 3, includeVisual: false });
    const kinds = plan.map((p) => p.kind);
    expect(kinds).toContain('revisionCycle');
    expect(kinds.indexOf('revisionCycle')).toBeGreaterThan(kinds.indexOf('editorialHealthGate'));
    const rev = plan.find((p) => p.kind === 'revisionCycle');
    expect(rev.count).toBe(3);
  });

  it('dry-run plan omits the revision cycle when disabled', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const plan = buildDryRunPlan(series, issues, { includeVisual: false });
    expect(plan.map((p) => p.kind)).not.toContain('revisionCycle');
  });
});
