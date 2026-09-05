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
  it('starts with a clear collapsed scene tree and expands a scene on demand', async () => {
    const user = userEvent.setup();
    render(<LoomEpisodeOutline loom={{ name: 'Example Loom', format: 'prose' }} episode={episode} />);

    expect(screen.getByRole('heading', { name: 'The First Door' })).toBeInTheDocument();
    expect(screen.getByText('Threshold')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unreachable scenes' })).toBeInTheDocument();
    expect(screen.getByText('Forgotten Hall')).toBeInTheDocument();
    expect(screen.getByText('Awakened')).toBeInTheDocument();

    const firstScene = screen.getByTestId('outline-scene-node-1');
    const firstDetails = firstScene.querySelector('details');
    expect(firstDetails).not.toHaveAttribute('open');
    expect(screen.getAllByTestId(/^outline-scene-/).every((scene) => !scene.querySelector('details').open)).toBe(true);

    await user.click(firstDetails.querySelector('summary'));
    expect(firstDetails).toHaveAttribute('open');
    expect(screen.getByText('You stand before the first door.')).toBeVisible();
    expect(screen.getByText('Open it')).toBeVisible();
  });

  it('returns to the visual editor when a path destination is selected', async () => {
    const onSelectNode = vi.fn();
    const user = userEvent.setup();
    render(<LoomEpisodeOutline loom={{ name: 'Example Loom', format: 'prose' }} episode={episode} onSelectNode={onSelectNode} />);

    const firstScene = screen.getByTestId('outline-scene-node-1');
    await user.click(firstScene.querySelector('summary'));
    await user.click(screen.getByRole('button', { name: /Scene 2: The Chamber/ }));
    expect(onSelectNode).toHaveBeenCalledWith('node-2');
  });

  it('surfaces on-screen versus side-device protagonist beats in the teleplay review', () => {
    const reviewedEpisode = {
      ...episode,
      nodes: episode.nodes.map((node, index) => ({
        ...node,
        protagonistPresence: index === 0 ? 'onscreen' : 'offscreen',
      })),
      storyOutline: {
        validation: { status: 'valid' },
        scenes: [{
          key: 's1', title: 'The choice', summary: 'The viewer speaks through the communicator.',
          protagonistPresence: 'offscreen',
        }],
      },
    };
    render(<LoomEpisodeOutline loom={{ name: 'Example Loom', format: 'prose' }} episode={reviewedEpisode} />);

    expect(screen.getAllByText('Protagonist on-screen')).toHaveLength(1);
    expect(screen.getAllByText('Protagonist off-screen · side-device')).toHaveLength(3);
  });

  it('groups persisted cuts under their dramatic scene without repeating the expanded script as beats', async () => {
    const timed = { ...episode, nodes: episode.nodes.slice(0, 2).map((node) => ({ ...node, shot: { dramaticSceneId: 'dramatic-1', dramaticSceneTitle: 'The encounter', durationSeconds: 8, framing: 'Close-up' } })), storyOutline: { scenes: [{ key: 'beat', title: 'Duplicate script', summary: 'Do not repeat this.' }] } };
    render(<LoomEpisodeOutline loom={{ name: 'Example Loom' }} episode={timed} />);
    expect(screen.getByText('1 dramatic scenes · 2 camera shots')).toBeInTheDocument();
    expect(screen.queryByText('Duplicate script')).not.toBeInTheDocument();
    const group = screen.getByText('The encounter · 2 shots · 16s');
    expect(group.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(group);
    expect(group.closest('details')).toHaveAttribute('open');
    expect(screen.getAllByText('8s · Close-up')).toHaveLength(2);
  });

  it('explains when an episode has no scenes', () => {
    render(<LoomEpisodeOutline loom={{ name: 'Example Loom', format: 'prose' }} episode={{ ...episode, nodes: [], startNodeId: null }} />);

    expect(screen.getByRole('heading', { name: 'No scenes yet' })).toBeInTheDocument();
  });
});
