import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const handlers = vi.hoisted(() => new Map());
vi.mock('../../services/socket', () => ({
  default: {
    on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
    off: (event, fn) => { handlers.get(event)?.delete(fn); },
  },
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../services/apiMusicVideo.js', async (importOriginal) => ({
  ...await importOriginal(),
  getMusicVideoBlender: vi.fn(),
  getMusicVideoLyricOverlayPreview: vi.fn(() => new Promise(() => {})),
}));
vi.mock('../../services/apiImageVideo.js', () => ({ getVideoHistoryItem: vi.fn(async (id) => ({ id, filename: `${id}.mov` })) }));

import PreviewDock from './PreviewDock.jsx';
import useMusicVideoBlender from '../../hooks/useMusicVideoBlender.js';
import { getMusicVideoBlender } from '../../services/apiMusicVideo.js';
import { listPreviewSources } from '../../lib/musicVideoStages.js';
import { summarizeBlenderShots } from '../../lib/musicVideoBlender.js';
import { blenderFilmProject, blenderFilmState } from '../../test/blenderFilmFixture.js';

const mediaUrl = (file) => `/api/music-video/mv-test/blender/media?path=${encodeURIComponent(file)}`;
const scenes = [
  { sceneId: 'scene-s010', order: 0, label: 'Cold open', startSec: 0, endSec: 4.5, visualLayer: 'code' },
  { sceneId: 'scene-s020', order: 1, label: 'First verse', startSec: 4.5, endSec: 9, visualLayer: 'code' },
  { sceneId: 'scene-s030', order: 2, label: 'Chorus', startSec: 9, endSec: 12, visualLayer: 'code' },
];
// What the server puts on every read of a Blender project: how many shots the synced film has.
const film = blenderFilmProject({ scenes, blenderShots: { total: 3, finalReady: 1, ready: false } });

// The page's wiring: one film reading, pushed over the socket, feeding the stage project and the dock.
function Dock({ project = film }) {
  const blender = useMusicVideoBlender(project.id);
  const staged = blender.state ? { ...project, blenderShots: summarizeBlenderShots(blender.state.manifest?.shots, blender.state.renders) } : project;
  return <PreviewDock project={project} sources={listPreviewSources(staged, { leadWith: 'storyboard' })} audioUrl="/song.mp3" blender={blender} />;
}
const renderDock = (props) => render(<MemoryRouter><Dock {...props} /></MemoryRouter>);
const push = (event, payload) => act(async () => { for (const fn of handlers.get(event) || []) fn(payload); });

beforeEach(() => {
  handlers.clear();
  getMusicVideoBlender.mockReset();
});

describe('PreviewDock Blender film', () => {
  // Uniquely catches the live source staying disabled for a film with synced shots, or the player
  // calling every shot unrendered while the film's renders are still being read.
  it('offers Film (live) for a film with synced shots and plays its shot renders once the film is read', async () => {
    let answer;
    getMusicVideoBlender.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    renderDock();
    const picker = screen.getByLabelText('Preview source');
    expect(picker).toHaveValue('composite');
    expect(screen.getByRole('option', { name: 'Film (live)' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the Blender film…');
    expect(screen.queryByTestId('film-not-rendered')).toBeNull();
    await act(async () => answer(blenderFilmState()));
    expect(screen.getByLabelText('Film preview')).toBeTruthy();
    expect(screen.getByLabelText('Clip for Cold open').getAttribute('src')).toBe(mediaUrl('s010/final/shot.mp4'));
    expect(screen.getByText(/No cut is assembled/)).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Storyboard animatic' })).toBeEnabled();
  });

  // Uniquely catches a film that has not been synced offering a player with nothing to play.
  it('keeps the live source disabled, saying what it waits for, until the film has synced shots', async () => {
    getMusicVideoBlender.mockResolvedValueOnce(blenderFilmState({ manifest: null, renders: {} }));
    renderDock({ project: { ...film, blenderShots: { total: 0, finalReady: 0, ready: false } } });
    await act(async () => {});
    const unavailable = screen.getByRole('option', { name: /Film \(live\)/ });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveTextContent('Sync shots from scripts in Blender film on Shots to watch the film live.');
    expect(screen.getByLabelText('Preview source')).toHaveValue('animatic');
    expect(screen.queryByLabelText('Film preview')).toBeNull();
  });

  // Uniquely catches a render that lands while the page is open needing a reload (or a poll) to
  // show, or the pushed state remounting the player and losing the song's place.
  it('picks up a render pushed over the socket without remounting the player', async () => {
    const before = blenderFilmState();
    getMusicVideoBlender.mockResolvedValueOnce(before);
    renderDock();
    await act(async () => {});
    const audio = screen.getByLabelText('Song for the film preview');
    Object.defineProperty(audio, 'currentTime', { value: 9.5, configurable: true, writable: true });
    fireEvent.timeUpdate(audio);
    expect(screen.getByTestId('film-not-rendered')).toHaveTextContent('Not rendered yet');
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(1);

    // The shot's preview finishes: the server announces the new state and the hook reads it once.
    getMusicVideoBlender.mockResolvedValueOnce({
      ...before,
      renders: { ...before.renders, s030: { preview: { ...before.renders.s010.preview, file: 's030/preview/shot.mp4' }, stills: [] } },
    });
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    await waitFor(() => expect(screen.queryByTestId('film-not-rendered')).toBeNull());
    expect(screen.getByLabelText('Clip for Chorus').getAttribute('src')).toBe(mediaUrl('s030/preview/shot.mp4'));
    expect(screen.getByLabelText('Song for the film preview')).toBe(audio);
    expect(audio.currentTime).toBe(9.5);
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(2);
  });

  // Uniquely catches a film whose state cannot be read showing a player of empty shots, with nowhere to retry.
  it('says the film could not be loaded instead of playing empty shots', async () => {
    getMusicVideoBlender.mockRejectedValueOnce(new Error('offline'));
    renderDock();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('The Blender film could not be loaded. Retry it in Blender film on Shots.'));
    expect(screen.queryByLabelText('Film preview')).toBeNull();
  });
});
