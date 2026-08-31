import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../../services/api';
import LoomWorkflowPanel from './LoomWorkflowPanel';

vi.mock('../../services/api');

const episode = {
  id: 'ep-1', number: 1, storyOutline: { validation: { status: 'valid' } },
  startNodeId: 'scene-1',
  nodes: [{ id: 'scene-1', transitions: [], isEnding: true }],
};
const loom = {
  id: 'loom-1', name: 'Example Story', premise: 'A traveler needs a guide.',
  seriesPlan: {
    storyArc: 'Suspicion becomes trust.',
    plotPoints: [{ id: 'plot-1', title: 'Challenge — The gate', description: 'A costly choice.', episodeId: 'ep-1' }],
  },
  episodes: [episode],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getLoomEditorialAutopilotStatus.mockResolvedValue({
    run: { status: 'failed', round: 1, maxRounds: 3, stepIndex: 1, stepCount: 6 },
  });
});

describe('LoomWorkflowPanel', () => {
  it('shows the current production step and routes its action', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <LoomWorkflowPanel
        loom={loom}
        episode={episode}
        structural={{ stats: { errorCount: 0 } }}
        continuityReview={null}
        onAction={onAction}
      />,
    );

    expect(await screen.findByText('Step 7 of 12')).toBeInTheDocument();
    expect(screen.getByText(/Latest run: failed · step 1\/6/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Open series plan/i }));
    expect(onAction).toHaveBeenCalledWith('series-plan');
  });
});
