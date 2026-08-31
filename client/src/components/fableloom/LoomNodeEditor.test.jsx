import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  addLoomTransition: vi.fn(),
  branchLoomNode: vi.fn(),
  deleteLoomNode: vi.fn(),
  deleteLoomTransition: vi.fn(),
  updateLoomNode: vi.fn(),
  updateLoomTransition: vi.fn(),
}));

const pickerMocks = vi.hoisted(() => ({
  item: { id: 'upload-example', filename: 'upload-example.mp4' },
  props: vi.fn(),
}));
vi.mock('../videoGen/GalleryVideoPicker', () => ({
  default: (props) => {
    pickerMocks.props(props);
    return props.open ? (
      <button type="button" onClick={() => props.onSelect(pickerMocks.item)}>
        Pick gallery video
      </button>
    ) : null;
  },
}));

import {
  addLoomTransition, branchLoomNode, deleteLoomNode, deleteLoomTransition, updateLoomNode, updateLoomTransition,
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
  const onOpenFalVideo = vi.fn();
  render(
    <MemoryRouter>
      <LoomNodeEditor
        loom={loom}
        episode={episode}
        node={nodes[0]}
        universe={{
          id: 'universe-1',
          characters: [{ id: 'char-1', name: 'Aria', wardrobes: [{ id: 'coat', name: 'Travel coat' }] }],
          places: [{ id: 'place-1', name: 'Atrium' }],
          objects: [{ id: 'object-1', name: 'Compass' }],
        }}
        onLoomUpdate={onLoomUpdate}
        onClearSelection={() => {}}
        onGenerateImage={onGenerateImage}
        onGenerateVideo={onGenerateVideo}
        onOpenFalVideo={onOpenFalVideo}
      />
    </MemoryRouter>,
  );
  return { onLoomUpdate, onGenerateImage, onGenerateVideo, onOpenFalVideo };
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

const renderCanonicalEditor = (presence = 'onscreen') => {
  const nodes = makeNodes([]);
  nodes[0].protagonistPresence = presence;
  nodes[0].visualCanon = {
    mode: 'locked',
    characterAppearances: presence === 'offscreen' ? [{ characterId: 'char-1', wardrobeId: 'coat' }] : [],
    placeId: null,
    objectIds: [],
    continuitySourceNodeId: null,
    shotNotes: '',
    storyboardImageApproved: false,
  };
  const canonicalLoom = {
    ...loom,
    protagonistCharacterId: 'char-1',
    protagonistWardrobeId: 'coat',
    protagonistWardrobeLocked: true,
  };
  render(
    <MemoryRouter>
      <LoomNodeEditor
        loom={canonicalLoom}
        episode={{ id: 'ep-1', startNodeId: 'n1', nodes }}
        node={nodes[0]}
        universe={{
          id: 'universe-1',
          characters: [{ id: 'char-1', name: 'Aria', wardrobes: [{ id: 'coat', name: 'Travel coat' }] }],
          places: [],
          objects: [],
        }}
        onLoomUpdate={vi.fn()}
        onClearSelection={() => {}}
        onGenerateImage={vi.fn()}
        onGenerateVideo={vi.fn()}
      />
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  pickerMocks.item = { id: 'upload-example', filename: 'upload-example.mp4' };
});

describe('LoomNodeEditor paths', () => {
  it('requires confirmation before deleting a scene', async () => {
    const user = userEvent.setup();
    const onClearSelection = vi.fn();
    const nodes = makeNodes([]);
    deleteLoomNode.mockResolvedValue({ id: 'loom-1' });
    render(
      <LoomNodeEditor
        loom={loom}
        episode={{ id: 'ep-1', startNodeId: 'n1', nodes }}
        node={nodes[0]}
        onLoomUpdate={vi.fn()}
        onClearSelection={onClearSelection}
      />,
    );

    const trash = screen.getByRole('button', { name: 'Delete scene' });
    expect(trash).toHaveClass('min-h-[44px]', 'min-w-[44px]');
    await user.click(trash);

    expect(deleteLoomNode).not.toHaveBeenCalled();
    expect(screen.getByRole('group')).toHaveTextContent('Delete scene?');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteLoomNode).toHaveBeenCalledWith('loom-1', 'ep-1', 'n1'));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

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
  it('selects a protagonist from the linked Universe and surfaces reference readiness', async () => {
    const user = userEvent.setup();
    updateLoomNode.mockResolvedValue({ id: 'loom-1' });
    renderEditor();

    await user.click(screen.getByLabelText('Live conversation window (off-screen voice)'));
    await user.selectOptions(screen.getByLabelText('Protagonist character'), 'char-1');

    await waitFor(() => expect(updateLoomNode).toHaveBeenLastCalledWith(
      'loom-1', 'ep-1', 'n1', {
        interactionWindow: expect.objectContaining({
          enabled: true,
          protagonistCharacterId: 'char-1',
        }),
      }, { silent: true },
    ));
    expect(screen.getByRole('status')).toHaveTextContent('Needs character sheet');
    expect(screen.getByRole('link', { name: 'Open Universe character sheets' })).toHaveAttribute(
      'href', '/universes/universe-1?tab=cast',
    );
  });

  it('persists structured canon bindings and explicit storyboard approval', async () => {
    const user = userEvent.setup();
    updateLoomNode.mockResolvedValue({ id: 'loom-1' });
    renderEditor();

    await user.click(screen.getByLabelText('Bind this shot to Universe canon'));
    await user.click(screen.getByLabelText('Aria'));
    await user.selectOptions(screen.getByLabelText('Aria wardrobe'), 'coat');
    await user.selectOptions(screen.getByLabelText('Location'), 'place-1');
    await user.click(screen.getByLabelText('Compass'));
    await user.click(screen.getByLabelText("Approve the current storyboard image as this shot's video first frame"));

    await waitFor(() => expect(updateLoomNode).toHaveBeenLastCalledWith(
      'loom-1', 'ep-1', 'n1',
      { visualCanon: expect.objectContaining({
        mode: 'locked',
        characterAppearances: [expect.objectContaining({ characterId: 'char-1', wardrobeId: 'coat' })],
        placeId: 'place-1', objectIds: ['object-1'], storyboardImageApproved: true,
      }) },
      { silent: true },
    ));
  });

  it('offers the canonical protagonist as a one-click visual-cast binding', async () => {
    const user = userEvent.setup();
    updateLoomNode.mockResolvedValue({ id: 'loom-1' });
    renderCanonicalEditor();

    await user.click(screen.getByRole('button', { name: 'Add canonical protagonist to visual cast' }));

    await waitFor(() => expect(updateLoomNode).toHaveBeenCalledWith(
      'loom-1', 'ep-1', 'n1', {
        visualCanon: expect.objectContaining({
          characterAppearances: [{
            characterId: 'char-1', wardrobeId: 'coat', expression: '', continuityNotes: '',
          }],
        }),
      }, { silent: true },
    ));
  });

  it('removes the protagonist visual binding when a scene becomes off-screen', async () => {
    const user = userEvent.setup();
    updateLoomNode.mockResolvedValue({ id: 'loom-1' });
    renderCanonicalEditor('offscreen');

    await user.selectOptions(screen.getByLabelText('Visual protagonist presence'), 'offscreen');

    await waitFor(() => expect(updateLoomNode).toHaveBeenCalledWith(
      'loom-1', 'ep-1', 'n1', {
        protagonistPresence: 'offscreen',
        visualCanon: expect.objectContaining({ characterAppearances: [] }),
      }, { silent: true },
    ));
    expect(screen.getByText(/Side-device conversation/)).toBeInTheDocument();
  });

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

  it('hands the current scene direction to the fal free tool without waiting on a save', async () => {
    const user = userEvent.setup();
    const { onOpenFalVideo } = renderEditor();

    await user.clear(screen.getByLabelText('Video prompt'));
    await user.type(screen.getByLabelText('Video prompt'), 'A fast practical-effects reveal.');
    await user.click(screen.getByRole('button', { name: 'fal.ai free' }));

    expect(onOpenFalVideo).toHaveBeenCalledWith(expect.objectContaining({
      id: 'n1',
      videoPrompt: 'A fast practical-effects reveal.',
      cameraMovement: 'slow-dolly-in',
    }));
  });

  it('attaches an uploaded fal MP4 through the durable gallery history id', async () => {
    const user = userEvent.setup();
    updateLoomNode.mockResolvedValue({ id: 'loom-1' });
    renderEditor();

    await user.click(screen.getByRole('button', { name: 'Attach video' }));
    expect(pickerMocks.props).toHaveBeenLastCalledWith(expect.objectContaining({
      accept: 'video/mp4,.mp4',
    }));
    await user.click(screen.getByRole('button', { name: 'Pick gallery video' }));

    await waitFor(() => expect(updateLoomNode).toHaveBeenCalledWith(
      'loom-1', 'ep-1', 'n1', { videoHistoryId: 'upload-example' }, { silent: true },
    ));
  });

  it('refuses a non-MP4 history record that scene playback cannot address', async () => {
    const user = userEvent.setup();
    pickerMocks.item = { id: 'upload-example', filename: 'upload-example.mov' };
    renderEditor();

    await user.click(screen.getByRole('button', { name: 'Attach video' }));
    await user.click(screen.getByRole('button', { name: 'Pick gallery video' }));

    expect(updateLoomNode).not.toHaveBeenCalled();
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

  it('toggles live interaction window and patches node', async () => {
    const user = userEvent.setup();
    updateLoomNode.mockResolvedValue({ id: 'loom-1' });
    renderEditor();

    const checkbox = screen.getByLabelText('Live conversation window (off-screen voice)');
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);

    await waitFor(() => expect(updateLoomNode).toHaveBeenCalledWith(
      'loom-1', 'ep-1', 'n1',
      {
        interactionWindow: expect.objectContaining({
          enabled: true,
        }),
      },
      { silent: true },
    ));

    expect(screen.getByLabelText('Protagonist character')).toBeInTheDocument();
    expect(screen.getByLabelText('Protagonist presence')).toBeInTheDocument();
  });

  it('displays production readiness findings for unsafe hold loop dialogue', () => {
    const nodes = makeNodes([existingPath]);
    nodes[0].interactionWindow = { enabled: true, protagonistCharacterId: 'char-1' };
    nodes[0].playbackAssets = {
      holdLoopVideoHistoryIds: ['vid-hold-1'],
      audioOccupancy: {
        'vid-hold-1': {
          characterDialogue: [{ startMs: 0, endMs: 2000 }],
        },
      },
    };

    render(
      <LoomNodeEditor
        loom={loom}
        episode={{ id: 'ep-1', nodes }}
        node={nodes[0]}
        onLoomUpdate={vi.fn()}
        onClearSelection={() => {}}
      />,
    );

    expect(screen.getByText(/contains rendered character dialogue/)).toBeInTheDocument();
    expect(screen.getByText(/Tip: Render dialogue separately/)).toBeInTheDocument();
  });
});
