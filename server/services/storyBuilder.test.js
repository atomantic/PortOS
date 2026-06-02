import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../lib/mockPathsDataRoot.js';

// In-memory file store shared by all collection stores (storyBuilder, universe,
// series) — mirrors the arcPlanner.test.js fixture so create paths persist.
const fileStore = new Map();
let stageRunnerSpy;

vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

vi.mock('../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
}));

const sb = await import('./storyBuilder.js');
const seriesSvc = await import('./pipeline/series.js');
const universeSvc = await import('./universeBuilder.js');
const issuesSvc = await import('./pipeline/issues.js');

beforeEach(() => {
  fileStore.clear();
  uuidCounter = 0;
  stageRunnerSpy = undefined;
});

describe('storyBuilder — CRUD', () => {
  it('seed mode mints universe + series shells and starts on the idea step', async () => {
    const s = await sb.createStorySession({ title: 'Salt Run', seedIdea: 'a foundry city goes silent' });
    expect(s.id).toMatch(/^stb-/);
    expect(s.intakeMode).toBe('seed');
    expect(s.universeId).toMatch(/^univ-|^uni-|.+/); // minted
    expect(s.seriesId).toMatch(/^ser-/);
    expect(s.currentStep).toBe('idea');
    // Every step starts pending + unlocked.
    expect(s.steps.idea).toEqual({ status: 'pending', locked: false, lockedAt: null, upstreamHash: null });
    // The shells actually exist.
    const universe = await universeSvc.getUniverse(s.universeId);
    expect(universe.name).toBe('Salt Run');
    const series = await seriesSvc.getSeries(s.seriesId);
    expect(series.premise).toBe('a foundry city goes silent');
  });

  it('import mode does not mint shells and marks all steps ready', async () => {
    const universe = await universeSvc.createUniverse({ name: 'U' });
    const series = await seriesSvc.createSeries({ name: 'S', universeId: universe.id });
    const s = await sb.createStorySession({
      title: 'Imported', intakeMode: 'import', universeId: universe.id, seriesId: series.id,
    });
    expect(s.universeId).toBe(universe.id);
    expect(s.seriesId).toBe(series.id);
    expect(s.steps.idea.status).toBe('ready');
    expect(s.steps.readerMap.status).toBe('ready');
  });

  it('rejects a blank title', async () => {
    await expect(sb.createStorySession({ title: '   ' })).rejects.toMatchObject({ code: sb.ERR_VALIDATION });
  });

  it('lists, gets, updates, and soft-deletes', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    expect((await sb.listStorySessions()).map((x) => x.id)).toContain(s.id);
    const updated = await sb.updateStorySession(s.id, { title: 'Renamed' });
    expect(updated.title).toBe('Renamed');
    await sb.deleteStorySession(s.id);
    await expect(sb.getStorySession(s.id)).rejects.toMatchObject({ code: sb.ERR_NOT_FOUND });
    expect((await sb.listStorySessions()).map((x) => x.id)).not.toContain(s.id);
  });
});

describe('storyBuilder — lock state machine + gating', () => {
  it('lockStep stamps an upstreamHash and flips status to locked', async () => {
    const s = await sb.createStorySession({ title: 'X', seedIdea: 'seed' });
    const locked = await sb.lockStep(s.id, 'idea');
    expect(locked.steps.idea.locked).toBe(true);
    expect(locked.steps.idea.upstreamHash).toMatch(/^[0-9a-f]{64}$/);
    expect(locked.steps.idea.lockedAt).toBeTruthy();
  });

  it('allows jumping to any step out of order (start-from-anywhere)', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    // Navigation is advisory, not gated: the user may jump straight to a later
    // step and backfill the earlier ones. (Lock/stale state is surfaced as a
    // warning in the session view, enforced only at the generators.)
    const moved = await sb.setCurrentStep(s.id, 'plotArc');
    expect(moved.currentStep).toBe('plotArc');
    // Unknown ids still reject.
    await expect(sb.setCurrentStep(s.id, 'bogus')).rejects.toMatchObject({ code: sb.ERR_VALIDATION });
  });

  it('moving backward is always allowed', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await sb.lockStep(s.id, 'idea');
    await sb.setCurrentStep(s.id, 'universeAesthetic');
    const back = await sb.setCurrentStep(s.id, 'idea');
    expect(back.currentStep).toBe('idea');
  });

  it('unlockStep clears the lock and releases the underlying series arc lock', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await sb.lockStep(s.id, 'plotArc');
    let series = await seriesSvc.getSeries(s.seriesId);
    expect(series.locked.arc).toBe(true);
    const after = await sb.unlockStep(s.id, 'plotArc');
    expect(after.steps.plotArc.locked).toBe(false);
    series = await seriesSvc.getSeries(s.seriesId);
    expect(series.locked.arc).toBeUndefined();
  });
});

