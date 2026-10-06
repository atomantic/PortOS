import { describe, expect, it } from 'vitest';
import { autoReviewNeedsUser, deriveAttentionItems, openRevisionOf } from './musicVideoAttention.js';

const scene = (sceneId, extra = {}) => ({ sceneId, ...extra });
const revision = (extra = {}) => ({
  id: 'mvrev-example',
  status: 'open',
  sections: [
    { sceneId: 'scene-a', kind: 'video', verdict: 'rejected' },
    { sceneId: 'scene-b', kind: 'image', verdict: 'rejected' },
    { sceneId: 'scene-c', kind: 'video', verdict: 'kept' },
  ],
  ...extra,
});
const project = (extra = {}) => ({
  id: 'mv-example',
  scenes: [scene('scene-a'), scene('scene-b'), scene('scene-c')],
  revisions: [],
  autoReviews: [],
  ...extra,
});
const run = (extra = {}) => ({
  id: 'mvar-example',
  status: 'running',
  attempts: [{ n: 1, revisionId: 'mvrev-example' }],
  ...extra,
});

describe('deriveAttentionItems (#9940)', () => {
  it('is empty for a healthy or missing project', () => {
    expect(deriveAttentionItems(null)).toEqual([]);
    expect(deriveAttentionItems(project())).toEqual([]);
    expect(deriveAttentionItems(project({ revisions: [revision({ status: 'complete' }), revision({ id: 'x', status: 'canceled' })] }))).toEqual([]);
  });

  it('surfaces an open revision with the id the server holds and how far its takes got', () => {
    const items = deriveAttentionItems(project({
      scenes: [scene('scene-a', { videoHistoryId: 'vh-1' }), scene('scene-b'), scene('scene-c')],
      revisions: [revision()],
    }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'revision', revisionId: 'mvrev-example', canResume: true });
    expect(items[0].detail).toContain('New takes: 1 of 2');
  });

  it('offers only Cancel while a revision re-renders its draft, and stays quiet when this tab is watching that render', () => {
    const rendering = project({ revisions: [revision({ status: 'rendering' })] });
    expect(deriveAttentionItems(rendering)[0]).toMatchObject({ kind: 'revision', canResume: false });
    expect(deriveAttentionItems(rendering, { draftRendering: true })).toEqual([]);
  });

  it('does not flag an open revision whose sections are spinning on this board', () => {
    const open = project({ revisions: [revision()] });
    expect(deriveAttentionItems(open, { generatingSceneIds: new Set(['scene-b']) })).toEqual([]);
    // A spinner on an unrelated scene proves nothing about this revision.
    expect(deriveAttentionItems(open, { generatingSceneIds: new Set(['scene-c']) })).toHaveLength(1);
  });

  it('does not flag an auto-review whose server already claimed a revised section — it is generating there with no spinner on this board (#10014)', () => {
    const claimed = revision({ sections: [
      { sceneId: 'scene-a', kind: 'video', verdict: 'rejected', claimedAt: '2026-01-01T00:00:00.000Z' },
      { sceneId: 'scene-b', kind: 'image', verdict: 'rejected' },
    ] });
    expect(deriveAttentionItems(project({ revisions: [claimed], autoReviews: [run()] }))).toEqual([]);
    // Never handed out (no section claimed): stalled, so Continue is offered.
    expect(deriveAttentionItems(project({ revisions: [revision()], autoReviews: [run()] }))).toMatchObject([{ kind: 'auto-review' }]);
  });

  it('flags an interrupted Cast & Sets stage but not one that is working or settled', () => {
    expect(deriveAttentionItems(project({ castAndSets: { status: 'imaging', interrupted: true } }))).toMatchObject([{ kind: 'cast-and-sets' }]);
    expect(deriveAttentionItems(project({ castAndSets: { status: 'imaging', interrupted: false } }))).toEqual([]);
    expect(deriveAttentionItems(project({ castAndSets: { status: 'approved' } }))).toEqual([]);
  });

  it('shows a running auto-review waiting on generation as ONE row — the run owns its revision', () => {
    const items = deriveAttentionItems(project({ revisions: [revision()], autoReviews: [run()] }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'auto-review', runId: 'mvar-example' });
  });

  it('leaves auto-review alone while it renders or reviews, when a production owns it, and while sections spin', () => {
    // The run is rendering the revised draft: nothing to hand out.
    expect(deriveAttentionItems(project({ revisions: [revision({ status: 'rendering' })], autoReviews: [run()] }))).toEqual([]);
    // A production run dispatches its own sections server-side.
    expect(deriveAttentionItems(project({ revisions: [revision()], autoReviews: [run({ productionRunId: 'mvpr-example' })] })))
      .toMatchObject([{ kind: 'revision' }]);
    // This board is already generating the hand-out.
    expect(deriveAttentionItems(project({ revisions: [revision()], autoReviews: [run()] }), { generatingSceneIds: new Set(['scene-a']) })).toEqual([]);
    // A paused run is not "waiting" for hand-out: its open revision is an ordinary revision,
    // and the stopped run is listed on its own row (#10156).
    expect(deriveAttentionItems(project({ revisions: [revision()], autoReviews: [run({ status: 'stopped' })] })))
      .toMatchObject([{ kind: 'revision' }, { kind: 'auto-review-parked' }]);
  });

  it('flags a final render the server holds that this tab is not showing', () => {
    expect(deriveAttentionItems(project({ status: 'rendering' }))).toMatchObject([{ kind: 'final-render' }]);
    expect(deriveAttentionItems(project({ status: 'rendering' }), { finalRenderAttached: true })).toEqual([]);
    expect(deriveAttentionItems(project({ status: 'complete' }))).toEqual([]);
  });

  it('orders rows revision, cast & sets, auto-review, final render', () => {
    const items = deriveAttentionItems(project({
      status: 'rendering',
      castAndSets: { status: 'directing', interrupted: true },
      revisions: [revision({ id: 'mvrev-other' }), revision({ id: 'mvrev-owned' })],
      autoReviews: [run({ attempts: [{ n: 1, revisionId: 'mvrev-owned' }] })],
    }));
    expect(items.map((item) => item.kind)).toEqual(['revision', 'cast-and-sets', 'auto-review', 'final-render']);
  });
});

