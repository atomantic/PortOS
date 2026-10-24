import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const api = vi.hoisted(() => ({
  openStoryboardForPipelineIssue: vi.fn(),
  getPipelineStoryboardChanges: vi.fn(async () => ({ boardId: null, locked: false, changed: [] })),
  updatePipelineShotsFromBoard: vi.fn(),
  updatePipelineIssue: vi.fn(),
}));
vi.mock('../../../services/api', () => {
  const rest = ['generatePipelineVisualImage', 'generatePipelineSceneVideo', 'generatePipelineShotStartFrame',
    'refinePipelineSceneImagePrompt', 'generatePipelineSceneImagePrompts',
    'extractPipelineStoryboardScenes', 'createBlankSketch'];
  return { ...api, ...Object.fromEntries(rest.map((name) => [name, vi.fn()])) };
});
const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    emit: (event, payload) => { for (const handler of handlers.get(event) || []) handler(payload); },
    on: vi.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    }),
    off: vi.fn((event, handler) => handlers.get(event)?.delete(handler)),
  };
});
vi.mock('../../../services/socket', () => ({ default: socket }));
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

  it('shows edits from the linked storyboard while the pipeline stays open, then applies the update response', async () => {
    const withShot = { ...issue, stages: { storyboards: { status: 'edited', scenes: [{ ...issue.stages.storyboards.scenes[0], shots: [{ id: 'shot-01', description: 'Wide of the lab', durationSeconds: 5 }] }] } } };
    const unchanged = { boardId: 'sb-1', locked: false, changed: [] };
    api.getPipelineStoryboardChanges.mockResolvedValueOnce(unchanged).mockResolvedValueOnce({
      ...unchanged, changed: [{ sceneId: 'scene-01', shotId: 'shot-01', panelId: 'panel-1', fields: ['description'] }],
    });
    const saved = { ...withShot, stages: { storyboards: { ...withShot.stages.storyboards, scenes: [{ ...withShot.stages.storyboards.scenes[0], shots: [{ id: 'shot-01', description: 'Edited in another tab', durationSeconds: 5 }] }] } } };
    api.updatePipelineShotsFromBoard.mockResolvedValue({ updated: 1, issue: saved, ...unchanged });
    render(<MemoryRouter><StoryboardsStage issue={withShot} series={null} onStageUpdate={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(api.getPipelineStoryboardChanges).toHaveBeenCalledTimes(1));
    await act(async () => { socket.emit('storyboard:changed', { id: 'sb-other' }); });
    expect(api.getPipelineStoryboardChanges).toHaveBeenCalledTimes(1);
    await act(async () => { socket.emit('storyboard:changed', { id: 'sb-1' }); });

    expect(await screen.findByText('Storyboard changed: action')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByDisplayValue('Edited in another tab')).toBeInTheDocument();
    expect(screen.queryByText(/Storyboard changed/)).not.toBeInTheDocument();
    expect(api.getPipelineStoryboardChanges).toHaveBeenCalledTimes(2);
  });

  it('does not apply an earlier issue’s pending storyboard update after selecting another issue', async () => {
    const changed = { boardId: 'sb-1', locked: false, changed: [{ sceneId: 'scene-01', shotId: 'shot-01', panelId: 'panel-1', fields: ['description'] }] };
    const withShot = { ...issue, stages: { storyboards: { status: 'edited', scenes: [{ ...issue.stages.storyboards.scenes[0], shots: [{ id: 'shot-01', description: 'Wide of the lab', durationSeconds: 5 }] }] } } };
    api.getPipelineStoryboardChanges.mockResolvedValueOnce(changed);
    let finishUpdate;
    api.updatePipelineShotsFromBoard.mockImplementationOnce(() => new Promise(resolve => { finishUpdate = resolve; }));
    const onStageUpdate = vi.fn();
    const view = render(<MemoryRouter><StoryboardsStage issue={withShot} series={null} onStageUpdate={onStageUpdate} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    const nextIssue = { ...withShot, id: 'iss-2' };
    view.rerender(<MemoryRouter><StoryboardsStage issue={nextIssue} series={null} onStageUpdate={onStageUpdate} /></MemoryRouter>);
    await act(async () => { finishUpdate({ updated: 1, issue: withShot, boardId: 'sb-1', locked: false, changed: [] }); });
    expect(onStageUpdate).not.toHaveBeenCalled();
  });

  it('holds scene edits and saves while a storyboard update is pending', async () => {
    const withShot = { ...issue, stages: { storyboards: { status: 'edited', scenes: [{ ...issue.stages.storyboards.scenes[0], shots: [{ id: 'shot-01', description: 'Wide of the lab', durationSeconds: 5 }] }] } } };
    api.getPipelineStoryboardChanges.mockResolvedValueOnce({ boardId: 'sb-1', locked: false,
      changed: [{ sceneId: 'scene-01', shotId: 'shot-01', panelId: 'panel-1', fields: ['description'] }] });
    let finishUpdate;
    api.updatePipelineShotsFromBoard.mockImplementationOnce(() => new Promise(resolve => { finishUpdate = resolve; }));
    render(<MemoryRouter><StoryboardsStage issue={withShot} series={null} onStageUpdate={vi.fn()} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    try {
      expect(screen.getByDisplayValue('Wide of the lab')).toBeDisabled();
      expect(screen.getByLabelText('Scene 1 slugline')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Add scene' })).toBeDisabled();
      fireEvent.blur(screen.getByDisplayValue('Wide of the lab'));
      expect(api.updatePipelineIssue).not.toHaveBeenCalled();
    } finally {
      await act(async () => { finishUpdate({ updated: 1, issue: withShot, boardId: 'sb-1', locked: false, changed: [] }); });
    }
    expect(screen.getByDisplayValue('Wide of the lab')).toBeEnabled();
  });

  it('does not leave the newly selected issue when an earlier Open request finishes', async () => {
    let finishOpen;
    api.openStoryboardForPipelineIssue.mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve; }));
    const element = selectedIssue => <MemoryRouter><Routes>
      <Route path="/" element={<StoryboardsStage issue={selectedIssue} series={null} onStageUpdate={vi.fn()} />} />
      <Route path="/storyboards/:id" element={<p>Earlier issue storyboard</p>} />
    </Routes></MemoryRouter>;
    const view = render(element(issue));
    fireEvent.click(screen.getByRole('button', { name: /Open in storyboard editor/ }));
    view.rerender(element({ ...issue, id: 'iss-2' }));
    await act(async () => { finishOpen({ boardId: 'sb-earlier', created: true }); });
    expect(screen.queryByText('Earlier issue storyboard')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open in storyboard editor/ })).toBeInTheDocument();
  });
});
