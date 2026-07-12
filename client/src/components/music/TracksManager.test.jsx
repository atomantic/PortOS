import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the heavy children — this suite pins the MIDI read-through wiring
// (#2477 follow-up), not the editor/generation internals.
vi.mock('./ArtistPicker', () => ({ default: () => <div data-testid="artist-picker" /> }));
vi.mock('./MusicGenPanel', () => ({ default: () => <div data-testid="gen-panel" /> }));
vi.mock('./TrackRenderCard', () => ({ default: () => <div data-testid="render-card" /> }));
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
import { listTracks, listAlbums } from '../../services/api';
import { listMusicVideoProjects } from '../../services/apiMusicVideo.js';

const TRACK = { id: 'track-1', title: 'Example Song', audioFilename: 'example.mp3', renders: [] };

const renderAt = (id) => render(
  <MemoryRouter initialEntries={[`/music/tracks/${id}`]}>
    <Routes>
      <Route path="/music/tracks/:id" element={<TracksManager />} />
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
