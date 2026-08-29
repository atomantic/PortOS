import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoomEpisodeOutline from './LoomEpisodeOutline';

const episode = {
  id: 'ep-1',
  title: 'The First Door',
  synopsis: 'A choice waits in the dark.',
  format: 'prose',
  startNodeId: 'node-1',
  nodes: [
    {
      id: 'node-1',
      title: 'Threshold',
      prose: 'You stand before the first door.',
      transitions: [{ id: 'tr-1', intent: 'Open it', description: 'Face what waits inside.', targetNodeId: 'node-2' }],
    },
    { id: 'node-2', title: 'The Chamber', prose: 'A blue light fills the room.', isEnding: true, endingLabel: 'Awakened', transitions: [] },
    { id: 'node-3', title: 'Forgotten Hall', prose: 'Dust gathers here.', transitions: [] },
  ],
};

describe('LoomEpisodeOutline', () => {
  it('shows scenes in story order with authored text, paths, and unreachable scenes', () => {
    render(<LoomEpisodeOutline loom={{ name: 'Example Loom', format: 'prose' }} episode={episode} />);

    expect(screen.getByRole('heading', { name: 'The First Door' })).toBeInTheDocument();
    expect(screen.getByText('You stand before the first door.')).toBeInTheDocument();
    expect(screen.getByText('Open it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scene 2: The Chamber/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unreachable scenes' })).toBeInTheDocument();
    expect(screen.getByText('Forgotten Hall')).toBeInTheDocument();
    expect(screen.getByText('Awakened')).toBeInTheDocument();
  });

  it('returns to the visual editor when a path destination is selected', async () => {
    const onSelectNode = vi.fn();
    const user = userEvent.setup();
    render(<LoomEpisodeOutline loom={{ name: 'Example Loom', format: 'prose' }} episode={episode} onSelectNode={onSelectNode} />);

    await user.click(screen.getByRole('button', { name: /Scene 2: The Chamber/ }));
    expect(onSelectNode).toHaveBeenCalledWith('node-2');
  });

  it('explains when an episode has no scenes', () => {
    render(<LoomEpisodeOutline loom={{ name: 'Example Loom', format: 'prose' }} episode={{ ...episode, nodes: [], startNodeId: null }} />);

    expect(screen.getByRole('heading', { name: 'No scenes yet' })).toBeInTheDocument();
  });
});
