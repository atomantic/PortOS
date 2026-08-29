import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  addLoomTransition: vi.fn(),
  branchLoomNode: vi.fn(),
  deleteLoomNode: vi.fn(),
  deleteLoomTransition: vi.fn(),
  updateLoomNode: vi.fn(),
  updateLoomTransition: vi.fn(),
}));

import {
  addLoomTransition, branchLoomNode, deleteLoomTransition, updateLoomNode, updateLoomTransition,
} from '../../services/api';
import LoomNodeEditor from './LoomNodeEditor';

const loom = { id: 'loom-1', name: 'Example Story', format: 'teleplay', styleNotes: '' };
const scene = 'EXT. ANCIENT GATE - NIGHT\n\nThe gate groans open.';

// One scene with a single existing path, plus a second scene to point at.
const makeNodes = (transitions) => ([
  {
    id: 'n1', title: 'The Gate', prose: scene, image: 'scene.png',
    imagePrompt: 'an ancient gate', videoPrompt: 'The gate opens in one continuous shot.',
    cameraMovement: 'slow-dolly-in', transitions,
    playbackMode: 'decision',
  },
  { id: 'n2', title: 'Inside', prose: 'Torchlight.', transitions: [] },
]);

const existingPath = { id: 'tr-1', targetNodeId: 'n2', intent: 'enter', triggers: ['go in'], description: '' };

const renderEditor = (transitions = [existingPath]) => {
  const nodes = makeNodes(transitions);
  const episode = { id: 'ep-1', startNodeId: 'n1', nodes };
  const onLoomUpdate = vi.fn();
  const onGenerateImage = vi.fn().mockResolvedValue({ jobId: 'image-1' });
  const onGenerateVideo = vi.fn().mockResolvedValue({ jobId: 'video-1' });
  render(
    <LoomNodeEditor
      loom={loom}
      episode={episode}
      node={nodes[0]}
      onLoomUpdate={onLoomUpdate}
      onClearSelection={() => {}}
      onGenerateImage={onGenerateImage}
      onGenerateVideo={onGenerateVideo}
    />,
  );
  return { onLoomUpdate, onGenerateImage, onGenerateVideo };
};

const renderHelperEditor = () => {
  const nodes = makeNodes([existingPath]);
  nodes[0].audienceConnection = 'connected';
  const helperLoom = {
    ...loom,
    participationMode: 'helper',
    audienceCommunicationMedium: 'a field radio',
  };
  render(
    <LoomNodeEditor
      loom={helperLoom}
      episode={{ id: 'ep-1', startNodeId: 'n1', nodes }}
      node={nodes[0]}
      onLoomUpdate={vi.fn()}
      onClearSelection={() => {}}
    />,
  );
};

beforeEach(() => vi.clearAllMocks());

describe('LoomNodeEditor paths', () => {
  it('creates a path server-side first, so the new row already carries its id', async () => {
    const user = userEvent.setup();
    const minted = { id: 'tr-9', targetNodeId: 'n2', intent: '', triggers: [], description: '' };
    addLoomTransition.mockResolvedValue({ loom: { id: 'loom-1' }, transition: minted });
    const { onLoomUpdate } = renderEditor([]);

    await user.click(screen.getByRole('button', { name: '+ Add path' }));

    await waitFor(() => expect(addLoomTransition).toHaveBeenCalledTimes(1));
    expect(addLoomTransition).toHaveBeenCalledWith(
      'loom-1', 'ep-1', 'n1', { targetNodeId: 'n2', intent: '' }, { silent: true },
    );
    expect(onLoomUpdate).toHaveBeenCalledWith({ id: 'loom-1' });
    await waitFor(() => expect(screen.getByText('Viewer paths (1)')).toBeInTheDocument());
    // The whole-array node PATCH is not how a path is added any more.
    expect(updateLoomNode).not.toHaveBeenCalled();
  });

  it('saves one edited row by id rather than replaying the array', async () => {
    const user = userEvent.setup();
    updateLoomTransition.mockResolvedValue({ id: 'loom-1' });
    renderEditor();

    const intent = screen.getByLabelText('Intent');
    await user.clear(intent);
    await user.type(intent, 'slip past');
    await user.tab();

    await waitFor(() => expect(updateLoomTransition).toHaveBeenCalledTimes(1));
    expect(updateLoomTransition).toHaveBeenCalledWith('loom-1', 'ep-1', 'n1', 'tr-1', {
      targetNodeId: 'n2', intent: 'slip past', triggers: ['go in'], description: '',
    }, { silent: true });
    expect(updateLoomNode).not.toHaveBeenCalled();
  });

  it('skips the round-trip when a blurred row still matches the record', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByLabelText('Intent'));
    await user.tab();

    expect(updateLoomTransition).not.toHaveBeenCalled();
  });

  it('deletes one path by id', async () => {
    const user = userEvent.setup();
    deleteLoomTransition.mockResolvedValue({ id: 'loom-1' });
    const { onLoomUpdate } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Remove path' }));

    await waitFor(() => expect(deleteLoomTransition).toHaveBeenCalledTimes(1));
    expect(deleteLoomTransition).toHaveBeenCalledWith('loom-1', 'ep-1', 'n1', 'tr-1', { silent: true });
    expect(onLoomUpdate).toHaveBeenCalledWith({ id: 'loom-1' });
    expect(screen.getByText('Viewer paths (0)')).toBeInTheDocument();
  });
});

