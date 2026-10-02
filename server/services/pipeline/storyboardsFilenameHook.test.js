/**
 * Storyboards shot filename hook — completion routing (#3413).
 *
 * The hook must stamp the finished render onto the shot the render was
 * ENQUEUED for, even when the scenes/shots reordered while the job was in the
 * queue, and must still attach jobs queued under the LEGACY index-only owner
 * format (no ids) so an upgrade doesn't strand in-flight renders.
 *
 * The hook's handler runs fire-and-forget, so each test awaits the hook's
 * owned completion boundary (`__testing.drain()`) before asserting (#9634).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const issuesStore = new Map();

const updateStageWithLatestMock = vi.fn(async (issueId, stageId, computeFn) => {
  const issue = issuesStore.get(issueId);
  if (!issue) throw new Error('issue not found');
  const currentStage = issue.stages?.[stageId] || null;
  const patch = computeFn(currentStage);
  if (!patch || Object.keys(patch).length === 0) return { issue, stage: currentStage };
  issue.stages[stageId] = { ...currentStage, ...patch };
  return { issue, stage: issue.stages[stageId] };
});

vi.mock('./issues.js', () => ({
  updateStageWithLatest: (...a) => updateStageWithLatestMock(...a),
}));

const { mediaJobEvents } = await import('../mediaJobQueue/index.js');
const hook = await import('./storyboardsFilenameHook.js');
const { buildStoryboardsShotOwner } = await import('./owners.js');

const seedIssue = (scenes) => {
  issuesStore.set('iss-1', { id: 'iss-1', stages: { storyboards: { scenes } } });
};
const shotsOf = (sceneIndex) => issuesStore.get('iss-1').stages.storyboards.scenes[sceneIndex].shots;

beforeEach(async () => {
  await hook.__testing.reset();
  issuesStore.clear();
  updateStageWithLatestMock.mockClear();
  hook.initStoryboardsFilenameHook();
});

afterEach(async () => {
  await hook.__testing.reset();
});

describe('storyboardsFilenameHook', () => {
  it('routes the completed render by scene/shot id after a reorder', async () => {
    // Enqueued against scene index 1 / shot index 0; by completion time the
    // scenes have been reordered, so index addressing would hit the wrong shot.
    seedIssue([
      { id: 'scene-02', shots: [{ id: 'shot-01', startFrameJobId: 'other-job' }] },
      { id: 'scene-01', shots: [{ id: 'shot-07', startFrameJobId: 'job-1' }] },
    ]);

    mediaJobEvents.emit('completed', {
      id: 'job-1',
      kind: 'image',
      result: { filename: 'shot.png' },
      owner: buildStoryboardsShotOwner({
        issueId: 'iss-1', sceneIndex: 0, shotIndex: 0, sceneId: 'scene-01', shotId: 'shot-07',
      }),
    });

    await hook.__testing.drain();
    expect(shotsOf(1)[0].startFrameFilename).toBe('shot.png');
    expect(shotsOf(0)[0].startFrameFilename).toBeUndefined();
  });

  it('attaches a job queued under a LEGACY index-only owner (no ids)', async () => {
    seedIssue([
      { id: 'scene-01', shots: [{ id: 'shot-01', startFrameJobId: 'legacy-job' }] },
    ]);

    mediaJobEvents.emit('completed', {
      id: 'legacy-job',
      kind: 'image',
      result: { filename: 'legacy.png' },
      owner: 'pipeline:iss-1:storyboards:scene0:shot0',
    });

    await hook.__testing.drain();
    expect(shotsOf(0)[0].startFrameFilename).toBe('legacy.png');
  });

  it('skips when the shot is no longer pointing at this job (stale re-render)', async () => {
    seedIssue([{ id: 'scene-01', shots: [{ id: 'shot-01', startFrameJobId: 'newer-job' }] }]);

    mediaJobEvents.emit('completed', {
      id: 'stale-job',
      kind: 'image',
      result: { filename: 'stale.png' },
      owner: buildStoryboardsShotOwner({
        issueId: 'iss-1', sceneIndex: 0, shotIndex: 0, sceneId: 'scene-01', shotId: 'shot-01',
      }),
    });

    await hook.__testing.drain();
    expect(updateStageWithLatestMock).toHaveBeenCalledTimes(1);
    expect(shotsOf(0)[0].startFrameFilename).toBeUndefined();
  });

  it('skips when the scene the owner names is gone entirely', async () => {
    seedIssue([{ id: 'scene-02', shots: [{ id: 'shot-01', startFrameJobId: 'job-1' }] }]);

    mediaJobEvents.emit('completed', {
      id: 'job-1',
      kind: 'image',
      result: { filename: 'orphan.png' },
      owner: buildStoryboardsShotOwner({
        issueId: 'iss-1', sceneIndex: 0, shotIndex: 0, sceneId: 'scene-99', shotId: 'shot-99',
      }),
    });

    await hook.__testing.drain();
    expect(updateStageWithLatestMock).toHaveBeenCalledTimes(1);
    expect(shotsOf(0)[0].startFrameFilename).toBeUndefined();
  });
});
