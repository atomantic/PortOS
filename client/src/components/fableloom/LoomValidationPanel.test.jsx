import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import * as api from '../../services/api';
import LoomValidationPanel from './LoomValidationPanel';

vi.mock('../../services/api');
vi.mock('./LoomWorkflowPanel', () => ({
  default: () => <div>Ordered production workflow</div>,
}));
vi.mock('./LoomContinuityPanel', () => ({
  default: () => <div>Dedicated continuity workspace</div>,
}));
vi.mock('./LoomProductionPanel', () => ({
  default: ({ onLoomUpdate }) => (
    <button type="button" onClick={() => onLoomUpdate?.({ id: 'loom-updated' })}>
      Dedicated render workspace
    </button>
  ),
}));

const episode = {
  id: 'episode-1', startNodeId: 'scene-1',
  nodes: [{ id: 'scene-1', isEnding: true, transitions: [] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.validateLoomEpisode.mockResolvedValue({
    stats: {
      errorCount: 0, automaticCutCount: 0, decisionCount: 0,
      reachableEndingCount: 1, endingCount: 1, maxDepth: 1,
    },
    issues: [],
  });
  api.reviewLoomEpisodeContinuity.mockResolvedValue({ passed: true, findings: [], summary: {} });
});

describe('LoomValidationPanel', () => {
  it('opens on the ordered workflow and separates story, continuity, and render work', async () => {
    const user = userEvent.setup();
    const onLoomUpdate = vi.fn();
    render(
      <MemoryRouter>
        <LoomValidationPanel
          loom={{ id: 'loom-1', episodes: [episode] }}
          episode={episode}
          onSelectNode={vi.fn()}
          onLoomUpdate={onLoomUpdate}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Ordered production workflow')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Story' }));
    await waitFor(() => expect(screen.getByText(/Graph is sound/i)).toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: 'Continuity' }));
    expect(screen.getByText('Dedicated continuity workspace')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Render' }));
    expect(screen.getByText('Dedicated render workspace')).toBeInTheDocument();
    await user.click(screen.getByText('Dedicated render workspace'));
    expect(onLoomUpdate).toHaveBeenCalledWith({ id: 'loom-updated' });
  });

  it('restores the selected production workspace from the URL', async () => {
    render(
      <MemoryRouter initialEntries={['/?production=render']}>
        <LoomValidationPanel
          loom={{ id: 'loom-1', episodes: [episode] }}
          episode={episode}
          onSelectNode={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Dedicated render workspace')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Render' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(api.validateLoomEpisode).toHaveBeenCalled();
      expect(api.reviewLoomEpisodeContinuity).toHaveBeenCalled();
    });
  });
});
