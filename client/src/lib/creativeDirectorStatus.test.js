import { describe, expect, it } from 'vitest';
import { describeCreativeDirectorStatus } from './creativeDirectorStatus.js';

const project = (overrides = {}) => ({ id: 'cd-example', name: 'Example project', status: 'draft', ...overrides });

describe('describeCreativeDirectorStatus', () => {
  it('names a project waiting on the user and offers the one action that unblocks it', () => {
    const draft = describeCreativeDirectorStatus(project());
    expect(draft).toMatchObject({ tone: 'warn', headline: 'Draft · waiting for you to start', next: { id: 'start', label: 'Start' } });
    expect(describeCreativeDirectorStatus(project({ status: 'paused' })).next).toMatchObject({ id: 'resume', label: 'Resume' });
    // A video draft is edited, not started from the header.
    expect(describeCreativeDirectorStatus(project({ workspace: 'video' })).next).toMatchObject({ id: 'edit-draft' });
  });

  it('sends a video with a cut to review, but not when the review tab is already open', () => {
    const video = project({ workspace: 'video', status: 'stitching', videoRoughCut: { filename: 'cut.mp4' } });
    const status = describeCreativeDirectorStatus(video, { activeTab: 'overview' });
    expect(status).toMatchObject({ tone: 'warn', headline: 'Cut ready · waiting for your review', next: { id: 'goto', tab: 'review' } });
    expect(describeCreativeDirectorStatus(video, { activeTab: 'review' }).next).toBeNull();
  });

  it('reports a running project in words with its scene progress and working agents, and no action', () => {
    const status = describeCreativeDirectorStatus(project({
      status: 'rendering',
      treatment: { scenes: [{ status: 'accepted' }, { status: 'rendering' }, { status: 'pending' }] },
    }), { activeAgents: 2 });
    expect(status).toMatchObject({ tone: 'muted', headline: 'Rendering · 1 of 3 scenes accepted', next: null });
    expect(describeCreativeDirectorStatus(project({ status: 'rendering', treatment: { scenes: [{ status: 'accepted' }] } })).headline).toBe('Rendering · 1 of 1 scene accepted');
    expect(status.facts).toEqual([{ id: 'agents', label: '2 agents working', tone: 'muted' }]);
  });

  it('surfaces why a failed project failed and offers a retry', () => {
    expect(describeCreativeDirectorStatus(project({ status: 'failed', failureReason: 'Render queue unavailable' })))
      .toMatchObject({ tone: 'error', headline: 'Failed · Render queue unavailable', next: { id: 'start', label: 'Retry' } });
  });

  it('points a delivered project at its final video', () => {
    expect(describeCreativeDirectorStatus(project({ status: 'complete', finalVideoId: 'job-1' })))
      .toMatchObject({ tone: 'ok', next: { id: 'open-final' } });
    expect(describeCreativeDirectorStatus(project({ status: 'complete' })).next).toBeNull();
  });
});
