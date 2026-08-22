import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({ playLoomTurn: vi.fn() }));
vi.mock('../MediaImage', () => ({ default: () => null }));

import { playLoomTurn } from '../../services/api';
import LoomPlayPanel from './LoomPlayPanel';

const loom = { id: 'loom-1', name: 'The Hollow Crown' };
const episode = {
  id: 'ep-1',
  startNodeId: 'n1',
  nodes: [
    {
      id: 'n1',
      title: 'The Gate',
      prose: 'You stand before it.',
      transitions: [{ id: 't1', targetNodeId: 'n2', intent: 'enter the gate', triggers: [], description: '' }],
    },
    { id: 'n2', title: 'Inside', prose: 'Torchlight.', isEnding: false, transitions: [{ id: 't2', targetNodeId: 'n1', intent: 'retreat', triggers: [], description: '' }] },
  ],
};

const sendMessage = async (user, text) => {
  await user.type(screen.getByLabelText('Your action'), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
};

beforeEach(() => vi.clearAllMocks());

describe('LoomPlayPanel', () => {
  it('renders the opening scene with intent hint chips', () => {
    render(<LoomPlayPanel loom={loom} episode={episode} />);
    expect(screen.getByText('You stand before it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take path: enter the gate' })).toBeInTheDocument();
  });

  it('sends a tapped path as a transition id, not as free text to match', async () => {
    const user = userEvent.setup();
    playLoomTurn.mockResolvedValue({
      action: 'move',
      resolvedBy: 'choice',
      narration: '',
      ended: false,
      node: { id: 'n2', title: 'Inside', prose: 'Torchlight.', isEnding: false, choices: [{ id: 't2', intent: 'retreat' }] },
    });
    render(<LoomPlayPanel loom={loom} episode={episode} />);
    await user.click(screen.getByRole('button', { name: 'Take path: enter the gate' }));

    await waitFor(() => expect(playLoomTurn).toHaveBeenCalledTimes(1));
    const [, , payload] = playLoomTurn.mock.calls[0];
    // No `message`: nothing for the play stage to match, so it never runs.
    expect(payload).toMatchObject({ nodeId: 'n1', transitionId: 't1' });
    expect(payload.message).toBeUndefined();
    // The reader's choice reads back in the transcript, and the scene advanced.
    expect(screen.getByText('enter the gate')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take path: retreat' })).toBeInTheDocument());
  });

  it('sends typed text as a message for the play stage to match', async () => {
    const user = userEvent.setup();
    playLoomTurn.mockResolvedValue({ action: 'stay', narration: 'You hesitate.', ended: false });
    render(<LoomPlayPanel loom={loom} episode={episode} />);

    await sendMessage(user, 'look at the lock');
    await waitFor(() => expect(playLoomTurn).toHaveBeenCalledTimes(1));
    const [, , payload] = playLoomTurn.mock.calls[0];
    expect(payload).toMatchObject({ message: 'look at the lock' });
    expect(payload.transitionId).toBeUndefined();
  });

  it('renders teleplay scenes monospaced', () => {
    render(<LoomPlayPanel loom={{ ...loom, format: 'teleplay' }} episode={episode} />);
    expect(screen.getByText('You stand before it.').className).toContain('font-mono');
  });

  it('sends only reader/narrator turns in the transcript after a scene move', async () => {
    const user = userEvent.setup();
    playLoomTurn
      .mockResolvedValueOnce({
        action: 'move',
        narration: 'You step through.',
        ended: false,
        node: { id: 'n2', title: 'Inside', prose: 'Torchlight.', isEnding: false, choices: [{ id: 't2', intent: 'retreat' }] },
      })
      .mockResolvedValueOnce({ action: 'stay', narration: 'You hesitate.', ended: false });

    render(<LoomPlayPanel loom={loom} episode={episode} />);
    await sendMessage(user, 'go in');
    await waitFor(() => expect(screen.getByText('You step through.')).toBeInTheDocument());

    // Second turn: the transcript state now holds a scene card — the payload
    // must contain only reader/narrator text turns or the API rejects it.
    await sendMessage(user, 'look around');
    await waitFor(() => expect(playLoomTurn).toHaveBeenCalledTimes(2));
    const [, , payload] = playLoomTurn.mock.calls[1];
    expect(payload.nodeId).toBe('n2');
    // Length first: `every()` is vacuously true on an empty array, so a filter
    // that dropped EVERY turn would pass the role/text assertions below.
    expect(payload.transcript).toHaveLength(3);
    expect(payload.transcript).toEqual([
      { role: 'reader', text: 'go in' },
      { role: 'narrator', text: 'You step through.' },
      { role: 'reader', text: 'look around' },
    ]);
  });

  it('never leaves a turn silent when the server moves nowhere and says nothing', async () => {
    const user = userEvent.setup();
    // A path whose target scene the author deleted: the edge is deliberately
    // kept on the graph, and the server answers stay-with-no-narration.
    playLoomTurn.mockResolvedValue({ action: 'stay', narration: '', ended: false });
    render(<LoomPlayPanel loom={loom} episode={episode} />);
    await user.click(screen.getByRole('button', { name: 'Take path: enter the gate' }));

    await waitFor(() => expect(playLoomTurn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Nothing comes of it.')).toBeInTheDocument());
  });
});
