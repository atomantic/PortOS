import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ReviseSongCard from './ReviseSongCard.jsx';

const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
const api = vi.hoisted(() => ({ revise: vi.fn(), act: vi.fn() }));
vi.mock('../../services/apiMusicVideo.js', () => ({ reviseMusicVideoSongFromTrack: api.revise, actOnMusicVideoSongRevisionScenes: api.act }));
vi.mock('../../services/socket', () => ({ default: socket }));
vi.mock('../../hooks/useYoutubeTrackImport.js', () => ({ default: () => ({ active: false, percent: 0, start: vi.fn(), cancel: vi.fn() }) }));

const tracks = [{ id: 'track-old', title: 'Old take' }, { id: 'track-new', title: 'New take' }];
const revised = {
  id: 'fork', parentProjectId: 'original', trackId: 'track-new',
  lyricCues: [{ id: 'a', text: 'Line a' }, { id: 'b', text: 'Line b again' }, { id: 'n', text: 'Brand new' }],
  songRevision: { id: 'rev', status: 'selected', sequence: 2, baseline: { cues: [], scenes: [] }, fields: { title: 'New take' },
    cueStatus: { a: 'kept', b: 'changed', n: 'added' }, changedFrom: { b: 'Line b' }, removedLines: [{ id: 'x', text: 'Cut line' }],
    lyricDiff: { kept: 1, changed: 1, added: 1, removed: 1 }, retime: { status: 'done' },
    sceneCounts: { kept: 2, changed: 1, new: 1, removed: 1 },
    sceneReview: { s1: { status: 'kept' }, s2: { status: 'changed' }, s3: { status: 'new' }, s4: { status: 'removed' } } },
};
const renderCard = (props) => render(<MemoryRouter><ReviseSongCard tracks={tracks} {...props} /></MemoryRouter>);
beforeEach(() => vi.clearAllMocks());

describe('Revise song', () => {
  it('forks a new version from a library track', async () => {
    const result = { project: { ...revised }, retimeJobId: 'job' };
    api.revise.mockResolvedValue(result);
    const onRevised = vi.fn();
    renderCard({ project: { id: 'original', trackId: 'track-old' }, onRevised });
    fireEvent.click(screen.getByRole('button', { name: 'Revise song' }));
    const picker = screen.getByLabelText('Or a song already in the library');
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'track-new']);
    fireEvent.change(picker, { target: { value: 'track-new' } });
    await waitFor(() => expect(onRevised).toHaveBeenCalledWith(result));
    expect(api.revise).toHaveBeenCalledWith('original', 'track-new', { silent: true });
  });

  it('shows what the new lyrics changed and acts on the flagged shots', async () => {
    const onUpdated = vi.fn();
    api.act.mockResolvedValue({ project: { ...revised, songRevision: { ...revised.songRevision, sequence: 3 } } });
    renderCard({ project: revised, onUpdated });
    expect(screen.getByText('Lyrics: 1 kept · 1 reworded · 1 new · 1 cut')).toBeInTheDocument();
    expect(screen.getByText('Cut line', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review on Storyboard' })).toHaveAttribute('href', '/music-video/fork/board?scenes=attention');
    fireEvent.click(screen.getByRole('button', { name: 'Replan 2 shots' }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(api.act).toHaveBeenCalledWith('fork', { revisionId: 'rev', action: 'replan' }, { silent: true });
    expect(screen.getByRole('button', { name: 'Remove 1 cut shot' })).toBeInTheDocument();
  });

  it('offers the re-time again after a failure and applies newer re-time results from the server', () => {
    const onRetime = vi.fn();
    const onUpdated = vi.fn();
    const failed = { ...revised, songRevision: { ...revised.songRevision, retime: { status: 'failed', error: 'Some lyric words aligned to silence.' }, sceneReview: null, sceneCounts: null } };
    renderCard({ project: failed, onRetime, onUpdated });
    expect(screen.getByRole('alert')).toHaveTextContent('aligned to silence');
    fireEvent.click(screen.getByRole('button', { name: 'Try re-timing again' }));
    expect(onRetime).toHaveBeenCalled();
    const receive = socket.on.mock.calls.find(([event]) => event === 'music-video:song-revision')[1];
    act(() => receive({ projectId: 'fork', project: { ...revised, songRevision: { ...revised.songRevision, sequence: 1 } } }));
    expect(onUpdated).not.toHaveBeenCalled();
    act(() => receive({ projectId: 'fork', project: { ...revised, songRevision: { ...revised.songRevision, sequence: 9 } } }));
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });
});