describe('LoomNodeEditor scene media', () => {
  it('queues a local video from the teleplay scene and rendered still', async () => {
    const user = userEvent.setup();
    const { onGenerateVideo } = renderEditor();

    expect(screen.getByLabelText('Video prompt')).toHaveValue('The gate opens in one continuous shot.');
    expect(screen.getByLabelText('Camera movement')).toHaveValue('slow-dolly-in');
    await user.click(screen.getByRole('button', { name: 'Generate video' }));

    await waitFor(() => expect(onGenerateVideo).toHaveBeenCalledTimes(1));
    expect(onGenerateVideo).toHaveBeenCalledWith(expect.objectContaining({
      id: 'n1', prose: scene, image: 'scene.png',
      videoPrompt: 'The gate opens in one continuous shot.', cameraMovement: 'slow-dolly-in',
    }));
  });

  it('uses the scene for text-to-video when no rendered still exists', async () => {
    const user = userEvent.setup();
    const onGenerateVideo = vi.fn().mockResolvedValue({ jobId: 'video-2' });
    const nodes = makeNodes([]).map((node) => node.id === 'n1'
      ? { ...node, image: null, videoPrompt: '', cameraMovement: '' }
      : node);
    render(
      <LoomNodeEditor
        loom={loom}
        episode={{ id: 'ep-1', nodes }}
        node={nodes[0]}
        onLoomUpdate={vi.fn()}
        onClearSelection={() => {}}
        onGenerateImage={vi.fn()}
        onGenerateVideo={onGenerateVideo}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Generate video' }));

    await waitFor(() => expect(onGenerateVideo).toHaveBeenCalledTimes(1));
    expect(onGenerateVideo).toHaveBeenCalledWith(expect.objectContaining({
      prose: scene, videoPrompt: '', image: null,
    }));
  });

  it('persists a selected camera movement from the shared vocabulary', async () => {
    const user = userEvent.setup();
    updateLoomNode.mockResolvedValue({ id: 'loom-1' });
    renderEditor();

    await user.selectOptions(screen.getByLabelText('Camera movement'), 'orbit-180');

    await waitFor(() => expect(updateLoomNode).toHaveBeenCalledWith(
      'loom-1', 'ep-1', 'n1', { cameraMovement: 'orbit-180' }, { silent: true },
    ));
  });

  it('marks a scene as an automatic cut', async () => {
    const user = userEvent.setup();
    updateLoomNode.mockResolvedValue({ id: 'loom-1' });
    renderEditor();

    await user.selectOptions(screen.getByLabelText('Playback behavior'), 'cut');

    await waitFor(() => expect(updateLoomNode).toHaveBeenCalledWith(
      'loom-1', 'ep-1', 'n1', { playbackMode: 'cut' }, { silent: true },
    ));
  });

  it('turns a helper scene into an automatic cut when its audience channel disconnects', async () => {
    const user = userEvent.setup();
    updateLoomNode.mockResolvedValue({ id: 'loom-1' });
    renderHelperEditor();

    expect(screen.getByText(/hear the audience through a field radio/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Audience connection'), 'disconnected');

    await waitFor(() => expect(updateLoomNode).toHaveBeenCalledWith(
      'loom-1', 'ep-1', 'n1',
      { audienceConnection: 'disconnected', playbackMode: 'cut' },
      { silent: true },
    ));
  });

  it('reflects the decision mode applied when AI adds branches', async () => {
    const user = userEvent.setup();
    const nodes = makeNodes([existingPath]);
    nodes[0].playbackMode = 'cut';
    branchLoomNode.mockResolvedValue({
      loom: { ...loom, episodes: [{ id: 'ep-1', nodes: [{ ...nodes[0], playbackMode: 'decision' }] }] },
    });
    render(
      <LoomNodeEditor
        loom={loom}
        episode={{ id: 'ep-1', nodes }}
        node={nodes[0]}
        onLoomUpdate={vi.fn()}
        onClearSelection={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Branch with AI' }));

    await waitFor(() => expect(screen.getByLabelText('Playback behavior')).toHaveValue('decision'));
  });
});
