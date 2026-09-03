import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const musicGenProps = vi.hoisted(() => ({ current: null }));
const chiptuneProps = vi.hoisted(() => ({ current: null }));

// Stub the heavy children — this suite pins the MIDI read-through wiring
// (#2477 follow-up), not the editor/generation internals.
vi.mock('./ArtistPicker', () => ({ default: () => <div data-testid="artist-picker" /> }));
vi.mock('./MusicGenPanel', () => ({ default: (props) => {
  musicGenProps.current = props;
  return <div data-testid="gen-panel" />;
} }));
vi.mock('./ChiptunePanel', () => ({ default: (props) => {
  chiptuneProps.current = props;
  return <div data-testid="chiptune-panel" />;
} }));
vi.mock('./TrackRenderCard', () => ({ default: ({ render: item, onRemix, onSendToVideo }) => (
  <>
    <button type="button" data-testid="render-card" onClick={() => onRemix(item)}>Remix {item.id}</button>
    <button type="button" data-testid="send-to-video" onClick={() => onSendToVideo(item)}>Audio → Video {item.id}</button>
  </>
) }));
vi.mock('./TrackRenderModal', () => ({ default: () => null }));
vi.mock('../songs/MidiVisualization.jsx', () => ({
  default: ({ url, model }) => <div data-testid="midi-viz" data-url={url} data-model={model} />,
}));

vi.mock('../../services/api', () => ({
  listTracks: vi.fn(),
  listAlbums: vi.fn(),
  createTrack: vi.fn(),
  updateTrack: vi.fn(),
  deleteTrack: vi.fn(),
  uploadTrackAudio: vi.fn(),
  attachTrackAudio: vi.fn(),
  listMusicLibrary: vi.fn(),
  selectTrackRender: vi.fn(),
  deleteTrackRender: vi.fn(),
  TRACK_TITLE_MAX: 200,
  TRACK_LYRICS_MAX: 10000,
  TRACK_PROMPT_MAX: 2000,
}));
vi.mock('../../services/apiMusicVideo.js', () => ({ listMusicVideoProjects: vi.fn() }));

import TracksManager from './TracksManager.jsx';
import { listTracks, listAlbums, createTrack, deleteTrack, updateTrack } from '../../services/api';
import { listMusicVideoProjects } from '../../services/apiMusicVideo.js';

const TRACK = { id: 'track-1', title: 'Example Song', audioFilename: 'example.mp3', renders: [] };

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

const renderAt = (id) => render(
  <MemoryRouter initialEntries={[`/music/tracks/${id}`]}>
    <Routes>
      <Route path="/music/tracks/:id" element={<TracksManager />} />
      <Route path="/music/generate/:step" element={<LocationDisplay />} />
      <Route path="/media/video" element={<LocationDisplay />} />
    </Routes>
  </MemoryRouter>,
);

describe('<TracksManager> MIDI transcription read-through', () => {
  beforeEach(() => {
    listTracks.mockResolvedValue([TRACK]);
    listAlbums.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the newest linked Music Video transcription with a source link', async () => {
    listMusicVideoProjects.mockResolvedValue([
      { id: 'mv-old', name: 'Old Cut', trackId: 'track-1', midiTranscription: { filename: 'old.mid', model: 'small', createdAt: '2026-01-01T00:00:00Z' } },
      { id: 'mv-new', name: 'New Cut', trackId: 'track-1', midiTranscription: { filename: 'new.mid', model: 'medium', createdAt: '2026-06-01T00:00:00Z' } },
      { id: 'mv-other', name: 'Other', trackId: 'track-2', midiTranscription: { filename: 'other.mid', createdAt: '2026-07-01T00:00:00Z' } },
    ]);
    renderAt('track-1');
    const viz = await screen.findByTestId('midi-viz');
    // Newest transcription wins; other tracks' projects are ignored.
    expect(viz.getAttribute('data-url')).toBe('/data/music/new.mid');
    expect(viz.getAttribute('data-model')).toBe('medium');
    const link = screen.getByRole('link', { name: /from Music Video/ });
    expect(link.getAttribute('href')).toBe('/music-video/mv-new');
  });

  it('renders no MIDI section when no linked project has a transcription', async () => {
    listMusicVideoProjects.mockResolvedValue([
      { id: 'mv-1', name: 'No MIDI', trackId: 'track-1' },
    ]);
    renderAt('track-1');
    await screen.findByDisplayValue('Example Song');
    expect(screen.queryByTestId('midi-viz')).toBeNull();
    expect(screen.queryByText('MIDI transcription')).toBeNull();
  });
});

