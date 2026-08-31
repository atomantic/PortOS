import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({ playLoomTurn: vi.fn() }));
vi.mock('../MediaImage', () => ({ default: (props) => <img alt="" {...props} /> }));

import { playLoomTurn } from '../../services/api';
import LoomPlayPanel from './LoomPlayPanel';

const loom = { id: 'loom-1', name: 'The Hollow Crown', episodes: [] };
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
  it('presents produced media as the main stage with the teleplay beside it', () => {
    const onClose = vi.fn();
    const producedEpisode = {
      ...episode,
      nodes: [{ ...episode.nodes[0], image: 'opening-still.png' }, episode.nodes[1]],
    };

    render(<LoomPlayPanel
      loom={{ ...loom, format: 'teleplay', episodes: [producedEpisode] }}
      episode={producedEpisode}
      onClose={onClose}
    />);

    expect(screen.getByRole('region', { name: 'Scene media' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Teleplay' })).toHaveTextContent('You stand before it.');
    expect(screen.getByRole('img', { name: 'The Gate' })).toHaveClass('h-full', 'w-full', 'object-contain');
    expect(screen.getByLabelText('Preview stage')).toHaveValue('image');

    fireEvent.click(screen.getByRole('button', { name: 'Close player' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the opening scene with intent hint chips', () => {
    render(<LoomPlayPanel loom={loom} episode={episode} />);
    expect(screen.getByText('You stand before it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take path: enter the gate' })).toBeInTheDocument();
  });

  it('keeps the scene description and dialogue visible in storyboard image mode', async () => {
    const user = userEvent.setup();
    render(<LoomPlayPanel loom={loom} episode={episode} />);

    await user.selectOptions(screen.getByLabelText('Preview stage'), 'image');

    expect(screen.getByText('Scene description & dialogue')).toBeInTheDocument();
    expect(screen.getByText('You stand before it.')).toBeInTheDocument();
  });

  it('keeps a helper audience passive and follows the first canon path until the channel connects', async () => {
    const user = userEvent.setup();
    const helperEpisode = {
      id: 'ep-helper', startNodeId: 'opening', nodes: [{
        id: 'opening', title: 'Opening', prose: 'The protagonist walks alone.',
        playbackMode: 'cut', audienceConnection: 'disconnected',
        transitions: [
          { id: 'continue', targetNodeId: 'radio', intent: 'Continue' },
          { id: 'legacy-choice', targetNodeId: 'other', intent: 'Legacy choice' },
        ],
      }, {
        id: 'radio', title: 'Radio', prose: 'The radio crackles.',
        playbackMode: 'decision', audienceConnection: 'connected',
        transitions: [{ id: 'answer', targetNodeId: 'end', intent: 'warn them' }],
      }],
    };
    playLoomTurn.mockResolvedValue({
      action: 'move', resolvedBy: 'graph', narration: '', ended: false,
      node: {
        id: 'radio', title: 'Radio', prose: 'The radio crackles.',
        playbackMode: 'decision', audienceConnection: 'connected', choices: [],
      },
    });
    render(<LoomPlayPanel
      loom={{
        ...loom,
        participationMode: 'helper',
        audienceCommunicationMedium: 'the crystal radio',
        episodes: [helperEpisode],
      }}
      episode={helperEpisode}
    />);

    expect(screen.getByText(/Connection unavailable/)).toHaveTextContent('the crystal radio');
    expect(screen.queryByLabelText('Your action')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take path: Continue' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next cut' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Next cut' }));
    await waitFor(() => expect(playLoomTurn).toHaveBeenCalledWith(
      'loom-1', 'ep-helper', expect.objectContaining({ transitionId: 'continue' }), { silent: true },
    ));
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
    expect(screen.getByText('You stand before it.')).toBeInTheDocument();
    expect(screen.getByText('Torchlight.')).toBeInTheDocument();
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

  it('auto-advances a rendered cut when its video ends', async () => {
    const cutEpisode = {
      id: 'ep-cut', number: 1, title: 'Pilot', startNodeId: 'cut-1', nodes: [{
        id: 'cut-1', title: 'Setup', prose: 'A door opens.', playbackMode: 'cut', videoHistoryId: 'video-1',
        transitions: [{ id: 'continue-1', targetNodeId: 'decision-1', intent: 'Continue' }],
      }, {
        id: 'decision-1', title: 'Wait', prose: 'A guard paces.', playbackMode: 'decision', transitions: [],
      }],
    };
    playLoomTurn.mockResolvedValue({
      action: 'move', narration: '', ended: true,
      node: { id: 'decision-1', title: 'Wait', prose: 'A guard paces.', playbackMode: 'decision', choices: [] },
    });
    const user = userEvent.setup();
    render(<LoomPlayPanel loom={{ ...loom, episodes: [cutEpisode] }} episode={cutEpisode} />);
    await user.selectOptions(screen.getByLabelText('Preview stage'), 'video');

    expect(screen.getByRole('button', { name: 'Video advances automatically' })).toBeDisabled();

    fireEvent.ended(screen.getByLabelText('Setup'));

    await waitFor(() => expect(playLoomTurn).toHaveBeenCalledWith(
      'loom-1', 'ep-cut', expect.objectContaining({ nodeId: 'cut-1', transitionId: 'continue-1' }), { silent: true },
    ));
    await waitFor(() => expect(screen.getAllByText('Wait')).not.toHaveLength(0));
    expect(screen.getByText('A door opens.')).toBeInTheDocument();
    expect(screen.getByText('A guard paces.')).toBeInTheDocument();
  });

  it('loops rendered decision video while waiting for input', async () => {
    const decisionEpisode = {
      id: 'ep-loop', number: 1, title: 'Pilot', startNodeId: 'decision-1', nodes: [{
        id: 'decision-1', title: 'Guard patrol', prose: 'A guard paces.', playbackMode: 'decision', videoHistoryId: 'video-loop',
        transitions: [{ id: 'go', targetNodeId: 'end', intent: 'cross now' }],
      }, { id: 'end', title: 'Across', isEnding: true, transitions: [] }],
    };
    const user = userEvent.setup();
    render(<LoomPlayPanel loom={{ ...loom, episodes: [decisionEpisode] }} episode={decisionEpisode} />);
    await user.selectOptions(screen.getByLabelText('Preview stage'), 'video');

    expect(screen.getByLabelText('Guard patrol')).toHaveProperty('loop', true);
    expect(screen.getByRole('button', { name: 'Take path: cross now' })).toBeInTheDocument();
  });

  it('restores manual cut controls when a rendered video cannot load', async () => {
    const cutEpisode = {
      id: 'ep-cut', startNodeId: 'cut-1', nodes: [{
        id: 'cut-1', title: 'Setup', prose: 'A door opens.', playbackMode: 'cut', videoHistoryId: 'missing-video',
        transitions: [{ id: 'continue-1', targetNodeId: 'next', intent: 'Continue' }],
      }, { id: 'next', isEnding: true, transitions: [] }],
    };
    const user = userEvent.setup();
    render(<LoomPlayPanel loom={{ ...loom, episodes: [cutEpisode] }} episode={cutEpisode} />);
    await user.selectOptions(screen.getByLabelText('Preview stage'), 'video');

    fireEvent.error(screen.getByLabelText('Setup'));

    expect(await screen.findByText('The rendered video is unavailable; advance manually or retry after rendering.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next cut' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled();
  });

  it('shows "not rendered yet" rather than "unavailable" for a scene that was never rendered', async () => {
    // Regression: failedVideoId starts at null and the server also sends
    // videoHistoryId: null for an unrendered scene, so a naive
    // `failedVideoId === scene.videoHistoryId` comparison was `null === null`
    // -> true, mislabeling every never-rendered scene as a failed render.
    const cutEpisode = {
      id: 'ep-cut-none', startNodeId: 'cut-1', nodes: [{
        id: 'cut-1', title: 'Setup', prose: 'A door opens.', playbackMode: 'cut', videoHistoryId: null,
        transitions: [{ id: 'continue-1', targetNodeId: 'next', intent: 'Continue' }],
      }, { id: 'next', isEnding: true, transitions: [] }],
    };
    const user = userEvent.setup();
    render(<LoomPlayPanel loom={{ ...loom, episodes: [cutEpisode] }} episode={cutEpisode} />);
    await user.selectOptions(screen.getByLabelText('Preview stage'), 'video');

    expect(screen.getByText('No video rendered for this cut yet.')).toBeInTheDocument();
    expect(screen.queryByText('The rendered video is unavailable; advance manually or retry after rendering.')).not.toBeInTheDocument();
  });

  it('continues to the next playable episode and resets the transcript', async () => {
    const first = {
      id: 'ep-1', number: 1, title: 'One', startNodeId: 'end-1',
      nodes: [{ id: 'end-1', title: 'First ending', prose: 'Episode one ends.', isEnding: true, transitions: [] }],
    };
    const second = {
      id: 'ep-2', number: 2, title: 'Two', startNodeId: 'start-2',
      nodes: [{ id: 'start-2', title: 'Second opening', prose: 'Episode two begins.', transitions: [{ id: 'wait', targetNodeId: 'start-2', intent: 'wait' }] }],
    };
    const user = userEvent.setup();
    render(<LoomPlayPanel loom={{ ...loom, episodes: [first, second] }} episode={first} />);

    await user.click(screen.getByRole('button', { name: 'Next: Episode 2' }));

    expect(await screen.findByText('Episode two begins.')).toBeInTheDocument();
    expect(screen.queryByText('Episode one ends.')).not.toBeInTheDocument();
  });

  it('shows an authored overnight voicemail at an episode boundary', async () => {
    const first = {
      id: 'ep-1', number: 1, title: 'One', startNodeId: 'end-1',
      nodes: [{ id: 'end-1', title: 'First ending', prose: 'Episode one ends.', isEnding: true, transitions: [] }],
    };
    const second = {
      id: 'ep-2', number: 2, title: 'Two', startNodeId: 'start-2',
      nodes: [{ id: 'start-2', title: 'Second opening', prose: 'Episode two begins.', transitions: [] }],
    };
    render(<LoomPlayPanel
      loom={{
        ...loom,
        episodes: [first, second],
        seriesPlan: {
          deliveryOptions: { overnightVoicemails: true, nextSeasonTeaser: false },
          interEpisodeVoicemails: [{
            id: 'vm-1', fromEpisodeId: 'ep-1', toEpisodeId: 'ep-2',
            title: 'A voice in the dark', transcript: 'Don’t let the signal go cold.',
          }],
        },
      }}
      episode={first}
    />);

    expect(screen.getByRole('region', { name: 'Overnight voicemail · Episode 1 → Episode 2' })).toHaveTextContent(
      'Don’t let the signal go cold.',
    );
  });

  it('shows a configured next-season teaser after the final ending', () => {
    const finale = {
      id: 'ep-final', number: 3, title: 'Finale', startNodeId: 'end-final',
      nodes: [{ id: 'end-final', title: 'Final ending', prose: 'The season closes.', isEnding: true, transitions: [] }],
    };
    render(<LoomPlayPanel
      loom={{
        ...loom,
        episodes: [finale],
        seriesPlan: {
          deliveryOptions: { overnightVoicemails: false, nextSeasonTeaser: true },
          nextSeasonTeaser: {
            title: 'The answer beyond the relay',
            transcript: 'A second voice answers in her own voice.',
          },
        },
      }}
      episode={finale}
    />);

    expect(screen.getByRole('region', { name: 'Next-season teaser' })).toHaveTextContent(
      'A second voice answers in her own voice.',
    );
  });

  it('does not offer an unplayable empty episode', () => {
    const first = {
      id: 'ep-1', number: 1, startNodeId: 'end-1',
      nodes: [{ id: 'end-1', prose: 'Done.', isEnding: true, transitions: [] }],
    };
    const empty = { id: 'ep-2', number: 2, startNodeId: null, nodes: [] };

    render(<LoomPlayPanel loom={{ ...loom, episodes: [first, empty] }} episode={first} />);

    expect(screen.getByRole('button', { name: 'Play again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next: Episode 2' })).not.toBeInTheDocument();
  });

  it('rehearses entry clip, transitions to hold loop on ended, and displays live voice status', async () => {
    const user = userEvent.setup();
    const productionEpisode = {
      id: 'ep-prod', number: 1, title: 'Production Pilot', startNodeId: 'node-prod',
      nodes: [{
        id: 'node-prod',
        title: 'Courtyard',
        prose: 'You arrive at the courtyard.',
        playbackAssets: {
          entryVideoHistoryId: 'vid-entry-1',
          holdLoopVideoHistoryIds: ['vid-hold-1', 'vid-hold-2'],
          exitByTransition: { 'tr-gate': 'vid-exit-gate' },
          audioOccupancy: {
            'vid-hold-1': { durationMs: 6000, music: [{ startMs: 0, endMs: 6000 }] },
            'vid-hold-2': { durationMs: 6000, music: [{ startMs: 0, endMs: 6000 }] },
          },
        },
        interactionWindow: {
          enabled: true,
          protagonistCharacterId: 'char-maya',
          protagonistPresence: 'offscreen',
          ambientDuckDb: -10,
        },
        transitions: [{ id: 'tr-gate', targetNodeId: 'node-inside', intent: 'open the gate' }],
      }, {
        id: 'node-inside',
        title: 'Inside Sanctum',
        prose: 'Inside the quiet hall.',
        isEnding: true,
        transitions: [],
      }],
    };

    render(<LoomPlayPanel loom={{ ...loom, episodes: [productionEpisode] }} episode={productionEpisode} />);
    await user.selectOptions(screen.getByLabelText('Preview stage'), 'video');

    // Initially plays entry clip
    const video = screen.getByLabelText('Courtyard');
    expect(video.getAttribute('src')).toContain('vid-entry-1');

    // When entry video ends, advances to hold loop
    fireEvent.ended(video);

    // Now playing hold loop vid-hold-1 and live voice status is displayed
    await waitFor(() => {
      const updatedVideo = screen.getByLabelText('Courtyard');
      expect(updatedVideo.getAttribute('src')).toContain('vid-hold-1');
    });

    expect(screen.getByText('Off-screen voice window open')).toBeInTheDocument();
    expect(screen.getByText(/Ambience ducked -10 dB/)).toBeInTheDocument();

    // Loop ended again -> rotates to vid-hold-2
    fireEvent.ended(screen.getByLabelText('Courtyard'));
    await waitFor(() => {
      const rotatedVideo = screen.getByLabelText('Courtyard');
      expect(rotatedVideo.getAttribute('src')).toContain('vid-hold-2');
    });

    // Tap path 'open the gate' -> starts exit clip vid-exit-gate
    playLoomTurn.mockResolvedValue({
      action: 'move', narration: '', ended: true,
      node: { id: 'node-inside', title: 'Inside Sanctum', prose: 'Inside the quiet hall.', isEnding: true, choices: [] },
    });

    await user.click(screen.getByRole('button', { name: 'Take path: open the gate' }));

    // Rehearses exit clip before sending turn
    await waitFor(() => {
      const exitVideo = screen.getByLabelText('Courtyard');
      expect(exitVideo.getAttribute('src')).toContain('vid-exit-gate');
    });

    // Exit video ends -> finishes turn and enters next node
    fireEvent.ended(screen.getByLabelText('Courtyard'));

    await waitFor(() => expect(playLoomTurn).toHaveBeenCalledWith(
      'loom-1', 'ep-prod', expect.objectContaining({ transitionId: 'tr-gate' }), { silent: true },
    ));
    await waitFor(() => expect(screen.getAllByText('Ending')).not.toHaveLength(0));
  });

  it('shows rehearsal details with inspector drawer', async () => {
    const user = userEvent.setup();
    const episodeWithOccupancy = {
      id: 'ep-occ', number: 1, title: 'Occupancy', startNodeId: 'node-1',
      nodes: [{
        id: 'node-1',
        title: 'Hall',
        prose: 'A quiet hall.',
        playbackAssets: {
          entryVideoHistoryId: 'vid-entry-hall',
          audioOccupancy: {
            'vid-entry-hall': { durationMs: 4000, safeForLiveVoice: true },
          },
        },
        interactionWindow: { enabled: true, ambientDuckDb: -8 },
        transitions: [],
      }],
    };

    render(<LoomPlayPanel loom={{ ...loom, episodes: [episodeWithOccupancy] }} episode={episodeWithOccupancy} />);
    await user.click(screen.getByRole('button', { name: 'Rehearsal details' }));

    expect(screen.getByRole('region', { name: 'Playback rehearsal' })).toBeInTheDocument();
    expect(screen.getByText(/Duck level: -8 dB/)).toBeInTheDocument();
    expect(screen.getByText(/Asset: vid-entry-hall/)).toBeInTheDocument();
  });
});