describe('openRevisionOf', () => {
  it('returns the open or rendering revision, else null', () => {
    expect(openRevisionOf(project({ revisions: [revision({ status: 'canceled' }), revision({ id: 'live', status: 'rendering' })] }))?.id).toBe('live');
    expect(openRevisionOf(project())).toBeNull();
    expect(openRevisionOf(null)).toBeNull();
  });
});

describe('parked runs (#10156)', () => {
  it('lists an autonomous run awaiting approval with an Open target (its checkpoint editor in Project settings) and no Resume', () => {
    const [item] = deriveAttentionItems(project({ name: 'Example', autonomousRun: { id: 'auto-1', status: 'awaiting-approval', awaiting: 'lyrics', stage: 'style' } }));
    expect(item).toMatchObject({ kind: 'autonomous', canResume: false, openTo: 'setup?mvPanel=autopilot#mv-auto-edit', projectId: 'mv-example' });
    expect(item.detail).toContain('lyrics');
  });

  it('lists stopped and failed autonomous runs with a Resume or Retry', () => {
    const stopped = deriveAttentionItems(project({ autonomousRun: { id: 'a', status: 'stopped', stage: 'song' } }));
    const failed = deriveAttentionItems(project({ autonomousRun: { id: 'a', status: 'failed', stage: 'produce', error: 'boom' } }));
    expect(stopped[0]).toMatchObject({ kind: 'autonomous', canResume: true, resumeLabel: 'Resume' });
    expect(stopped[0].openTo).toBe('setup?mvPanel=autopilot');
    expect(failed[0]).toMatchObject({ canResume: true, resumeLabel: 'Retry', openTo: 'produce?mvPanel=autopilot' });
  });

  it('lists a stopped or limit-reached auto-review but not older superseded or healthy ones', () => {
    const limit = deriveAttentionItems(project({ autoReviews: [run({ id: 'ar-1', status: 'limit-reached', stopReason: 'Reached the limit' })] }));
    expect(limit).toEqual([expect.objectContaining({ kind: 'auto-review-parked', runId: 'ar-1', canResume: false, openTo: 'review', detail: 'Reached the limit' })]);
    const stopped = deriveAttentionItems(project({ autoReviews: [run({ id: 'ar-2', status: 'stopped' })] }));
    expect(stopped[0]).toMatchObject({ kind: 'auto-review-parked', canResume: true });
    const superseded = deriveAttentionItems(project({ autoReviews: [run({ id: 'old', status: 'stopped' }), run({ id: 'new', status: 'passed' })] }));
    expect(superseded).toEqual([]);
  });

  it('lists a production run at its limit, once, even when an autonomous run is parked on it', () => {
    const production = { id: 'prod-1', status: 'limit-reached', stopReason: 'Spend limit' };
    const alone = deriveAttentionItems(project({ productionRuns: [production] }));
    expect(alone).toEqual([expect.objectContaining({ kind: 'production', runId: 'prod-1', openTo: 'produce?mvPanel=autopilot', detail: 'Spend limit', canResume: true })]);
    const owned = deriveAttentionItems(project({ productionRuns: [production], autonomousRun: { id: 'a', status: 'needs-human', stage: 'produce', output: { productionRunId: 'prod-1' } } }));
    expect(owned.map((i) => i.kind)).toEqual(['autonomous']);
  });

  it('opens the auto-review tools only when a run is live or parked', () => {
    expect(autoReviewNeedsUser(project())).toBe(false);
    expect(autoReviewNeedsUser(project({ autoReviews: [run({ status: 'passed' })] }))).toBe(false);
    expect(autoReviewNeedsUser(project({ autoReviews: [run({ status: 'running' })] }))).toBe(true);
    expect(autoReviewNeedsUser(project({ autoReviews: [run({ status: 'needs-human' })] }))).toBe(true);
  });
});

describe('stale approvals in Needs attention (#10141)', () => {
  const readiness = {
    castAndSets: { approved: true, stale: { changedFields: ['concept'] } },
    art: { approved: false, stale: { changedFields: ['concept', 'cast', 'environments', 'visual language'] } },
    storyboard: { approved: false, stale: null },
    proof: { approved: false, stale: null },
  };

  it('names what changed per approval and opens the earliest one', () => {
    const [item] = deriveAttentionItems(project(), { readiness });
    expect(item).toMatchObject({ kind: 'stale-approvals', openTo: 'cast-sets', title: '2 approvals were given before later changes' });
    expect(item.detail).toBe('Cast & Sets check-in — changed since: concept. Art direction — changed since: concept, cast, environments +1 more. Re-approve, or undo the change.');
  });

  it('stays quiet with no stale approval, and while a production run is replacing takes', () => {
    expect(deriveAttentionItems(project(), { readiness: { art: { stale: null } } })).toEqual([]);
    const producing = project({ productionRuns: [{ id: 'run-1', status: 'running' }], productionRunId: 'run-1' });
    expect(deriveAttentionItems(producing, { readiness }).some((i) => i.kind === 'stale-approvals')).toBe(false);
  });
});
