import { describe, it, expect } from 'vitest';
import { settleMusicVideoRender } from './renderSettlement.js';

// #15154: the revision compare every final render's terminal write runs on the
// freshest project row. The render pipelines reach it through render.js; this
// pins the decision matrix, including the legacy (no revision) compatibility.
const SELF = 'inst-self';
const analysis = { durationSec: 1, beats: [], downbeats: [], sections: [] };
const rendering = (extra = {}) => ({
  id: 'mv-1', status: 'rendering', trackId: 't1', audioAnalysis: analysis,
  renderingOn: SELF, renderPartialFilename: 'music-video-a.mp4', renderResume: null, ...extra,
});
const complete = { renderHistoryId: 'job-1', renderDependencies: { version: 1 } };
const settle = (current, jobRevision, status = 'complete', extra = complete) => settleMusicVideoRender(current, { jobRevision, status, extra, instanceId: SELF });

describe('settleMusicVideoRender', () => {
  it('applies the settled status and clears the mark when the revision matches', () => {
    const { project, settled } = settle(rendering({ audioRevision: 2, renderAudioRevision: 2 }), 2);
    expect(settled).toBe(true);
    expect(project).toMatchObject({ status: 'complete', renderHistoryId: 'job-1', renderingOn: null, renderPartialFilename: null, renderAudioRevision: null });
  });

  it('completes a legacy render when neither the row nor the job has a revision', () => {
    expect(settle(rendering(), undefined)).toMatchObject({ settled: true, project: { status: 'complete', renderHistoryId: 'job-1' } });
  });

  it('does not complete a job with no revision once a track change bumped the row', () => {
    const changed = rendering({ status: 'draft', audioAnalysis: null, audioRevision: 1 });
    const { project, settled } = settle(changed, undefined);
    expect(settled).toBe(false);
    expect(project).toMatchObject({ status: 'draft', audioAnalysis: null, renderingOn: null, renderPartialFilename: null });
    expect(project.renderHistoryId).toBeUndefined();
  });

  it('keeps the track change on a stale settle, for success and failure alike, and clears a local mark', () => {
    const changed = rendering({ status: 'draft', audioAnalysis: null, trackId: 't2', audioRevision: 3, renderAudioRevision: 2 });
    for (const [status, extra] of [['complete', complete], ['failed', { renderError: 'boom' }], ['ready', {}]]) {
      const { project, settled } = settle(changed, 2, status, extra);
      expect(settled).toBe(false);
      // The old song's analysis and render evidence never come back.
      expect(project).toMatchObject({ status: 'draft', audioAnalysis: null, trackId: 't2', audioRevision: 3, renderingOn: null, renderAudioRevision: null });
      expect(project).not.toHaveProperty('renderHistoryId');
      expect(project).not.toHaveProperty('renderError');
    }
  });

  it('demotes a rendering mark the stale job wrote after the track change to what the new song supports', () => {
    expect(settle(rendering({ audioAnalysis: null, audioRevision: 1, renderAudioRevision: 0 }), 0).project.status).toBe('draft');
    expect(settle(rendering({ audioRevision: 1, renderAudioRevision: 0 }), 0).project.status).toBe('analyzed');
  });

  it("leaves a peer's mark and a newer render's mark alone on a stale settle", () => {
    const peer = rendering({ audioRevision: 1, renderAudioRevision: 1, renderingOn: 'inst-peer' });
    expect(settle(peer, 0)).toEqual({ project: peer, settled: false });
    const newer = rendering({ audioRevision: 1, renderAudioRevision: 1 });
    expect(settle(newer, 0)).toEqual({ project: newer, settled: false });
  });
});
