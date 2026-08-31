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
    plotPoints: [{ id: 'plot-1', kind: 'challenge', title: 'The gate', description: 'A costly choice.', episodeId: 'ep-1' }],
  },
  episodes: [episode],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getLoomEditorialAutopilotStatus.mockResolvedValue({
    run: { status: 'failed', round: 1, maxRounds: 3, stepIndex: 1, stepCount: 6 },
  });
  api.updateLoom.mockResolvedValue({
    ...loom,
    productionStatus: {
      editorialApprovedAt: '2026-08-30T12:00:00.000Z',
      editorialApprovalSource: 'manual',
      deliveryApprovedAt: null,
    },
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
    expect(screen.getByText(/Latest autopilot: failed · step 1\/6/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Open editorial tools/i }));
    expect(onAction).toHaveBeenCalledWith('editorial');
  });

  it('lets a human complete editorial review without running autopilot', async () => {
    const user = userEvent.setup();
    const onLoomUpdate = vi.fn();
    render(
      <LoomWorkflowPanel
        loom={loom}
        episode={episode}
        structural={{ stats: { errorCount: 0 } }}
        onLoomUpdate={onLoomUpdate}
      />,
    );

    await user.click(await screen.findByRole('button', { name: /Mark manual editorial review complete/i }));
    expect(api.updateLoom).toHaveBeenCalledWith('loom-1', {
      productionStatus: expect.objectContaining({
        editorialApprovedAt: expect.any(String),
        editorialApprovalSource: 'manual',
        deliveryApprovedAt: null,
      }),
    }, { silent: true });
    expect(onLoomUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'loom-1' }));
  });
});
