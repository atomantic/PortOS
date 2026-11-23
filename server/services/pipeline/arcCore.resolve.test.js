import { readFileSync } from 'fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();
let stageRunnerSpy;

vi.mock('../../lib/fileUtils.js', () => ({
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

// Stub the staged-LLM runner so the test owns the LLM response shape.
// Each test sets `stageRunnerSpy = vi.fn(...)` to control what comes back.
vi.mock('../stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
  // Large window so completeness runs as a single call (mode: 'whole').
  resolveStageContext: vi.fn(() => Promise.resolve({ provider: { id: 'p' }, model: 'm', contextWindow: 1_000_000 })),
}));

const seriesSvc = await import('./series.js');
const issuesSvc = await import('./issues.js');
const seasonsSvc = await import('./seasons.js');
const planner = await import('./arcPlanner.js');

async function setupSeries(overrides = {}) {
  return seriesSvc.createSeries({
    name: 'Salt Run',
    logline: 'A foundry city goes silent.',
    premise: 'Long-form premise.',
    styleNotes: 'moebius linework',
    issueCountTarget: 24,
    ...overrides,
  });
}

describe('arcPlanner — resolveVerifyIssues', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('throws 400 NO_ARC if the series has no arc to resolve', async () => {
    const s = await setupSeries();
    await expect(planner.resolveVerifyIssues(s.id, { findings: [{ problem: 'X' }] }))
      .rejects.toMatchObject({ status: 400, code: 'PIPELINE_NO_ARC' });
  });

  it('persists the LLM-patched arc + seasons and preserves existing season ids', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'old logline', summary: 'old summary' } });
    const existingSeason = await seasonsSvc.createSeason(s.id, {
      title: 'Season 1',
      logline: 'old s1 logline',
      synopsis: 'old s1 synopsis',
      episodeCountTarget: 4,
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'new logline', summary: 'new summary', themes: ['legacy'], protagonistArc: 'arc' },
        seasons: [
          {
            id: existingSeason.id,
            number: 1,
            title: 'Season 1',
            logline: 'new s1 logline',
            synopsis: 'new s1 synopsis',
            endingHook: 'hook',
            episodeCountTarget: 12,
          },
        ],
        notes: '',
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'count vs weight', suggestion: 'raise count' }],
    });

    expect(out.applied).toBe(true);
    expect(out.series.arc.logline).toBe('new logline');
    expect(out.series.seasons).toHaveLength(1);
    expect(out.series.seasons[0].id).toBe(existingSeason.id); // id preserved
    expect(out.series.seasons[0].episodeCountTarget).toBe(12);
    expect(out.series.seasons[0].logline).toBe('new s1 logline');

    const call = stageRunnerSpy.mock.calls[0];
    expect(call[0]).toBe('pipeline-arc-resolve');
    expect(call[1]).toMatchObject({
      findingsJson: expect.stringContaining('count vs weight'),
      recommendedStructure: expect.any(String),
    });
  });

  it('applies exact long-text edits without accepting a wholesale synopsis rewrite', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: {
        logline: 'old logline',
        summary: 'Opening stays. The route opens before consent. Finale stays.',
        protagonistArc: 'They begin afraid. They end accountable.',
      },
    });
    const existingSeason = await seasonsSvc.createSeason(s.id, {
      title: 'Season 1',
      synopsis: 'Issue one stays. Ledger D opens before the vote. Issue three stays.',
      endingHook: 'The old charter remains active.',
      episodeCountTarget: 3,
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        arc: {
          resolves: ['f1'],
          summary: 'WHOLESALE ARC REWRITE MUST BE IGNORED',
          summaryEdits: [{
            find: 'The route opens before consent.',
            replace: 'The route opens only after affected delegates consent.',
          }],
        },
        seasons: [{
          resolves: ['f1'],
          id: existingSeason.id,
          synopsis: 'WHOLESALE VOLUME REWRITE MUST BE IGNORED',
          synopsisEdits: [{
            find: 'Ledger D opens before the vote.',
            replace: 'Ledger D remains dark until the vote passes.',
          }],
          endingHookEdits: [{
            find: 'The old charter remains active.',
            replace: 'The old charter lapses when the crossing begins.',
          }],
        }],
        notes: '',
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'The crossing precedes consent.', suggestion: 'Move consent first.' }],
    });

    expect(out.series.arc.summary).toBe(
      'Opening stays. The route opens only after affected delegates consent. Finale stays.',
    );
    expect(out.series.arc.protagonistArc).toBe('They begin afraid. They end accountable.');
    expect(out.series.seasons[0].synopsis).toBe(
      'Issue one stays. Ledger D remains dark until the vote passes. Issue three stays.',
    );
    expect(out.series.seasons[0].endingHook).toBe(
      'The old charter lapses when the crossing begins.',
    );
    const budgets = JSON.parse(stageRunnerSpy.mock.calls[0][1].textBudgetsJson);
    expect(budgets.seasons[0].endingHook).toEqual({
      current: 'The old charter remains active.'.length,
      max: 1000,
      remaining: 1000 - 'The old charter remains active.'.length,
    });
  });

  // Transition labels cap at 200 and the sanitizer CLIPS an overrun instead of
  // rejecting it, so a resolver writing blind lands a half-clause milestone that
  // the next spine round reports as an incomplete record — the budget block is
  // what tells it the cap it is actually measured against.
  it('publishes per-transition character-arc budgets to the resolve prompt', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'seed', summary: 'The queue claim changes hands.', status: 'draft' },
      characterArcs: [{
        characterId: 'chr-11111111-2222-3333-4444-555555555555',
        characterName: 'Queue broker',
        want: 'To keep the queue claim.',
        transitions: [{
          id: 'trn-11111111-2222-3333-4444-555555555555',
          kind: 'point-of-no-return',
          atIssue: 14,
          label: 'Escrows the proceeds with no lien.',
          note: 'The queue claim passes to the coalition.',
        }],
      }],
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: { notes: '' }, runId: 'r1', providerId: 'p', model: 'm',
    }));
    await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'milestone is incomplete', suggestion: 'complete it' }],
    });

    const budgets = JSON.parse(stageRunnerSpy.mock.calls[0][1].textBudgetsJson);
    expect(budgets.characterArcs).toHaveLength(1);
    const [arcBudget] = budgets.characterArcs;
    expect(arcBudget.characterId).toBe('chr-11111111-2222-3333-4444-555555555555');
    expect(arcBudget.want).toEqual({
      current: 'To keep the queue claim.'.length,
      max: 1000,
      remaining: 1000 - 'To keep the queue claim.'.length,
    });
    expect(arcBudget.transitions[0]).toEqual({
      id: 'trn-11111111-2222-3333-4444-555555555555',
      atIssue: 14,
      label: {
        current: 'Escrows the proceeds with no lien.'.length,
        max: 200,
        remaining: 200 - 'Escrows the proceeds with no lien.'.length,
      },
      note: {
        current: 'The queue claim passes to the coalition.'.length,
        max: 1000,
        remaining: 1000 - 'The queue claim passes to the coalition.'.length,
      },
    });
  });

  it('rejects ambiguous, whole-field, and over-limit exact text edits', () => {
    expect(planner.applyExactTextEdits(
      'repeat here; repeat here',
      [{ find: 'repeat here', replace: 'changed' }],
      100,
    )).toEqual({ value: 'repeat here; repeat here', applied: 0, rejected: 1 });

    expect(planner.applyExactTextEdits(
      'the complete field',
      [{ find: 'the complete field', replace: 'wholesale replacement' }],
      8000,
    )).toEqual({ value: 'the complete field', applied: 0, rejected: 1 });

    expect(planner.applyExactTextEdits(
      'short anchor',
      [{ find: 'anchor', replace: 'a replacement that exceeds the cap' }],
      20,
    )).toEqual({ value: 'short anchor', applied: 0, rejected: 1 });
  });

  it('reports an over-limit exact-only response as not applied', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const originalHook = `${'x'.repeat(980)} target`;
    const season = await seasonsSvc.createSeason(s.id, {
      number: 1,
      title: 'Vol 1',
      synopsis: 'The volume remains unchanged.',
      endingHook: originalHook,
      episodeCountTarget: 1,
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{
          resolves: ['f1'],
          id: season.id,
          endingHookEdits: [{
            find: 'target',
            replace: 'a much longer replacement that cannot fit inside the field cap',
          }],
        }],
      },
      runId: 'r-over-limit', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'Fix the hook.', suggestion: 'Use the right legal state.' }],
    });

    expect(out.applied).toBe(false);
    expect(out.rejectedExactEdits).toBe(1);
    expect(out.series.seasons[0].endingHook).toBe(originalHook);
    // Categorical, so the stall diagnosis can tell a patch whose anchors no
    // longer match from a resolver that declined to propose anything.
    expect(out.noChangeReason).toBe('exact-edits-rejected');
    expect(out.mutations).toEqual({ arcFieldsEdited: 0, volumesEdited: 0, characterArcsEdited: 0, episodesEdited: 0 });
  });

  it('persists the complete repair when later compression brings the field under its cap', async () => {
    const s = await setupSeries();
    const padding = 'x'.repeat(7960);
    const summary = `Old motive. ${padding} Redundant explanation.`;
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L', summary } });
    const replacement = 'A costly choice earns the rescue.';
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        arc: {
          resolves: ['f1'],
          summaryEdits: [
            { find: 'Old motive.', replace: replacement },
            { find: ' Redundant explanation.', replace: '' },
          ],
        },
      },
      runId: 'r-net-fitting', providerId: 'p', model: 'm',
    }));
    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ id: 'f1', severity: 'medium', problem: 'The rescue is unearned.' }],
    });
    expect(out).toMatchObject({ applied: true, rejectedExactEdits: 0 });
    expect((await seriesSvc.getSeries(s.id)).arc.summary).toBe(`${replacement} ${padding}`);
  });

  it('preserves the whole field when the final replacement set still exceeds the cap', () => {
    expect(planner.applyExactTextEdits('first and second', [
      { find: 'first', replace: 'a larger first choice' },
      { find: 'second', replace: 'last' },
    ], 20)).toEqual({ value: 'first and second', applied: 0, rejected: 2 });
  });

  it('counts what a spine-scope resolve wrote, per record kind (#3843)', async () => {
    // An arc-spine resolver may not touch episodes at all, so `episodesEdited`
    // is 0 on every one of its rounds — the gate reported that alone and a
    // round that rewrote the arc and two volumes read as a no-op.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'old logline', summary: 'old summary' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Vol 1', synopsis: 'v1 old', episodeCountTarget: 3 });
    const v2 = await seasonsSvc.createSeason(s.id, { number: 2, title: 'Vol 2', synopsis: 'v2 old', episodeCountTarget: 3 });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { resolves: ['f1'], logline: 'old logline', summary: 'new summary' },
        seasons: [
          { resolves: ['f1'], id: v1.id, synopsis: 'v1 new' },
          { resolves: ['f1'], id: v2.id, synopsis: 'v2 new' },
        ],
        notes: '',
      },
      runId: 'r-spine', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      spineOnly: true,
      findings: [{ id: 'f1', severity: 'high', problem: 'the vow is never paid off', suggestion: 'pay it off in V2' }],
    });

    expect(out.applied).toBe(true);
    // One arc field moved (`summary`); `logline` came back identical and is not
    // counted as a rewrite.
    expect(out.mutations).toEqual({ arcFieldsEdited: 1, volumesEdited: 2, characterArcsEdited: 0, episodesEdited: 0 });
    expect(out.noChangeReason).toBeNull();
  });

  it('names the reason when a spine resolve answers with episode edits it may not apply (#3843)', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Vol 1', episodeCountTarget: 1 });
    await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Pilot' });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        episodes: [{ resolves: ['f1'], seasonNumber: 1, episodeNumber: 1, synopsis: 'a rewritten synopsis' }],
        notes: '',
      },
      runId: 'r-out-of-scope', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      spineOnly: true,
      findings: [{ id: 'f1', severity: 'high', problem: 'the pilot contradicts the volume', suggestion: 'fix it' }],
    });

    expect(out.applied).toBe(false);
    // Not "the resolver did nothing" — it answered at an altitude this gate
    // forbids, which is a different defect with a different fix.
    expect(out.noChangeReason).toBe('edits-out-of-scope');
  });

  it('documents every no-change reason in the prompts that are handed one (#3843)', () => {
    // The reasons only earn their keep if the diagnosis can read them. A value
    // the legend never explains reaches the model as an unglossed token, which
    // is the misreading this telemetry exists to end.
    const legends = ['pipeline-observer.md', 'pipeline-self-improve.md'].map((file) => readFileSync(
      new URL(`../../../data.reference/prompts/stages/${file}`, import.meta.url),
      'utf8',
    ));
    for (const reason of planner.RESOLVE_NO_CHANGE_REASONS) {
      for (const legend of legends) expect(legend).toContain(`\`${reason}\``);
    }
  });

  it('reports a resolver that proposed nothing at all as a content-level refusal (#3843)', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { notes: 'I cannot resolve this without inventing canon.' },
      runId: 'r-refusal', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ id: 'f1', severity: 'high', problem: 'the vow is never paid off', suggestion: 'pay it off' }],
    });

    expect(out.applied).toBe(false);
    expect(out.noChangeReason).toBe('no-edits-returned');
  });

  it('re-runs verify when no findings are supplied and short-circuits on a clean arc', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    // First call (from verify) returns no issues — resolve should short-circuit
    // without making a second LLM call.
    stageRunnerSpy = vi.fn(async () => ({
      content: { issues: [] },
      runId: 'verify-r', providerId: 'p', model: 'm',
    }));
    const out = await planner.resolveVerifyIssues(s.id, {});
    expect(out.applied).toBe(false);
    expect(out.notes).toMatch(/no findings/i);
    expect(stageRunnerSpy).toHaveBeenCalledTimes(1);
    expect(stageRunnerSpy.mock.calls[0][0]).toBe('pipeline-arc-verify');
  });

  it('rewrites title-matched seasons in place when the LLM omits their ids', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const oldS1 = await seasonsSvc.createSeason(s.id, { title: 'The Velvet Pouch', episodeCountTarget: 3 });
    const oldS2 = await seasonsSvc.createSeason(s.id, { title: 'Six Blocks Down', episodeCountTarget: 3 });
    const oldS3 = await seasonsSvc.createSeason(s.id, { title: 'The City Looks Back', episodeCountTarget: 3 });

    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS1.id, title: 'Pilot' });
    const i2 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS2.id, title: 'Middle' });
    const i3 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS3.id, title: 'Finale' });

    // LLM returns seasons by title without preserving ids. These are rewrites
    // of the existing volumes, not new ones — `matchProposedSeasons` must land
    // them on the existing records rather than minting title-alike siblings.
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [
          { number: 1, title: 'The Velvet Pouch', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3 },
          { number: 2, title: 'Six Blocks Down', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3 },
          { number: 3, title: 'The City Looks Back', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3 },
        ],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'X', suggestion: 'Y' }],
    });

    expect(out.applied).toBe(true);
    expect(out.series.seasons).toHaveLength(3);
    const [newS1, newS2, newS3] = out.series.seasons;
    // Rewritten in place — no mint, so nothing to remap and no duplicate
    // "Volume 1" left behind.
    expect([newS1.id, newS2.id, newS3.id]).toEqual([oldS1.id, oldS2.id, oldS3.id]);

    const finalI1 = await issuesSvc.getIssue(i1.id);
    const finalI2 = await issuesSvc.getIssue(i2.id);
    const finalI3 = await issuesSvc.getIssue(i3.id);
    expect(finalI1.seasonId).toBe(newS1.id);
    expect(finalI2.seasonId).toBe(newS2.id);
    expect(finalI3.seasonId).toBe(newS3.id);
  });

  it('does not mint a duplicate volume across repeated unlock-for-run resolves', async () => {
    // The divergence regression: the autopilot's unlock-for-run mode passes
    // `preserveDroppedSeasons`, so a minted look-alike volume gets the original
    // re-inserted next to it. Two rounds used to leave three Volume 1 records —
    // a blocking arc-verify finding that no further round could clear.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Salt at the Root', episodeCountTarget: 12 });
    const ep = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Ep 1' });

    let round = 0;
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        // Same volume, rewritten synopsis, id omitted — verbatim the shape the
        // resolve prompt returns.
        seasons: [{ number: 1, title: 'Salt at the Root', synopsis: `revision ${++round}`, endingHook: '', episodeCountTarget: 12 }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    for (let i = 0; i < 2; i += 1) {
      await planner.resolveVerifyIssues(s.id, {
        findings: [{ severity: 'high', problem: 'X', suggestion: 'Y' }],
        preserveDroppedSeasons: true,
      });
    }

    const after = await seriesSvc.getSeries(s.id);
    expect(after.seasons).toHaveLength(1);
    expect(after.seasons[0].id).toBe(v1.id);
    expect(after.seasons[0].synopsis).toBe('revision 2'); // the rewrite still applied
    expect((await issuesSvc.getIssue(ep.id)).seasonId).toBe(v1.id);
  });

  it('treats an empty seasons[] as a no-op, not a volume wipe (#3724 sparse patch)', async () => {
    // `seasons[]` is a SPARSE patch list: a resolve round that edits nothing at
    // the volume level leaves the lineup — and every episode under it — alone.
    // Before #3724 this same response deleted the only volume and dropped its
    // issue into the ungrouped bucket.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const oldS = await seasonsSvc.createSeason(s.id, { title: 'Only Season', episodeCountTarget: 3 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS.id, title: 'Orphan' });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { resolves: ['f1'], logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [],
        notes: 'recommend collapsing Only Season — not doing it here',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'X', suggestion: 'Y' }],
    });

    expect(out.series.arc.logline).toBe('L2'); // the targeted arc edit still lands
    expect(out.series.seasons.map((x) => x.id)).toEqual([oldS.id]);
    expect((await issuesSvc.getIssue(i1.id)).seasonId).toBe(oldS.id);
  });

  it('leaves volumes the response omits exactly as they are', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Vol 1', synopsis: 'v1 original', episodeCountTarget: 3 });
    const v2 = await seasonsSvc.createSeason(s.id, { number: 2, title: 'Vol 2', synopsis: 'v2 original', episodeCountTarget: 3 });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { resolves: ['f1'], logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        // Only volume 2 was edited — volume 1 isn't in the response at all.
        seasons: [{ resolves: ['f1'], id: v2.id, number: 2, title: 'Vol 2', synopsis: 'v2 rewritten' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'volume 2 drops the mentor', suggestion: 'pay it off' }],
    });

    expect(out.series.seasons.map((x) => x.id)).toEqual([v1.id, v2.id]);
    expect(out.series.seasons[0].synopsis).toBe('v1 original'); // untouched
    expect(out.series.seasons[1].synopsis).toBe('v2 rewritten');
  });

  it('applies sparse character-arc and transition patches without replacing IDs or sibling arcs', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'L' },
      characterArcs: [
        {
          characterId: 'chr-lead', characterName: 'Lead', want: 'escape', need: 'trust',
          startState: 'guarded', endState: 'open', status: 'verified',
          transitions: [
            { id: 'trn-choice', kind: 'decision', atIssue: 5, label: 'withholds consent', note: 'old note' },
            { id: 'trn-sacrifice', kind: 'sacrifice', atIssue: 11, label: 'spends the reserve', note: '' },
          ],
        },
        {
          characterId: 'chr-sibling', characterName: 'Sibling', want: 'belong', need: 'choose',
          startState: 'adrift', endState: 'committed', transitions: [],
        },
      ],
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        characterArcs: [{
          resolves: ['f1'],
          characterId: 'chr-lead',
          transitions: [{ id: 'trn-sacrifice', atIssue: 12, label: 'freely authorizes the final opening' }],
        }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'The sacrifice is assigned to issue 11.', suggestion: 'Move it to 12.' }],
      spineOnly: true,
    });

    expect(out.series.characterArcs).toHaveLength(2);
    const [lead, sibling] = out.series.characterArcs;
    expect(lead).toMatchObject({ characterId: 'chr-lead', want: 'escape', need: 'trust', status: 'verified' });
    expect(lead.transitions).toEqual([
      expect.objectContaining({ id: 'trn-choice', atIssue: 5, label: 'withholds consent', note: 'old note' }),
      expect.objectContaining({ id: 'trn-sacrifice', atIssue: 12, label: 'freely authorizes the final opening', kind: 'sacrifice' }),
    ]);
    expect(sibling).toMatchObject({ characterId: 'chr-sibling', startState: 'adrift', endState: 'committed' });
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(JSON.parse(ctx.characterArcsJson)[0].transitions[1].id).toBe('trn-sacrifice');
  });

  it('drops arc / volume / episode edits that name no input finding', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L', summary: 'original summary' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Vol 1', synopsis: 'v1 original', episodeCountTarget: 2 });
    const v2 = await seasonsSvc.createSeason(s.id, { number: 2, title: 'Vol 2', synopsis: 'v2 original', episodeCountTarget: 2 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'ep original', status: 'empty' });
    const fresh = await issuesSvc.getIssue(issue.id);

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        // Untargeted arc rewrite — dropped. `resolves` naming an id the round
        // never handed out counts as naming nothing.
        arc: { resolves: ['f9'], logline: 'HIJACKED', summary: 'HIJACKED', themes: [], protagonistArc: '' },
        seasons: [
          { resolves: ['f1'], id: v1.id, number: 1, title: 'Vol 1', synopsis: 'v1 rewritten' },
          { resolves: [], id: v2.id, number: 2, title: 'Vol 2', synopsis: 'v2 collateral rewrite' },
        ],
        episodes: [{ seasonNumber: 1, episodeNumber: fresh.number, synopsis: 'ep collateral rewrite' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'volume 1 stages the eclipse twice', suggestion: 'fix' }],
    });

    expect(out.series.arc.logline).toBe('L');
    expect(out.series.arc.summary).toBe('original summary');
    expect(out.series.seasons[0].synopsis).toBe('v1 rewritten'); // the one targeted edit lands
    expect(out.series.seasons[1].synopsis).toBe('v2 original');
    expect(out.episodesResolved).toEqual([]);
    expect((await issuesSvc.getIssue(issue.id)).stages.idea.input).toBe('ep original');
  });

  it('applies an unkeyed response as a legacy patch (install still on the pre-#3724 prompt)', async () => {
    // A customized `pipeline-arc-resolve.md` never gets migration 245, so its
    // model can't know about `resolves`. Dropping everything would silently turn
    // auto-resolve into a round-burning no-op — those responses apply unkeyed,
    // still under the safer sparse-patch semantics.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Vol 1', synopsis: 'v1 original', episodeCountTarget: 2 });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [{ id: v1.id, number: 1, title: 'Vol 1', synopsis: 'v1 rewritten' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'X', suggestion: 'Y' }],
    });

    expect(out.series.arc.logline).toBe('L2');
    expect(out.series.seasons[0].synopsis).toBe('v1 rewritten');
  });

  it('renders findings into the prompt stamped with stable findingIds', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { arc: { resolves: ['f2'], logline: 'L2', summary: 'S' }, seasons: [], notes: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.resolveVerifyIssues(s.id, {
      findings: [
        { severity: 'high', problem: 'first defect', suggestion: '' },
        { severity: 'high', problem: 'second defect', suggestion: '' },
      ],
    });

    const { findingsJson } = stageRunnerSpy.mock.calls[0][1];
    expect(JSON.parse(findingsJson).map((f) => f.findingId)).toEqual(['f1', 'f2']);
  });

  it('leaves the avoid section out of a first-attempt resolve', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { arc: { resolves: ['f1'], logline: 'L2', summary: 'S' }, seasons: [], notes: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'first defect', suggestion: '' }],
    });

    const ctx = stageRunnerSpy.mock.calls[0][1];
    // False, not "an empty array" — the prompt section is gated on this flag, so
    // a first attempt must render no avoid block rather than an empty one the
    // model has to decide to ignore.
    expect(ctx.hasAvoid).toBe(false);
    expect(JSON.parse(ctx.avoidJson)).toEqual([]);
  });

  it('renders a corrective pass\'s avoid list separately from the findings to close', async () => {
    // The autopilot's arc-verify gate reverts a resolve round that grew the
    // blocking count, then re-runs the resolver from the restored state with the
    // rejected attempt's findings as `avoid`. Those problems are NOT in the plan
    // any more, so they must never leak into `findingsJson` — asking the
    // resolver to close a problem the plan doesn't have is how a corrective pass
    // authors a fresh contradiction.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { arc: { resolves: ['f1'], logline: 'L2', summary: 'S' }, seasons: [], notes: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'first defect', suggestion: 'fix it' }],
      avoid: [
        { severity: 'high', problem: 'the reverted rewrite dropped the mentor payoff', suggestion: '' },
        { problem: 'and split volume 2 in half', location: 'V2' },
      ],
    });

    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.hasAvoid).toBe(true);
    const avoid = JSON.parse(ctx.avoidJson);
    expect(avoid.map((f) => f.problem)).toEqual([
      'the reverted rewrite dropped the mentor payoff',
      'and split volume 2 in half',
    ]);
    // Normalized through the same shaper as the findings — a severity-less entry
    // gets the default rather than riding through as undefined.
    expect(avoid[1]).toMatchObject({ severity: 'medium', location: 'V2' });
    // The avoid entries carry no findingId and never appear as work to close.
    expect(ctx.avoidJson).not.toMatch(/findingId/);
    expect(JSON.parse(ctx.findingsJson).map((f) => f.problem)).toEqual(['first defect']);
  });

  it('preserves series.arc.readerMap when the resolve LLM does not author one', async () => {
    // Regression for the drift between generateArcOverview (which preserves
    // readerMap) and resolveVerifyIssues (which silently wiped it pre-fix).
    const s = await setupSeries();
    const priorReaderMap = {
      hooks: [{ id: 'rm-h-1', label: 'why is the foundry silent', atArcPosition: 0.1, note: '' }],
      payoffs: [],
      beats: [],
      cliffhangers: [],
      status: 'draft',
    };
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'L', summary: 'S', shape: 'man-in-hole', readerMap: priorReaderMap },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        // The resolve prompt doesn't ask the LLM for a reader map — make sure
        // omitting it doesn't wipe the user's existing one.
        arc: { logline: 'L2', summary: 'S2', themes: [], protagonistArc: '' },
        seasons: [],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'X', suggestion: 'Y' }],
    });
    expect(out.applied).toBe(true);
    expect(out.series.arc.logline).toBe('L2');
    // shape and readerMap come from the prior series.arc and must survive.
    expect(out.series.arc.shape).toBe('man-in-hole');
    expect(out.series.arc.readerMap?.hooks?.[0]?.label).toBe('why is the foundry silent');
  });

  // Uniquely catches an arc merge that wipes a stored field the resolve response omits (#14421).
  it('keeps every stored arc field the resolve response omits', async () => {
    const s = await setupSeries();
    const foreshadowing = [{ label: 'A cracked bell', plantIssue: 1, payoffIssue: 3 }];
    const seriesDesign = { mode: 'finite', episodeActivity: 'Investigate the case.', endingCondition: 'Solve the central case.' };
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'L', summary: 'S', themes: ['duty'], protagonistArc: 'Learns to ask for help', shape: 'man-in-hole', foreshadowing, seriesDesign },
    });
    const stored = (await seriesSvc.getSeries(s.id)).arc;
    expect(stored.foreshadowing).toHaveLength(1);
    expect(stored.seriesDesign).toBeTruthy();
    stageRunnerSpy = vi.fn(async () => ({
      content: { arc: { logline: 'L2' }, seasons: [], notes: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.resolveVerifyIssues(s.id, { findings: [{ severity: 'medium', problem: 'X', suggestion: 'Y' }] });
    expect(out.applied).toBe(true);
    expect(out.series.arc).toMatchObject({ logline: 'L2', summary: 'S', themes: ['duty'], protagonistArc: 'Learns to ask for help', shape: 'man-in-hole' });
    expect(out.series.arc.foreshadowing).toEqual(stored.foreshadowing);
    expect(out.series.arc.seriesDesign).toEqual(stored.seriesDesign);
  });

  // Uniquely catches the exact-text tally dropping a rejected summary or protagonist-arc edit (#14421).
  it('counts rejected exact-text edits on both the summary and the protagonist arc', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L', summary: 'The city sleeps.', protagonistArc: 'She stays.' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        arc: {
          resolves: ['f1'],
          summaryEdits: [{ find: 'Not in the summary.', replace: 'x' }],
          protagonistArcEdits: [{ find: 'Not in the arc.', replace: 'y' }],
        },
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.resolveVerifyIssues(s.id, { findings: [{ id: 'f1', severity: 'medium', problem: 'X' }] });
    expect(out.rejectedExactEdits).toBe(2);
  });

  it('preserves series.arc.tickingClock when the resolve LLM does not author one', async () => {
    // Sparse countdown repairs must preserve a clock omitted by the model.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: {
        logline: 'L', summary: 'S', shape: 'man-in-hole',
        tickingClock: { enabled: true, label: 'The dam breaks', kind: 'deadline', stakes: 'town floods' },
      },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S2', themes: [], protagonistArc: '' },
        seasons: [],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'X', suggestion: 'Y' }],
    });
    expect(out.applied).toBe(true);
    expect(out.series.arc.logline).toBe('L2');
    expect(out.series.arc.tickingClock?.enabled).toBe(true);
    expect(out.series.arc.tickingClock?.label).toBe('The dam breaks');
  });

  it.each([false, true])('repairs one countdown reminder by ID and rejects multiple isolated edits (extra=%s)', async (extra) => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'L', tickingClock: {
        enabled: true, label: 'The dam breaks', kind: 'deadline', stakes: 'town floods',
        plantedAtArcPosition: 2, dueAtArcPosition: 10,
        reminders: [{ id: 'rm-first', atIssue: 3, note: '72 hours' }, { id: 'rm-last', atIssue: 9, note: '1 hour' }],
      } },
    });
    const before = (await seriesSvc.getSeries(s.id)).arc.tickingClock;
    stageRunnerSpy = vi.fn(async () => ({
      content: { patchMode: 'exact-text-v1', arc: { resolves: ['f1'], tickingClock: {
        enabled: false, reminders: [
          { id: before.reminders[0].id, atIssue: 6, note: '72 hours; matching stops' },
          { id: 'rm-unmatched', atIssue: 7, note: 'Do not mint this row' },
          ...(extra ? [{ id: before.reminders[1].id, atIssue: 8 }] : []),
        ],
      } } },
      runId: 'r-clock', providerId: 'p', model: 'm',
    }));
    const out = await planner.resolveVerifyIssues(s.id, {
      spineOnly: true, isolated: true,
      findings: [{ severity: 'medium', problem: 'The first reminder precedes the countdown start' }],
    });
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(JSON.parse(ctx.tickingClockJson)).toEqual(before);
    const after = (await seriesSvc.getSeries(s.id)).arc.tickingClock;
    if (extra) {
      expect(out).toMatchObject({ applied: false, noChangeReason: 'isolated-candidate-rejected' });
      expect(after).toEqual(before);
    } else {
      expect(out.applied).toBe(true);
      expect(out.mutations.arcFieldsEdited).toBe(1);
      expect(after).toEqual({ ...before, reminders: [{ ...before.reminders[0], atIssue: 6, note: '72 hours; matching stops' }, before.reminders[1]] });
    }
  });

  it('preserves a disabled countdown when a model patch would erase its last identifying field', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L', tickingClock: { enabled: false, label: 'The dam breaks' } } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { arc: { resolves: ['f1'], tickingClock: { label: '' } } },
      runId: 'r-clock', providerId: 'p', model: 'm',
    }));
    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'Clarify the deadline' }],
    });
    expect(out.applied).toBe(false);
    expect((await seriesSvc.getSeries(s.id)).arc.tickingClock.label).toBe('The dam breaks');
  });

  it('applies episode-synopsis corrections the resolve LLM returns (heals episode-level findings)', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'old synopsis that stages the Atrium', status: 'empty' });
    const fresh = await issuesSvc.getIssue(issue.id);

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [{ id: season.id, number: season.number, title: 'Vol 1', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1 }],
        episodes: [{ seasonNumber: season.number, episodeNumber: fresh.number, synopsis: 'corrected — the Atrium is NOT convened here' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'episode 1 stages the Atrium', suggestion: 'move it' }],
    });

    expect(out.episodesResolved).toHaveLength(1);
    expect(out.episodesResolved[0]).toMatchObject({ issueId: issue.id, number: fresh.number, clearedBeats: false });
    const updated = await issuesSvc.getIssue(issue.id);
    expect(updated.stages.idea.input).toBe('corrected — the Atrium is NOT convened here');
    // The entry doubles as the rollback's mutation manifest: it reports the
    // value this call actually left standing.
    expect(planner.resolvedEpisodeEdits(out)).toEqual([
      { issueId: issue.id, idea: { input: updated.stages.idea.input, output: '', status: updated.stages.idea.status } },
    ]);
  });

  it('repairs episode length and role without rewriting its synopsis, then rolls back both rounds', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'A crew must make a costly choice.' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Volume', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Turn', arcRole: 'b-plot' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'The unchanged story.', output: 'Original beats.', status: 'ready' });
    const before = await issuesSvc.getIssue(issue.id);
    const snapshot = await planner.snapshotArcState(s.id);
    const findings = [{ severity: 'medium', problem: 'The central turn needs an extended issue.' }];
    stageRunnerSpy = vi.fn(async () => ({ content: { episodes: [{
      resolves: ['f1'], seasonNumber: season.number, episodeNumber: before.number,
      arcRole: before.arcRole, lengthProfile: 'custom', pageTarget: 36, minutesTarget: 42,
    }] } }));

    const length = await planner.resolveVerifyIssues(s.id, { findings, isolated: true });
    const extended = await issuesSvc.getIssue(issue.id);
    expect(length.applied).toBe(true);
    expect(extended).toMatchObject({ lengthProfile: 'custom', pageTarget: 36, minutesTarget: 42 });
    expect(extended.stages.idea).toMatchObject({ input: 'The unchanged story.', output: '', status: 'empty' });
    stageRunnerSpy = vi.fn(async () => ({ content: { episodes: [{
      resolves: ['f1'], seasonNumber: season.number, episodeNumber: before.number, arcRole: 'complication',
    }] } }));
    const role = await planner.resolveVerifyIssues(s.id, { findings, isolated: true });
    expect((await issuesSvc.getIssue(issue.id)).arcRole).toBe('complication');

    const restored = await planner.restoreArcState(s.id, snapshot, {
      episodeEdits: [...planner.resolvedEpisodeEdits(length), ...planner.resolvedEpisodeEdits(role)],
    });
    expect(restored.episodesRestored).toBe(1);
    const after = await issuesSvc.getIssue(issue.id);
    expect(after).toMatchObject({ arcRole: before.arcRole, lengthProfile: before.lengthProfile, pageTarget: before.pageTarget, minutesTarget: before.minutesTarget });
    expect(after.stages.idea).toMatchObject({ input: 'The unchanged story.', output: 'Original beats.', status: 'ready' });
  });

  it('keeps a later authored page-count choice when rolling back its own role correction', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'A crew must make a costly choice.' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Volume', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Turn', arcRole: 'b-plot' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'Original synopsis.', output: 'Beats for the original length.', status: 'ready' });
    const snapshot = await planner.snapshotArcState(s.id);
    stageRunnerSpy = vi.fn(async () => ({ content: { episodes: [{
      resolves: ['f1'], seasonNumber: season.number, episodeNumber: issue.number,
      arcRole: 'complication', lengthProfile: 'custom', pageTarget: 36, minutesTarget: 42,
    }] } }));
    const length = await planner.resolveVerifyIssues(s.id, { findings: [{ severity: 'medium', problem: 'Correct the turn length.' }] });
    await issuesSvc.updateIssue(issue.id, { pageTarget: 48 });
    stageRunnerSpy = vi.fn(async () => ({ content: { episodes: [{
      resolves: ['f1'], seasonNumber: season.number, episodeNumber: issue.number, arcRole: 'finale',
    }] } }));
    const role = await planner.resolveVerifyIssues(s.id, { findings: [{ severity: 'medium', problem: 'Correct the turn role.' }] });
    await planner.restoreArcState(s.id, snapshot, {
      episodeEdits: [...planner.resolvedEpisodeEdits(length), ...planner.resolvedEpisodeEdits(role)],
    });
    const restored = await issuesSvc.getIssue(issue.id);
    expect(restored).toMatchObject({ arcRole: 'b-plot', lengthProfile: 'custom', pageTarget: 48, minutesTarget: 42 });
    expect(restored.stages.idea).toMatchObject({ input: 'Original synopsis.', output: '', status: 'empty' });
  });

  it.each(['manuscript', 'page layout', 'back-cover image'])('refuses metadata and accompanying synopsis changes beneath an existing %s', async (production) => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'A crew must make a costly choice.' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Volume', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Turn' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'Established plan.' });
    if (production === 'manuscript') await issuesSvc.updateStage(issue.id, 'prose', { output: 'Existing manuscript.', status: 'ready' });
    else if (production === 'page layout') await issuesSvc.updateStage(issue.id, 'comicPages', { pages: [{ pageNumber: 1, panels: [] }], status: 'ready' });
    else await issuesSvc.updateStage(issue.id, 'comicPages', { backCover: { proofImage: { filename: 'back-cover.png' } } });
    const produced = await issuesSvc.getIssue(issue.id);
    stageRunnerSpy = vi.fn(async () => ({ content: { episodes: [{
      resolves: ['f1'], seasonNumber: season.number, episodeNumber: issue.number,
      synopsis: 'Different plan.', lengthProfile: 'extended',
    }] } }));
    const result = await planner.resolveVerifyIssues(s.id, { findings: [{ severity: 'medium', problem: 'Needs more space.' }] });
    expect(result.applied).toBe(false);
    expect(result.episodesResolved[0].skipped).toBe('existing-production');
    const after = await issuesSvc.getIssue(issue.id);
    expect(after.lengthProfile).toBe(issue.lengthProfile);
    expect(after.stages.idea.input).toBe('Established plan.');
    expect(after.stages.prose).toEqual(produced.stages.prose);
    expect(after.stages.comicPages).toEqual(produced.stages.comicPages);
    expect(planner.resolvedEpisodeEdits(result)).toEqual([]);
  });

  it('does not persist an unkeyed role change or a malformed custom length', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'A crew must make a costly choice.' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Volume', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Turn', arcRole: 'b-plot' });
    stageRunnerSpy = vi.fn(async () => ({ content: { episodes: [
      { seasonNumber: season.number, episodeNumber: issue.number, arcRole: 'complication' },
      { resolves: ['f1'], seasonNumber: season.number, episodeNumber: issue.number, lengthProfile: 'custom', pageTarget: 5000, minutesTarget: 42 },
    ] } }));
    const result = await planner.resolveVerifyIssues(s.id, { findings: [{ severity: 'medium', problem: 'Needs more space.' }] });
    expect(result.applied).toBe(false);
    expect(await issuesSvc.getIssue(issue.id)).toMatchObject({ arcRole: 'b-plot', lengthProfile: issue.lengthProfile, pageTarget: issue.pageTarget });
    expect(planner.resolvedEpisodeEdits(result)).toEqual([]);
  });

  it('gives the spine judge and resolver the same read-only existing plans without expanding the editable tree', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'seeded episode synopsis', output: 'expanded beats stay outside the spine', status: 'ready' });
    await issuesSvc.updateStage(issue.id, 'prose', { output: 'draft prose stays outside the spine', status: 'ready' });
    await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Empty placeholder' });
    const other = await setupSeries();
    const otherIssue = await issuesSvc.createIssue({ seriesId: other.id, title: 'Unrelated' });
    await issuesSvc.updateStage(otherIssue.id, 'idea', { input: 'another series plan', status: 'empty' });

    stageRunnerSpy = vi.fn(async () => ({
      content: { arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' }, seasons: [], notes: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.verifyArc(s.id, { spineOnly: true });
    await planner.resolveVerifyIssues(s.id, {
      spineOnly: true,
      findings: [{ severity: 'high', problem: 'spine problem', suggestion: 'fix the arc' }],
    });

    const [verify, resolve] = stageRunnerSpy.mock.calls.map((call) => call[1]);
    expect(resolve.spineEpisodePlansJson).toBe(verify.spineEpisodePlansJson);
    for (const ctx of [verify, resolve]) {
      expect(ctx.series.targetFormat).toBe(s.targetFormat);
      expect(ctx.arcSpineOnly).toBe(true);
      expect(JSON.parse(ctx.seasonsTreeJson)[0].episodes).toEqual([]);
      expect(ctx.seasonsTreeJson).not.toContain('seeded episode synopsis');
      expect(ctx.arcSpineHasEpisodePlans).toBe(true);
      expect(JSON.parse(ctx.spineEpisodePlansJson)[0].episodes).toEqual([
        expect.objectContaining({ number: issue.number, title: 'Ep', synopsis: 'seeded episode synopsis' }),
      ]);
      expect(ctx.spineEpisodePlansJson).not.toMatch(/expanded beats|draft prose|Empty placeholder|another series plan/);
    }
  });

  it('omits spine references before issue planning and keeps full-arc plans in the normal tree', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Ep' });
    stageRunnerSpy = vi.fn(async () => ({ content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm' }));
    await planner.verifyArc(s.id, { spineOnly: true });
    expect(stageRunnerSpy.mock.calls[0][1]).toMatchObject({ arcSpineOnly: true, arcSpineHasEpisodePlans: false, spineEpisodePlansJson: '' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'authored plan', status: 'empty' });
    await planner.verifyArc(s.id);
    const full = stageRunnerSpy.mock.calls[1][1];
    expect(full).toMatchObject({ arcSpineOnly: false, arcSpineHasEpisodePlans: false, spineEpisodePlansJson: '' });
    expect(JSON.parse(full.seasonsTreeJson)[0].episodes[0].synopsis).toBe('authored plan');
  });

  it('discards episode edits in spineOnly mode and leaves the planned synopses untouched', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'original episode synopsis', status: 'empty' });
    const fresh = await issuesSvc.getIssue(issue.id);

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { resolves: ['f1'], logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [],
        // A stale/customized installed prompt can still return these — the
        // server drops them rather than trusting the template alone.
        episodes: [{ resolves: ['f1'], seasonNumber: season.number, episodeNumber: fresh.number, synopsis: 'out-of-scope rewrite' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      spineOnly: true,
      findings: [{ severity: 'high', problem: 'spine problem', suggestion: 'fix the arc' }],
    });

    // The arc/volume half of the patch still lands — this scopes the round, it
    // does not disable it.
    expect(out.series.arc.logline).toBe('L2');
    expect(out.episodesResolved).toEqual([]);
    const untouched = await issuesSvc.getIssue(issue.id);
    expect(untouched.stages.idea.input).toBe('original episode synopsis');
  });

  it('clears stale beats when correcting an episode that was already expanded', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'old synopsis', output: 'BEAT 1\nBEAT 2', status: 'ready' });
    const fresh = await issuesSvc.getIssue(issue.id);

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [{ id: season.id, number: season.number, title: 'Vol 1', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1 }],
        episodes: [{ seasonNumber: season.number, episodeNumber: fresh.number, synopsis: 'corrected synopsis' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'contradiction', suggestion: 'fix' }],
    });

    expect(out.episodesResolved[0].clearedBeats).toBe(true);
    const updated = await issuesSvc.getIssue(issue.id);
    expect(updated.stages.idea.input).toBe('corrected synopsis');
    expect(updated.stages.idea.output).toBe(''); // stale beats cleared so beatSheet regenerates
    expect(updated.stages.idea.status).toBe('empty');
  });

  it('leaves a locked idea stage untouched and reports it skipped', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'frozen synopsis', status: 'edited', locked: true });
    const fresh = await issuesSvc.getIssue(issue.id);

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [{ id: season.id, number: season.number, title: 'Vol 1', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1 }],
        episodes: [{ seasonNumber: season.number, episodeNumber: fresh.number, synopsis: 'attempted overwrite' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'contradiction', suggestion: 'fix' }],
    });

    expect(out.episodesResolved[0].skipped).toBe('locked');
    const updated = await issuesSvc.getIssue(issue.id);
    expect(updated.stages.idea.input).toBe('frozen synopsis'); // unchanged
  });

  it('fails safe (no-match) when a correction names a season the matched-number issue is NOT in', async () => {
    // Guard against a numbering-scheme mismatch: the arc tree numbers episodes
    // series-globally, but if the resolve LLM ever returns a per-season
    // episodeNumber, a season-agnostic fallback would silently rewrite the wrong
    // season's issue. With a resolvable seasonNumber we now REQUIRE the season to
    // match — a mismatch is dropped, not mis-applied to another season's issue.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const s1 = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const s2 = await seasonsSvc.createSeason(s.id, { title: 'Vol 2', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: s1.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'season 1 synopsis', status: 'empty' });
    const fresh = await issuesSvc.getIssue(issue.id);

    // Correction names season 2 but the only issue with this number is in season 1.
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [
          { id: s1.id, number: s1.number, title: 'Vol 1', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1 },
          { id: s2.id, number: s2.number, title: 'Vol 2', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1 },
        ],
        episodes: [{ seasonNumber: s2.number, episodeNumber: fresh.number, synopsis: 'WRONG-SEASON overwrite' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'contradiction', suggestion: 'fix' }],
    });

    expect(out.episodesResolved[0].skipped).toBe('no-match');
    const updated = await issuesSvc.getIssue(issue.id);
    expect(updated.stages.idea.input).toBe('season 1 synopsis'); // NOT overwritten
  });
});
