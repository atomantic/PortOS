/**
 * dryRun.test.js
 *
 * dryRun.js plan / resolveNextStep drift guard. Split from seriesAutopilot.test.js (#16214); shared mocks and
 * fixtures live in seriesAutopilot.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./seriesAutopilot.testFixtures.js'));
const { VALID_SCRIPT, ready } = h;

vi.mock('../../runner.js', (importOriginal) => h.runnerFactory(importOriginal));
vi.mock('../../../lib/fileUtils.js', () => h.fileUtilsFactory());
vi.mock('crypto', () => h.cryptoFactory());
vi.mock('../../instanceIdentity.js', () => h.instanceIdentityFactory());
vi.mock('../../instances.js', () => h.instancesFactory());
vi.mock('../../sharing/peerSync.js', () => h.peerSyncFactory());
vi.mock('../../cosState.js', () => h.cosStateFactory());
vi.mock('../../domainUsage.js', () => h.domainUsageFactory());
vi.mock('../arcPlanner.js', (importOriginal) => h.arcPlannerFactory(importOriginal));
vi.mock('../volumeBeatsRunner.js', () => h.volumeBeatsSpies);
vi.mock('../autoRunner.js', () => h.autoRunnerSpies);
vi.mock('../manuscriptReview.js', () => h.manuscriptReviewFactory());
vi.mock('../editorial/checkRunner.js', () => h.checkRunnerSpies);
vi.mock('../reverseOutline.js', () => h.reverseOutlineFactory());
vi.mock('../../settings.js', (importOriginal) => h.settingsFactory(importOriginal));
vi.mock('../manuscriptFix.js', () => h.manuscriptFixFactory());
vi.mock('../visualStages.js', () => h.visualSpies);
vi.mock('../../cosTaskStore.js', () => h.cosTaskStoreFactory());
vi.mock('../scriptVerify.js', () => h.scriptVerifyFactory());
vi.mock('../canonReadiness.js', () => h.canonReadinessFactory());
vi.mock('../../universeCanon.js', () => h.universeCanonFactory());
vi.mock('../foundationJudge.js', (importOriginal) => h.foundationJudgeFactory(importOriginal));
vi.mock('./modelPerformance.js', () => h.modelPerformanceFactory());
vi.mock('../../notifications.js', () => h.notificationsFactory());

// Mocked bindings, so a test can drive the budget and persisted settings per call.
const { getDomainBudgetStatus } = await import('../../domainUsage.js');
const { getSettings } = await import('../../settings.js');

// Real services + the unit under test (imported AFTER the mocks above).
const autopilot = await import('../seriesAutopilot.js');
const { resolveNextStep } = autopilot;

beforeEach(() => {
  h.resetFixtures({ autopilot, getDomainBudgetStatus, getSettings });
});

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
  // parity is covered separately by the dedicated cases above.

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
    autopilot.__testing.buildDryRunPlan(series, issues, options).map((p) => ({ kind: p.kind, count: p.count }));

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