describe('storyBuilder — integrity / staleness', () => {
  it('flags a locked downstream step stale when an upstream record changes', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    // Give the series an arc + reader map, then lock the readerMap step.
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'spine', summary: 'sum', readerMap: { hooks: [{ label: 'h' }] } },
    });
    await sb.lockStep(s.id, 'readerMap');
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('readerMap');
    // Now change an upstream arc field the readerMap depends on.
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'CHANGED spine', summary: 'sum', readerMap: { hooks: [{ label: 'h' }] } },
    });
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('readerMap');
  });

  it('does not flag unlocked steps as stale', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'a', summary: 'b' } });
    const view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toEqual([]);
  });

  it('flags a locked universeAesthetic stale when the idea step re-runs with a new starterPrompt', async () => {
    // Regression for the codex review finding: universeAesthetic's upstream
    // hash must track universe.starterPrompt (an idea-step OUTPUT that the
    // aesthetic expand reads), not just session.seedIdea. Without this,
    // re-running idea expand with the same seed but a non-deterministic LLM
    // result silently keeps a locked aesthetic step un-flagged.
    const s = await sb.createStorySession({ title: 'X', seedIdea: 'seed' });
    await universeSvc.updateUniverse(s.universeId, { starterPrompt: 'starter v1' });
    await sb.lockStep(s.id, 'universeAesthetic');
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('universeAesthetic');
    // Mutate starterPrompt — same seedIdea but a fresh expansion.
    await universeSvc.updateUniverse(s.universeId, { starterPrompt: 'starter v2' });
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('universeAesthetic');
  });
});

describe('storyBuilder — generate delegation', () => {
  it('generateStep(plotArc) persists the arc onto the series', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'arc logline', summary: 'arc summary', shape: 'man-in-hole', seasonOutlines: [] },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    await sb.generateStep(s.id, 'plotArc');
    const series = await seriesSvc.getSeries(s.seriesId);
    expect(series.arc.logline).toBe('arc logline');
    expect(series.arc.shape).toBe('man-in-hole');
  });

  it('generateStep(readerMap) works even after the plot arc is locked', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'spine', summary: 'sum' } });
    await sb.lockStep(s.id, 'plotArc'); // sets series.locked.arc = true
    stageRunnerSpy = vi.fn(async () => ({
      content: { hooks: [{ label: 'why?' }], payoffs: [], beats: [], cliffhangers: [] },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    await sb.generateStep(s.id, 'readerMap');
    const series = await seriesSvc.getSeries(s.seriesId);
    expect(series.arc.readerMap.hooks[0].label).toBe('why?');
    // The locked arc core fields are untouched.
    expect(series.arc.logline).toBe('spine');
    expect(series.locked.arc).toBe(true);
  });

  it('defaults the provider/model from session.llm when no per-call override is given', async () => {
    const s = await sb.createStorySession({ title: 'X', llm: { provider: 'prov-x', model: 'model-y' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'al', summary: 'as', seasonOutlines: [] }, runId: 'r', providerId: 'p', model: 'm',
    }));
    await sb.generateStep(s.id, 'plotArc'); // no options → must fall back to session.llm
    // arcPlanner forwards the resolved override into runStagedLLM's options.
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      expect.any(String), expect.any(Object),
      expect.objectContaining({ providerOverride: 'prov-x', modelOverride: 'model-y' }),
    );
  });

  it('an explicit per-call provider override beats session.llm', async () => {
    const s = await sb.createStorySession({ title: 'X', llm: { provider: 'prov-x', model: 'model-y' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'al', summary: 'as', seasonOutlines: [] }, runId: 'r', providerId: 'p', model: 'm',
    }));
    await sb.generateStep(s.id, 'plotArc', { providerId: 'override-z', model: 'override-m' });
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      expect.any(String), expect.any(Object),
      expect.objectContaining({ providerOverride: 'override-z', modelOverride: 'override-m' }),
    );
  });

  it('generateStep(idea) skips writing a locked universe.logline', async () => {
    // Regression for the codex review finding: locking the aesthetic step
    // sets universe.locked.{logline,premise,...}=true, but updateUniverse
    // doesn't enforce those locks on scalar writes — so a re-run of the
    // idea step would otherwise silently clobber the locked logline.
    const s = await sb.createStorySession({ title: 'X', seedIdea: 'seed' });
    await universeSvc.updateUniverse(s.universeId, {
      logline: 'frozen logline',
      locked: { logline: true },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { expandedIdea: 'new starter prose', logline: 'replacement logline that must NOT land' },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    await sb.generateStep(s.id, 'idea');
    const universe = await universeSvc.getUniverse(s.universeId);
    expect(universe.logline).toBe('frozen logline');
    // starterPrompt is NOT locked by the aesthetic step's keys, so this DID land.
    expect(universe.starterPrompt).toBe('new starter prose');
  });
});

