import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const api = vi.hoisted(() => ({ openStoryboardForPipelineIssue: vi.fn() }));
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
});
