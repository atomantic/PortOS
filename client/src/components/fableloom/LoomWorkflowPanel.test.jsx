import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../../services/api';
import socket from '../../services/socket';
import LoomWorkflowPanel from './LoomWorkflowPanel';

vi.mock('../../services/api');
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

const editorialEvent = (payload) => socket.on.mock.calls
  .filter(([name]) => name === 'fableloom:editorial:run').at(-1)[1](payload);

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
    run: {
      id: 'run-1', loomId: 'loom-1', createdAt: '2026-08-30T12:00:00.000Z',
      status: 'failed', round: 1, maxRounds: 3, stepIndex: 1, stepCount: 6,
    },
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

  it('follows the editorial run from socket pushes instead of re-reading on a timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <LoomWorkflowPanel
          loom={loom}
          episode={episode}
          structural={{ stats: { errorCount: 0 } }}
        />,
      );
      expect(await screen.findByText(/Latest autopilot: failed · step 1\/6/i)).toBeInTheDocument();

      await act(async () => { vi.advanceTimersByTime(30_000); });
      expect(api.getLoomEditorialAutopilotStatus).toHaveBeenCalledTimes(1);

      act(() => editorialEvent({
        id: 'run-2', loomId: 'loom-1', createdAt: '2026-08-30T12:05:00.000Z',
        status: 'running', round: 2, maxRounds: 3, stepIndex: 3, stepCount: 6,
      }));
      expect(screen.getByText(/Latest autopilot: running · step 3\/6/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