describe('generateStep backfill (fromDownstream)', () => {
  // Record the stage + vars of the most recent staged-LLM call so a test can
  // assert which prompt a backfill routed through.
  let seenStage;
  let seenVars;
  function installSpy() {
    seenStage = null; seenVars = null;
    stageRunnerSpy = async (stage, vars) => {
      seenStage = stage; seenVars = vars;
      let content = {};
      if (stage === 'story-builder-idea-expand') content = { title: 'T', logline: 'L', expandedIdea: 'E' };
      else if (stage === 'importer-arc-extract') {
        content = {
          logline: 'Backfilled arc logline', summary: 'Backfilled summary',
          protagonistArc: 'grows', themes: ['legacy'], shape: 'man-in-hole',
          seasons: [{ number: 1, title: 'Vol 1', logline: 'v1', synopsis: 's1', endingHook: 'hook' }],
        };
      } else if (stage === 'pipeline-arc-overview') {
        content = {
          logline: 'Forward arc logline', summary: 'Forward summary',
          protagonistArc: 'grows', themes: ['legacy'], shape: 'man-in-hole',
          seasonOutlines: [{ number: 1, title: 'Vol 1', episodeCountTarget: 6 }],
        };
      }
      return { content, runId: 'run-x', providerId: 'p', model: 'm' };
    };
  }

  // A seed session mints its own universe + series; attach a drafted comic
  // script to one issue, mirroring the "started from a drafted comic" case.
  async function makeSessionWithDraftedIssue() {
    const s = await sb.createStorySession({ title: 'Backfill' });
    const issue = await issuesSvc.createIssue({ seriesId: s.seriesId, title: 'Issue One' });
    await issuesSvc.updateStage(issue.id, 'comicScript', { status: 'ready', output: 'PAGE 1 ... a drafted comic script ...' });
    return { session: s, issue };
  }

  it('plotArc backfill extracts the arc from issue content via importer-arc-extract', async () => {
    installSpy();
    const { session } = await makeSessionWithDraftedIssue();
    const res = await sb.generateStep(session.id, 'plotArc', { fromDownstream: true });
    expect(seenStage).toBe('importer-arc-extract');
    expect(seenVars.source).toContain('drafted comic script');
    const updated = await seriesSvc.getSeries(session.seriesId);
    expect(updated.arc?.logline).toBe('Backfilled arc logline');
    expect(updated.seasons?.length).toBe(1);
    expect(updated.seasons[0].synopsis).toBe('s1');
    expect(res.runId).toBe('run-x');
  });

  it('plotArc forward path still uses pipeline-arc-overview (no fromDownstream)', async () => {
    installSpy();
    const { session } = await makeSessionWithDraftedIssue();
    await sb.generateStep(session.id, 'plotArc', {});
    expect(seenStage).toBe('pipeline-arc-overview');
  });

  it('plotArc backfill refuses when no issue has content', async () => {
    installSpy();
    const s = await sb.createStorySession({ title: 'Empty' });
    await expect(sb.generateStep(s.id, 'plotArc', { fromDownstream: true }))
      .rejects.toThrow(/No issue content/);
  });

  it('idea backfill feeds issue content into the idea-expand prompt', async () => {
    installSpy();
    const { session } = await makeSessionWithDraftedIssue();
    await sb.generateStep(session.id, 'idea', { fromDownstream: true });
    expect(seenStage).toBe('story-builder-idea-expand');
    expect(seenVars.sourceMaterial).toContain('drafted comic script');
  });

  it('idea forward path sends an empty sourceMaterial', async () => {
    installSpy();
    const { session } = await makeSessionWithDraftedIssue();
    await sb.generateStep(session.id, 'idea', {});
    expect(seenStage).toBe('story-builder-idea-expand');
    expect(seenVars.sourceMaterial).toBe('');
  });

  it('idea backfill refuses when no issue has content', async () => {
    installSpy();
    const s = await sb.createStorySession({ title: 'Empty' });
    await expect(sb.generateStep(s.id, 'idea', { fromDownstream: true }))
      .rejects.toThrow(/No issue content/);
  });
});

