import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const api = vi.hoisted(() => ({
  openStoryboardForPipelineIssue: vi.fn(),
  getPipelineStoryboardChanges: vi.fn(async () => ({ boardId: null, locked: false, changed: [] })),
  updatePipelineShotsFromBoard: vi.fn(),
}));
vi.mock('../../../services/api', () => {
  const rest = ['generatePipelineVisualImage', 'generatePipelineSceneVideo', 'generatePipelineShotStartFrame',
    'refinePipelineSceneImagePrompt', 'generatePipelineSceneImagePrompts', 'updatePipelineIssue',
    'extractPipelineStoryboardScenes', 'createBlankSketch'];
  return { ...api, ...Object.fromEntries(rest.map((name) => [name, vi.fn()])) };
});
vi.mock('../../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../../hooks/useUniverse', () => ({ default: () => [null] }));
vi.mock('../MediaJobThumb', () => ({ default: () => null }));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import StoryboardsStage from './StoryboardsStage';

const issue = {
  id: 'iss-1',
  stages: { storyboards: { status: 'edited', scenes: [{ id: 'scene-01', slugline: 'INT. LAB — NIGHT', description: 'The lab hums.', shots: [] }] } },
};

describe('StoryboardsStage', () => {
  it('opens the issue in the shared storyboard editor', async () => {
    api.openStoryboardForPipelineIssue.mockResolvedValue({ boardId: 'sb-1', created: true });
    render(
      <MemoryRouter initialEntries={['/pipeline/issues/iss-1/storyboards']}>
        <Routes>
          <Route path="/pipeline/issues/:issueId/:stage" element={<StoryboardsStage issue={issue} series={null} onStageUpdate={vi.fn()} />} />
          <Route path="/storyboards/:id" element={<p>Storyboard editor</p>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Open in storyboard editor/ }));
    expect(api.openStoryboardForPipelineIssue).toHaveBeenCalledWith('iss-1');
    expect(await screen.findByText('Storyboard editor')).toBeInTheDocument();
  });

  it('shows a shot edited on the linked board and updates it on tap', async () => {
    const withShot = { ...issue, stages: { storyboards: { status: 'edited', scenes: [{ ...issue.stages.storyboards.scenes[0], shots: [{ id: 'shot-01', description: 'Wide of the lab', durationSeconds: 5 }] }] } } };
    api.getPipelineStoryboardChanges.mockResolvedValueOnce({
      boardId: 'sb-1', locked: false, changed: [{ sceneId: 'scene-01', shotId: 'shot-01', panelId: 'panel-1', fields: ['description'] }],
    });
    const saved = { ...withShot, stages: { storyboards: { ...withShot.stages.storyboards, scenes: [{ ...withShot.stages.storyboards.scenes[0], shots: [{ id: 'shot-01', description: 'Wide of the dark lab', durationSeconds: 5 }] }] } } };
    api.updatePipelineShotsFromBoard.mockResolvedValue({ updated: 1, issue: saved, boardId: 'sb-1', locked: false, changed: [] });
    const onStageUpdate = vi.fn();
    render(<MemoryRouter><StoryboardsStage issue={withShot} series={null} onStageUpdate={onStageUpdate} /></MemoryRouter>);

    expect(await screen.findByText('Storyboard changed: action')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(api.updatePipelineShotsFromBoard).toHaveBeenCalledWith('iss-1', 'shot-01');
    expect(await screen.findByDisplayValue('Wide of the dark lab')).toBeInTheDocument();
    expect(screen.queryByText(/Storyboard changed/)).not.toBeInTheDocument();
    expect(onStageUpdate).toHaveBeenCalledWith('storyboards', saved.stages.storyboards, saved);
  });
});
