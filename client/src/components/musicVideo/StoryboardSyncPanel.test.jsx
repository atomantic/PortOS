import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const syncMusicVideoShots = vi.fn(async () => ({ project: { id: 'mv-1', scenes: [], storyboardSync: true }, counts: {} }));
vi.mock('../../services/api', () => ({ syncMusicVideoShots, setMusicVideoShotSync: vi.fn() }));
const { default: StoryboardSyncPanel } = await import('./StoryboardSyncPanel.jsx');
const { ShotLockContext } = await import('./ShotLock.jsx');

const panel = (id, seconds) => ({ id: `panel-${id}`, action: `Panel ${id}`, seconds, castIds: [], environmentIds: [], objectIds: [], takes: [] });
const board = { id: 'sb-1', updatedAt: '2026-10-31T00:00:00.000Z', beats: [{ id: 'beat-a', title: 'Verse', panels: [panel('a', 5), panel('b', 5)] }] };
const project = (scenes) => ({ id: 'mv-1', updatedAt: 'u1', scenes, audioAnalysis: { durationSec: 10, sections: [], beats: [], downbeats: [] }, lyricCues: [] });

describe('StoryboardSyncPanel', () => {
  it('previews the sync and writes it as shown', async () => {
    const onSynced = vi.fn();
    render(<StoryboardSyncPanel project={project([])} board={board} onSynced={onSynced} onBoardStale={() => {}} />);
    expect(screen.getByText(/2 new/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Sync 2 shots/ }));
    await waitFor(() => expect(onSynced).toHaveBeenCalled());
    expect(syncMusicVideoShots).toHaveBeenCalledWith('mv-1', { boardUpdatedAt: board.updatedAt, projectUpdatedAt: 'u1', removeLocked: false }, { silent: true });
  });

  it('names a locked shot it will not remove, and offers to remove it', () => {
    const scenes = [{ sceneId: 'mvs-x', order: 0, label: 'Old shot', startSec: 0, endSec: 1 }];
    render(
      <ShotLockContext.Provider value={{ locks: { 'mvs-x': 'locked' }, clips: {} }}>
        <StoryboardSyncPanel project={project(scenes)} board={board} onSynced={() => {}} onBoardStale={() => {}} />
      </ShotLockContext.Provider>,
    );
    expect(screen.getByText(/Old shot: It is locked/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Also remove locked shots no panel keeps'));
    expect(screen.getByText(/1 removed/)).toBeTruthy();
  });
});
