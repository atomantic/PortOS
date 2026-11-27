import { describe, it, expect } from 'vitest';
import { resolveNextStep, requiredScriptStages, scriptStructurallyReady, visualReady, wantsComic } from './stepResolver.js';

const VALID_SCRIPT = 'PAGE 1\nPANEL 1\nA scene.';
const ready = (output = 'x') => ({ status: 'ready', output });

describe('resolveNextStep (pure)', () => {
  const comic = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
  const issue = (over = {}) => ({ id: 'iss1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {}, ...over });

  it('asks for arc generation when there is no arc', () => {
    const bare = { targetFormat: 'comic', seasons: [] };
    expect(resolveNextStep(bare, []).kind).toBe('characterFoundation');
    expect(resolveNextStep(bare, [], { characterFoundationEstablished: true }).kind).toBe('generateArc');
  });

  it('treats a present arc summary (no logline) as having an arc', () => {
    const step = resolveNextStep(
      { targetFormat: 'comic', arc: { summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] },
      [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }],
    );
    expect(step.kind).not.toBe('generateArc');
  });

  it('regenerates the arc for an arc-only series with no volumes', () => {
    const arcOnly = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [] };
    expect(resolveNextStep(arcOnly, []).kind).toBe('characterFoundation');
    expect(resolveNextStep(arcOnly, [], { characterFoundationEstablished: true }).kind).toBe('generateArc');
    // once arc generation has been attempted, it does not re-loop into generateArc
    expect(resolveNextStep(arcOnly, [], { arcAttempted: true }).kind).not.toBe('generateArc');
  });

  it('repairs duplicate volume numbers before generating episodes for empty duplicates', () => {
    const duplicate = {
      targetFormat: 'comic', arc: { logline: 'L', summary: 'S' },
      seasons: [{ id: 'se1', number: 1 }, { id: 'dup1', number: 1 }, { id: 'dup2', number: 1 }],
    };
    const step = resolveNextStep(duplicate, [
      { id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} },
    ]);
    expect(step.kind).toBe('repairArcStructure');
  });

  it('asks to generate episodes for a season with no issues', () => {
    const step = resolveNextStep(comic, [], { arcSpineVerified: true });
    expect(step).toMatchObject({ kind: 'generateEpisodes', seasonId: 'se1' });
  });

  it('checks the arc spine before foundation evaluation or drafting', () => {
    const step = resolveNextStep(comic, [issue()]);
    expect(step.kind).toBe('verifyArcSpine');
  });

  it('runs arc verification after the foundation gate, before beats (#2176)', () => {
    const step = resolveNextStep(comic, [issue()], { arcSpineVerified: true, foundationGated: true });
    expect(step.kind).toBe('verifyArc');
  });

  it('skips the foundation gate when disabled via options (#2176)', () => {
    const step = resolveNextStep(comic, [issue()], { arcVerified: true }, { foundationGate: false });
    expect(step).toMatchObject({ kind: 'beatSheet', seasonId: 'se1' });
  });

  it('skips the foundation gate when maxFoundationRounds is 0 (#2176)', () => {
    const step = resolveNextStep(comic, [issue()], { arcVerified: true }, { maxFoundationRounds: 0 });
    expect(step).toMatchObject({ kind: 'beatSheet', seasonId: 'se1' });
  });

  it('asks for beat sheets when an issue has no idea (post-verify)', () => {
    const step = resolveNextStep(comic, [issue()], { arcVerified: true, foundationGated: true });
    expect(step).toMatchObject({ kind: 'beatSheet', seasonId: 'se1' });
  });

  it('skips a season already attempted for beats (no infinite loop)', () => {
    const step = resolveNextStep(comic, [issue()], { arcVerified: true, foundationGated: true, beatsAttempted: new Set(['se1']) });
    // beats skipped → falls through to text stages
    expect(step).toMatchObject({ kind: 'pilotDraft', issueId: 'iss1' });
  });

  it('runs whole-manuscript beat continuity once beats exist, before text (#1510)', () => {
    const step = resolveNextStep(comic, [issue({ stages: { idea: ready() } })], { arcVerified: true, foundationGated: true });
    expect(step).toMatchObject({ kind: 'beatContinuity' });
  });

  it('skips beat continuity for a synopsis-only run (no beats anywhere)', () => {
    // idea has input (synopsis) but no ready output → no beats → fall through to
    // text without a beat-continuity pass (it would just duplicate arc verify).
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: { status: 'empty', input: 'syn', output: '' }, comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true },
    );
    expect(step.kind).not.toBe('beatContinuity');
  });

  it('asks for text stages once beats are continuity-checked but scripts do not exist', () => {
    const step = resolveNextStep(comic, [issue({ stages: { idea: ready() } })], { arcVerified: true, foundationGated: true, beatContinuityChecked: true });
    expect(step).toMatchObject({ kind: 'pilotDraft', issueId: 'iss1' });
  });

  it('asks for structural script verify once comic script is ready', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true },
    );
    expect(step).toMatchObject({ kind: 'scriptVerify', issueId: 'iss1' });
  });

  it('asks for editorial review once all issues are script-checked', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']) },
    );
    expect(step.kind).toBe('editorialReview');
  });

  it('refreshes the reverse outline after editorial review, before editorial checks (#1349)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('reverseOutline');
  });

  it('asks for editorial checks once the reverse outline is refreshed (#1349)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('editorialChecks');
  });

  it('runs the editorial health gate after both editorial passes (#1316)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('editorialHealthGate');
  });

  it('is done once the editorial health gate is clean (no visuals requested)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('done');
  });

  it('is done (no canon/visual) when target is text, even on a comic series', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: true, target: 'text' },
    );
    expect(step.kind).toBe('done');
  });

  it('asks for canon verify before visuals when includeVisual', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: true },
    );
    expect(step.kind).toBe('canonVerify');
  });

  it('asks for visual draft once canon is verified and pages are not rendered', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true },
      { includeVisual: true },
    );
    expect(step).toMatchObject({ kind: 'visualDraft', issueId: 'iss1' });
  });

  it('is done when visuals are already rendered', () => {
    const renderedStages = {
      idea: ready(),
      comicScript: ready(VALID_SCRIPT),
      comicPages: {
        cover: { proofImage: { jobId: 'j' } },
        backCover: { proofImage: { jobId: 'jb' } },
        pages: [{ panels: [{ description: 'x' }], proofImage: { jobId: 'p0' } }],
      },
    };
    const step = resolveNextStep(
      comic,
      [issue({ stages: renderedStages })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true },
      { includeVisual: true },
    );
    expect(step.kind).toBe('done');
  });

  it('does not run script verify for a tv-only target', () => {
    const tv = { targetFormat: 'tv', arc: { logline: 'L' }, seasons: [{ id: 'se1', number: 1 }] };
    const step = resolveNextStep(
      tv,
      [issue({ stages: { idea: ready(), teleplay: ready() } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true },
    );
    expect(step.kind).toBe('pilotReview');
  });

  // CDO Phase 3 (#2185) — the opt-in teaser deliverable is the LAST step, after
  // visuals are drafted, and only when produceTeaser is on.
  const rendered = {
    idea: ready(),
    comicScript: ready(VALID_SCRIPT),
    comicPages: {
      cover: { proofImage: { jobId: 'j' } },
      backCover: { proofImage: { jobId: 'jb' } },
      pages: [{ panels: [{ description: 'x' }], proofImage: { jobId: 'p0' } }],
    },
  };
  const fullyReady = { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true };

  it('does NOT ask for a teaser by default (produceTeaser off) — stays done', () => {
    const step = resolveNextStep(comic, [issue({ stages: rendered })], fullyReady, { includeVisual: true });
    expect(step.kind).toBe('done');
  });

  it('asks for a teaser once visuals are drafted and produceTeaser is on', () => {
    const step = resolveNextStep(comic, [issue({ stages: rendered })], fullyReady, { includeVisual: true, produceTeaser: true });
    expect(step).toMatchObject({ kind: 'produceTeaser', issueId: 'iss1' });
  });

  it('is done once the teaser has been produced this run', () => {
    const step = resolveNextStep(comic, [issue({ stages: rendered })], { ...fullyReady, teaserProduced: new Set(['iss1']) }, { includeVisual: true, produceTeaser: true });
    expect(step.kind).toBe('done');
  });

  it('never asks for a teaser on a text-only run even with produceTeaser on', () => {
    const step = resolveNextStep(comic, [issue({ stages: rendered })], fullyReady, { target: 'text', produceTeaser: true });
    expect(step.kind).toBe('done');
  });
});

