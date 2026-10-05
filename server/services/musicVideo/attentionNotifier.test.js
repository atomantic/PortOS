import { describe, it, expect, vi, beforeEach } from 'vitest';

const addNotification = vi.fn(async () => ({}));
vi.mock('../notifications.js', () => ({
  addNotification,
  NOTIFICATION_TYPES: { MUSIC_VIDEO_ATTENTION: 'music_video_attention' },
}));

const { musicVideoEvents } = await import('./events.js');
const { initMusicVideoAttentionNotifier, __resetAttentionNotifierForTests } = await import('./attentionNotifier.js');

initMusicVideoAttentionNotifier();
initMusicVideoAttentionNotifier(); // idempotent: a second call must not double-subscribe

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const emit = async (event, payload) => { musicVideoEvents.emit(event, payload); await settle(); };
const project = (extra = {}) => ({ id: 'mv-1', name: 'Example Video', ...extra });

beforeEach(() => {
  addNotification.mockClear();
  __resetAttentionNotifierForTests();
});

describe('music video attention notifications (#10156)', () => {
  it('raises one deep-linked notification when a scheduled run parks at an approval, however often it re-emits', async () => {
    const run = { id: 'run-1', status: 'awaiting-approval', awaiting: 'lyrics', stage: 'style' };
    for (let i = 0; i < 3; i += 1) await emit('autonomous', { projectId: 'mv-1', run, project: project() });
    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification.mock.calls[0][0]).toMatchObject({
      type: 'music_video_attention',
      link: '/music-video/mv-1/setup#mv-auto-edit',
      description: expect.stringContaining('Example Video'),
      metadata: { projectId: 'mv-1', runId: 'run-1', status: 'awaiting-approval' },
    });
  });

  it('notifies for needs-human, failed and completed but not for a running run', async () => {
    await emit('autonomous', { projectId: 'mv-1', run: { id: 'r', status: 'running', stage: 'produce' }, project: project() });
    expect(addNotification).not.toHaveBeenCalled();
    for (const status of ['needs-human', 'failed', 'completed']) {
      await emit('autonomous', { projectId: 'mv-1', run: { id: 'r', status, stage: 'produce', error: 'boom' }, project: project() });
    }
    expect(addNotification.mock.calls.map(([n]) => n.metadata.status)).toEqual(['needs-human', 'failed', 'completed']);
    expect(addNotification.mock.calls[2][0].link).toBe('/music-video/mv-1/review');
  });

  it('notifies when production or a board auto-review stops on a limit', async () => {
    await emit('production', { projectId: 'mv-1', run: { id: 'p-1', status: 'limit-reached', stopReason: 'budget spent' }, project: project() });
    await emit('auto-review', { projectId: 'mv-1', run: { id: 'a-1', status: 'needs-human', stopReason: 'could not verify' }, project: project() });
    expect(addNotification.mock.calls.map(([n]) => n.link)).toEqual(['/music-video/mv-1/produce', '/music-video/mv-1/review']);
  });

  it('stays silent where another notification already covers the stop', async () => {
    // Production owned by an autonomous run: the run's own needs-human notification covers it.
    await emit('production', { projectId: 'mv-1', run: { id: 'p-1', status: 'needs-human' }, project: project({ autonomousRun: { output: { productionRunId: 'p-1' } } }) });
    // Auto-review owned by a production run, a user pause and a passing review.
    await emit('auto-review', { projectId: 'mv-1', run: { id: 'a-1', status: 'limit-reached', productionRunId: 'p-1' }, project: project() });
    await emit('auto-review', { projectId: 'mv-1', run: { id: 'a-2', status: 'stopped' }, project: project() });
    await emit('auto-review', { projectId: 'mv-1', run: { id: 'a-3', status: 'passed' }, project: project() });
    expect(addNotification).not.toHaveBeenCalled();
  });
});
