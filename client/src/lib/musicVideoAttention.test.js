import { describe, expect, it } from 'vitest';
import { deriveAttentionItems, openRevisionOf } from './musicVideoAttention.js';

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
    // A paused run is not "waiting": its open revision is an ordinary revision.
    expect(deriveAttentionItems(project({ revisions: [revision()], autoReviews: [run({ status: 'stopped' })] })))
      .toMatchObject([{ kind: 'revision' }]);
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