describe('resolveNextStep — unlock pre-pass ordering', () => {
  // A locked arc makes generateArc/resolveVerifyIssues throw and a locked stage
  // makes text generation skip, so the unlock MUST precede every generation step
  // — pin that it sorts ahead of even the very first one.
  const bare = { targetFormat: 'comic', arc: null, seasons: [] };

  it('runs before generateArc when enabled', () => {
    expect(resolveNextStep(bare, [], {}, { unlockForRun: true }).kind).toBe('unlockLocks');
  });
  it('is skipped entirely when not enabled', () => {
    expect(resolveNextStep(bare, [], {}, {}).kind).toBe('characterFoundation');
    expect(resolveNextStep(bare, [], {}, { unlockForRun: false }).kind).toBe('characterFoundation');
  });
  it('runs at most once per run (latched by runState.locksUnlocked)', () => {
    expect(resolveNextStep(bare, [], { locksUnlocked: true }, { unlockForRun: true }).kind).toBe('characterFoundation');
    expect(resolveNextStep(bare, [], { locksUnlocked: true, characterFoundationEstablished: true }, { unlockForRun: true }).kind).toBe('generateArc');
  });
  it('unlocks before repairing duplicate volume structure', () => {
    const duplicate = {
      targetFormat: 'comic', arc: { logline: 'L', summary: 'S' },
      seasons: [{ id: 'se1', number: 1, locked: true }, { id: 'dup1', number: 1, locked: true }],
    };
    expect(resolveNextStep(duplicate, [], {}, { unlockForRun: true }).kind).toBe('unlockLocks');
    expect(resolveNextStep(duplicate, [], { locksUnlocked: true }, { unlockForRun: true }).kind).toBe('repairArcStructure');
  });
});