describe('generateIssuesFromArc (issues step)', () => {
  // Attach one or more seasons to a freshly-minted seed session's series and
  // return the persisted season ids (sanitizer may re-mint them).
  async function seedSeasons(seriesId, seasons) {
    await seriesSvc.updateSeries(seriesId, { seasons });
    const series = await seriesSvc.getSeries(seriesId);
    return series.seasons;
  }

  // The season-episodes LLM pass returns `{ episodes: [...] }`; shapeEpisodes
  // keeps title + number + arcRole + lengthProfile + logline/synopsis.
  function episodesSpy(episodesBySeasonTitle) {
    stageRunnerSpy = vi.fn(async (stage, vars) => {
      if (stage !== 'pipeline-season-episodes') return { content: {}, runId: 'r', providerId: 'p', model: 'm' };
      const episodes = episodesBySeasonTitle[vars?.season?.title] || [];
      return { content: { episodes }, runId: 'r', providerId: 'p', model: 'm' };
    });
  }

  it('creates one issue per episode for every season and seeds idea input', async () => {
    const s = await sb.createStorySession({ title: 'Arc Seed' });
    const seasons = await seedSeasons(s.seriesId, [
      { number: 1, title: 'Vol 1', synopsis: 'foundry goes silent' },
    ]);
    episodesSpy({
      'Vol 1': [
        { number: 1, title: 'Pilot', logline: 'it begins', synopsis: 'cold open', arcRole: 'pilot', lengthProfile: 'standard' },
        { number: 2, title: 'Complication', logline: 'it worsens', synopsis: '', arcRole: 'complication' },
      ],
    });
    const res = await sb.generateIssuesFromArc(s.id);
    expect(res.createdIssues).toHaveLength(2);
    expect(res.seasons).toEqual([
      expect.objectContaining({ seasonId: seasons[0].id, created: 2, skipped: false }),
    ]);
    const issues = await issuesSvc.listIssues({ seriesId: s.seriesId });
    expect(issues.map((i) => i.title).sort()).toEqual(['Complication', 'Pilot']);
    const pilot = issues.find((i) => i.title === 'Pilot');
    expect(pilot.seasonId).toBe(seasons[0].id);
    // logline + synopsis land in stages.idea.input; status is 'edited' when a
    // synopsis exists, 'empty' otherwise.
    expect(pilot.stages.idea.input).toBe('it begins\n\ncold open');
    expect(pilot.stages.idea.status).toBe('edited');
    const comp = issues.find((i) => i.title === 'Complication');
    expect(comp.stages.idea.status).toBe('empty');
    expect(comp.stages.idea.input).toBe('it worsens');
  });

  it('skips a locked season but still seeds the eligible ones (partial batch)', async () => {
    const s = await sb.createStorySession({ title: 'Partial' });
    const seasons = await seedSeasons(s.seriesId, [
      { number: 1, title: 'Vol 1', synopsis: 'open', locked: true },
      { number: 2, title: 'Vol 2', synopsis: 'rises' },
    ]);
    episodesSpy({ 'Vol 2': [{ number: 1, title: 'V2 E1', arcRole: 'pilot' }] });
    const res = await sb.generateIssuesFromArc(s.id);
    expect(res.createdIssues).toHaveLength(1);
    const locked = res.seasons.find((r) => r.seasonId === seasons[0].id);
    const open = res.seasons.find((r) => r.seasonId === seasons[1].id);
    // A locked season is an ineligible-config skip, not a failure.
    expect(locked).toMatchObject({ skipped: true, failed: false, created: 0 });
    expect(locked.reason).toMatch(/locked/i);
    expect(open).toMatchObject({ skipped: false, failed: false, created: 1 });
  });

  it('reports a transient provider/LLM error as failed (not skipped)', async () => {
    const s = await sb.createStorySession({ title: 'Flaky' });
    const seasons = await seedSeasons(s.seriesId, [
      { number: 1, title: 'Vol 1', synopsis: 'open' },
      { number: 2, title: 'Vol 2', synopsis: 'rises' },
    ]);
    // Vol 1's episodes pass throws a plain (non-validation) error — provider
    // down / timeout. Vol 2 succeeds. The batch must not abort, and Vol 1 must
    // be `failed`, not `skipped`.
    stageRunnerSpy = vi.fn(async (stage, vars) => {
      if (vars?.season?.title === 'Vol 1') throw new Error('provider unavailable');
      return { content: { episodes: [{ number: 1, title: 'V2 E1', arcRole: 'pilot' }] }, runId: 'r', providerId: 'p', model: 'm' };
    });
    const res = await sb.generateIssuesFromArc(s.id);
    expect(res.createdIssues).toHaveLength(1);
    const bad = res.seasons.find((r) => r.seasonId === seasons[0].id);
    const good = res.seasons.find((r) => r.seasonId === seasons[1].id);
    expect(bad).toMatchObject({ skipped: false, failed: true, created: 0 });
    expect(bad.reason).toMatch(/provider unavailable/);
    expect(good).toMatchObject({ skipped: false, failed: false, created: 1 });
  });

  it('scopes to a single season when seasonId is given', async () => {
    const s = await sb.createStorySession({ title: 'Scoped' });
    const seasons = await seedSeasons(s.seriesId, [
      { number: 1, title: 'Vol 1', synopsis: 'a' },
      { number: 2, title: 'Vol 2', synopsis: 'b' },
    ]);
    episodesSpy({
      'Vol 1': [{ number: 1, title: 'V1 E1', arcRole: 'pilot' }],
      'Vol 2': [{ number: 1, title: 'V2 E1', arcRole: 'pilot' }],
    });
    const res = await sb.generateIssuesFromArc(s.id, { seasonId: seasons[1].id });
    expect(res.seasons).toHaveLength(1);
    expect(res.seasons[0].seasonId).toBe(seasons[1].id);
    const issues = await issuesSvc.listIssues({ seriesId: s.seriesId });
    expect(issues.map((i) => i.title)).toEqual(['V2 E1']);
  });

  it('forwards the session.llm provider/model into the episodes pass', async () => {
    const s = await sb.createStorySession({ title: 'LLM', llm: { provider: 'prov-x', model: 'model-y' } });
    await seedSeasons(s.seriesId, [{ number: 1, title: 'Vol 1', synopsis: 'a' }]);
    episodesSpy({ 'Vol 1': [{ number: 1, title: 'E1', arcRole: 'pilot' }] });
    await sb.generateIssuesFromArc(s.id);
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      'pipeline-season-episodes', expect.any(Object),
      expect.objectContaining({ providerOverride: 'prov-x', modelOverride: 'model-y' }),
    );
  });

  it('throws when the series has no seasons yet', async () => {
    const s = await sb.createStorySession({ title: 'No Seasons' });
    await expect(sb.generateIssuesFromArc(s.id)).rejects.toMatchObject({ code: sb.ERR_VALIDATION });
  });

  it('throws when the scoped seasonId is unknown', async () => {
    const s = await sb.createStorySession({ title: 'Bad Season' });
    await seedSeasons(s.seriesId, [{ number: 1, title: 'Vol 1', synopsis: 'a' }]);
    await expect(sb.generateIssuesFromArc(s.id, { seasonId: 'season-nope' }))
      .rejects.toMatchObject({ code: sb.ERR_VALIDATION });
  });
});