// #3264: the generator toggle used to live INSIDE the `persisted ?` gate, so a
// brand-new track rendered nothing at all where the generators belong and there
// was no way to learn the two modes existed until after the first save.
describe('<TracksManager> generator mode toggle', () => {
  beforeEach(() => {
    listTracks.mockResolvedValue([TRACK]);
    listAlbums.mockResolvedValue([]);
    listMusicVideoProjects.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const modeButton = (name) => screen.getByRole('button', { name });

  it('shows audio generation on an unsaved track while keeping chiptune gated', async () => {
    renderAt('new');
    await screen.findByRole('group', { name: /generation mode/i });

    expect(modeButton('Audio model')).toBeInTheDocument();
    expect(modeButton('Chiptune score')).toBeInTheDocument();
    expect(screen.getByTestId('gen-panel')).toBeInTheDocument();
    expect(screen.queryByText(/Save the track first, then generate with an audio model/i)).toBeNull();
    expect(screen.queryByTestId('chiptune-panel')).toBeNull();
    // The renders block's own hint no longer claims to cover generation, so an
    // unsaved track doesn't show two near-identical "save first" sentences.
    expect(screen.getByText(/Save the track first to upload or attach audio/i)).toBeInTheDocument();
    expect(screen.queryByText(/Save the track first to generate, upload/i)).toBeNull();
  });

  it('switches mode before save and names the selected mode in the hint', async () => {
    renderAt('new');
    await screen.findByRole('group', { name: /generation mode/i });

    fireEvent.click(modeButton('Chiptune score'));

    expect(modeButton('Chiptune score')).toHaveAttribute('aria-pressed', 'true');
    expect(modeButton('Audio model')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/Save the track first, then generate a chiptune score/i)).toBeInTheDocument();
    expect(screen.queryByTestId('chiptune-panel')).toBeNull();
  });

  it('keeps a pre-save chiptune choice after Create navigates to the new track', async () => {
    const created = { id: 'track-new', title: 'Fresh Cut', renders: [] };
    createTrack.mockResolvedValue(created);

    renderAt('new');
    await screen.findByRole('group', { name: /generation mode/i });

    fireEvent.click(modeButton('Chiptune score'));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fresh Cut' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The hydration effect re-runs on the create → navigate transition; the
    // created track carries no `chiptuneScore`, so a naive re-derivation would
    // snap the editor back to "Audio model" the instant the track existed.
    expect(await screen.findByTestId('chiptune-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('gen-panel')).toBeNull();
    expect(modeButton('Chiptune score')).toHaveAttribute('aria-pressed', 'true');
  });

  it('still opens an existing scored track on the chiptune panel', async () => {
    listTracks.mockResolvedValue([{ ...TRACK, chiptuneScore: { tempo: 120 } }]);
    renderAt('track-1');

    expect(await screen.findByTestId('chiptune-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('gen-panel')).toBeNull();
  });

  it('opens an existing unscored track on the audio panel', async () => {
    renderAt('track-1');

    expect(await screen.findByTestId('gen-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('chiptune-panel')).toBeNull();
  });

  it('passes the current track brief into chiptune mode', async () => {
    listTracks.mockResolvedValue([{ ...TRACK, prompt: 'Rainy arcade chase', lyrics: '[verse]\nRun!' }]);
    renderAt('track-1');
    await screen.findByTestId('gen-panel');
    await screen.findByDisplayValue('Rainy arcade chase');
    fireEvent.click(modeButton('Chiptune score'));

    expect(chiptuneProps.current).toMatchObject({
      sourcePrompt: 'Rainy arcade chase',
      sourceLyrics: '[verse]\nRun!',
    });
  });
});

describe('<TracksManager> generative workflow hand-off', () => {
  beforeEach(() => {
    listTracks.mockResolvedValue([TRACK]);
    listAlbums.mockResolvedValue([]);
    listMusicVideoProjects.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('saves open edits before loading the same track in the stepped designer', async () => {
    updateTrack.mockResolvedValue({ ...TRACK, prompt: 'A patient analog pulse.' });
    renderAt('track-1');

    const prompt = await screen.findByLabelText(/^Prompt/);
    // The form hydrates from the loaded track in an effect that can commit after
    // the fields mount — `findByLabelText` resolves on the DOM node appearing,
    // not on hydration landing. Type only once it has, or hydration overwrites
    // the typed prompt and the save sends the original.
    await waitFor(() => expect(screen.getByLabelText('Title').value).toBe('Example Song'));
    fireEvent.change(prompt, { target: { value: 'A patient analog pulse.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Design with AI' }));

    await waitFor(() => expect(updateTrack).toHaveBeenCalledWith(
      'track-1',
      {
        title: 'Example Song',
        artistId: '',
        artist: '',
        lyrics: '',
        prompt: 'A patient analog pulse.',
        audioFilename: 'example.mp3',
      },
      { silent: true },
    ));
    expect(await screen.findByTestId('location')).toHaveTextContent('/music/generate/concept?trackId=track-1');
  });

  it('remixes only explicit instrumental modes and restores the authored prompt', async () => {
    listTracks.mockResolvedValue([{
      ...TRACK,
      prompt: 'Current source',
      lyrics: 'Current lyrics',
      renders: [
        {
          id: 'render-explicit', audioFilename: 'explicit.wav', engine: 'acestep', prompt: 'Conditioned prompt',
          authoredPrompt: 'Authored prompt', lyrics: '', instrumentalOnly: true, createdAt: '2026-01-02T00:00:00Z',
        },
        {
          id: 'render-legacy', audioFilename: 'legacy.wav', engine: 'acestep', prompt: 'Legacy vocal texture',
          lyrics: '', createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    }]);
    musicGenProps.current = null;
    renderAt('track-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Remix render-explicit' }));
    await waitFor(() => expect(musicGenProps.current?.remix).toEqual(expect.objectContaining({ instrumentalOnly: true })));
    expect(musicGenProps.current.prompt).toBe('Authored prompt');

    fireEvent.click(screen.getByRole('button', { name: 'Remix render-legacy' }));
    await waitFor(() => expect(musicGenProps.current?.remix?.nonce).toBe(2));
    expect(musicGenProps.current.remix).not.toHaveProperty('instrumentalOnly');
  });
});

describe('<TracksManager> Audio-to-Video hand-off', () => {
  beforeEach(() => {
    listTracks.mockResolvedValue([{ ...TRACK, renders: [{ id: 'render-1', audioFilename: 'example take.mp3' }] }]);
    listAlbums.mockResolvedValue([]);
    listMusicVideoProjects.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('deep-links the selected render into the Media Gen Audio-to-Video form', async () => {
    renderAt('track-1');
    fireEvent.click(await screen.findByTestId('send-to-video'));
    expect(screen.getByTestId('location')).toHaveTextContent('/media/video?mode=a2v&audioFilename=example%20take.mp3');
  });
});

// ConfirmButtonPair delete wiring (via useConfirmDelete) and the field-edit
// save path. The hook's own arm/disarm mechanics are unit-tested in
// useConfirmDelete.test.jsx; this covers TracksManager's INTEGRATION of it —
// that the trash button arms without calling the API, that the confirm/cancel
// buttons it renders drive deleteTrack with the exact track id (or not at
// all), and that a field edit reaches updateTrack with the exact payload.
describe('<TracksManager> delete confirm + save wiring', () => {
  beforeEach(() => {
    listTracks.mockResolvedValue([TRACK]);
    listAlbums.mockResolvedValue([]);
    listMusicVideoProjects.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('arms on the first click with no API call, then confirms with the exact track id', async () => {
    deleteTrack.mockResolvedValue({});
    renderAt('track-1');
    await screen.findByDisplayValue('Example Song');

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    // Armed: the confirm pair replaces the trash button; no delete fired yet.
    const confirmGroup = await screen.findByRole('group', { name: 'Confirm delete track' });
    expect(within(confirmGroup).getByText('Delete this track?')).toBeInTheDocument();
    expect(deleteTrack).not.toHaveBeenCalled();

    fireEvent.click(within(confirmGroup).getByRole('button', { name: 'Yes, delete' }));

    expect(deleteTrack).toHaveBeenCalledTimes(1);
    expect(deleteTrack).toHaveBeenCalledWith('track-1', { silent: true });
  });

  it('disarms on Cancel without ever calling deleteTrack', async () => {
    renderAt('track-1');
    await screen.findByDisplayValue('Example Song');

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    const confirmGroup = await screen.findByRole('group', { name: 'Confirm delete track' });

    fireEvent.click(within(confirmGroup).getByRole('button', { name: 'Cancel' }));

    // Disarmed: back to the plain trash button, confirm pair gone.
    expect(screen.queryByRole('group', { name: 'Confirm delete track' })).toBeNull();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    expect(deleteTrack).not.toHaveBeenCalled();
  });

  it('saves an edited title with the exact update payload', async () => {
    updateTrack.mockResolvedValue({ ...TRACK, title: 'Example Song Updated' });
    renderAt('track-1');
    const titleInput = await screen.findByDisplayValue('Example Song');

    fireEvent.change(titleInput, { target: { value: 'Example Song Updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateTrack).toHaveBeenCalledTimes(1));
    // `albumId` is dropped when unchanged from the loaded track (see
    // TracksManager's handleSave) — the exact-shape assertion pins that too.
    expect(updateTrack).toHaveBeenCalledWith(
      'track-1',
      {
        title: 'Example Song Updated',
        artistId: '',
        artist: '',
        lyrics: '',
        prompt: '',
        audioFilename: 'example.mp3',
      },
      { silent: true },
    );
  });
});