describe('resolveNextStep — revision cycle ordering (#2171)', () => {
  const comic = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
  const issue = (over = {}) => ({ id: 'iss1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {}, ...over });
  // Health-clean base runState (everything up to and including the health gate).
  const healthClean = {
    arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']),
    editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true,
    editorialHealthReady: true,
  };
  const stages = { idea: ready(), comicScript: ready(VALID_SCRIPT) };

  it('does NOT insert a revision cycle when disabled (default) — proceeds to canonVerify', () => {
    const step = resolveNextStep(comic, [issue({ stages })], healthClean, { includeVisual: true });
    expect(step.kind).toBe('canonVerify');
  });

  it('inserts the revision cycle after the health gate and before canonVerify when enabled', () => {
    const step = resolveNextStep(comic, [issue({ stages })], healthClean, { includeVisual: true, revisionEnabled: true, revisionMaxCycles: 2 });
    expect(step.kind).toBe('revisionCycle');
    expect(step.reason).toMatch(/cycle 1/);
  });

  it('routes back to the revision cycle while cycles remain (cursor is revisionCyclesRun)', () => {
    const step = resolveNextStep(
      comic, [issue({ stages })],
      { ...healthClean, revisionCyclesRun: 1 },
      { includeVisual: true, revisionEnabled: true, revisionMaxCycles: 3 },
    );
    expect(step.kind).toBe('revisionCycle');
    expect(step.reason).toMatch(/cycle 2/);
  });

  it('stops routing to the revision cycle once maxCycles is reached', () => {
    const step = resolveNextStep(
      comic, [issue({ stages })],
      { ...healthClean, revisionCyclesRun: 2 },
      { includeVisual: true, revisionEnabled: true, revisionMaxCycles: 2 },
    );
    expect(step.kind).toBe('canonVerify');
  });

  it('stops routing to the revision cycle once converged (plateau/hedge latched)', () => {
    const step = resolveNextStep(
      comic, [issue({ stages })],
      { ...healthClean, revisionCyclesRun: 1, revisionConverged: true },
      { includeVisual: true, revisionEnabled: true, revisionMaxCycles: 5 },
    );
    expect(step.kind).toBe('canonVerify');
  });

});

describe('requiredScriptStages / scriptStructurallyReady', () => {
  it('maps targetFormat to required scripts', () => {
    expect(requiredScriptStages({ targetFormat: 'comic' })).toEqual(['comicScript']);
    expect(requiredScriptStages({ targetFormat: 'tv' })).toEqual(['teleplay']);
    expect(requiredScriptStages({ targetFormat: 'comic+tv' })).toEqual(['comicScript', 'teleplay']);
    expect(requiredScriptStages({})).toEqual(['comicScript', 'teleplay']);
  });

  it('restricts a comic+tv series to one format via options.targetFormats', () => {
    const series = { targetFormat: 'comic+tv' };
    expect(requiredScriptStages(series, { targetFormats: ['comic'] })).toEqual(['comicScript']);
    expect(requiredScriptStages(series, { targetFormats: ['tv'] })).toEqual(['teleplay']);
    expect(requiredScriptStages(series, { targetFormats: ['comic', 'tv'] })).toEqual(['comicScript', 'teleplay']);
  });

  it('ignores a restriction the series cannot satisfy (never strands the run with zero scripts)', () => {
    // A comic-only series asked to produce tv-only falls back to its own format.
    expect(requiredScriptStages({ targetFormat: 'comic' }, { targetFormats: ['tv'] })).toEqual(['comicScript']);
    // Empty / non-array restrictions are no-ops.
    expect(requiredScriptStages({ targetFormat: 'comic+tv' }, { targetFormats: [] })).toEqual(['comicScript', 'teleplay']);
    expect(requiredScriptStages({ targetFormat: 'comic+tv' }, {})).toEqual(['comicScript', 'teleplay']);
  });

  it('passes a parseable comic script and fails an unparseable one', () => {
    expect(scriptStructurallyReady({ stages: { comicScript: ready(VALID_SCRIPT) } })).toBe(true);
    expect(scriptStructurallyReady({ stages: { comicScript: ready('just some prose, no pages') } })).toBe(false);
    expect(scriptStructurallyReady({ stages: {} })).toBe(false);
  });
});

describe('wantsComic (per-run comic gating)', () => {
  it('honors the series format when no restriction is given', () => {
    expect(wantsComic({ targetFormat: 'comic+tv' })).toBe(true);
    expect(wantsComic({ targetFormat: 'comic' })).toBe(true);
    expect(wantsComic({ targetFormat: 'tv' })).toBe(false);
  });

  it('is false for a comic+tv series restricted to tv-only (so comic gates do NOT run)', () => {
    // This is the bug: a ['tv'] run must NOT enter scriptVerify/visual on a
    // comic+tv series, or it would verify a comic script that was never authored.
    expect(wantsComic({ targetFormat: 'comic+tv' }, { targetFormats: ['tv'] })).toBe(false);
    expect(wantsComic({ targetFormat: 'comic+tv' }, { targetFormats: ['comic'] })).toBe(true);
    expect(wantsComic({ targetFormat: 'comic+tv' }, { targetFormats: ['comic', 'tv'] })).toBe(true);
  });

  it('treats a restriction the series cannot satisfy as a no-op (matches requiredScriptStages)', () => {
    // comic-only series asked for tv-only → requiredScriptStages falls back to
    // comic; wantsComic must agree (still wants comic) so the run isn't stranded.
    expect(wantsComic({ targetFormat: 'comic' }, { targetFormats: ['tv'] })).toBe(true);
    expect(wantsComic({ targetFormat: 'comic+tv' }, { targetFormats: [] })).toBe(true);
  });
});

describe('visualReady', () => {
  const cover = { proofImage: { jobId: 'c' } };
  const backCover = { proofImage: { jobId: 'b' } };
  it('is false with no pages, true once cover + back + all paneled pages are enqueued', () => {
    expect(visualReady({ stages: { comicPages: { pages: [] } } })).toBe(false);
    // pages but cover not enqueued
    expect(visualReady({ stages: { comicPages: { pages: [{ panels: [{}], proofImage: { jobId: 'p' } }] } } })).toBe(false);
    // cover + back + page enqueued
    expect(visualReady({
      stages: { comicPages: { cover, backCover, pages: [{ panels: [{}], proofImage: { jobId: 'p' } }] } },
    })).toBe(true);
  });

  it('requires the back cover to be enqueued (always drafted)', () => {
    expect(visualReady({
      stages: { comicPages: { cover, pages: [{ panels: [{}], proofImage: { jobId: 'p' } }] } },
    })).toBe(false);
  });

  it('counts a legacy rendered slot (imageJobId/filename) as enqueued', () => {
    expect(visualReady({
      stages: { comicPages: { cover: { imageJobId: 'legacy' }, backCover: { filename: 'b.png' }, pages: [{ panels: [{}], imageJobId: 'lp' }] } },
    })).toBe(true);
  });

  it('does not block on a page that has no panels', () => {
    expect(visualReady({
      stages: { comicPages: { cover: { finalImage: { filename: 'c.png' } }, backCover, pages: [{ panels: [] }] } },
    })).toBe(true);
  });
});
