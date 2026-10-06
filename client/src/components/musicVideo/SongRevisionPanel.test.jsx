import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import SongRevisionPanel from './SongRevisionPanel.jsx';
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
const api = vi.hoisted(() => ({ save: vi.fn(), act: vi.fn(), get: vi.fn() }));
vi.mock('../../services/apiMusicVideo.js', () => ({ saveMusicVideoSongRevision: api.save, actOnMusicVideoSongRevision: api.act, getMusicVideoProject: api.get }));
vi.mock('../../services/socket', () => ({ default: socket }));
const fields = { title: 'Example song', style: 'Pop', lyrics: 'New morning', instrumental: false };
const base = { id: 'fork', parentProjectId: 'original', version: 2, songRevision: { id: 'rev', fields, status: 'draft', candidates: [] } };
function Harness({ initial = base }) {
  const [project, setProject] = useState(initial);
  return <MemoryRouter><SongRevisionPanel project={project} onUpdated={setProject} onFork={() => {}} /></MemoryRouter>;
}
beforeEach(() => { vi.clearAllMocks(); api.get.mockResolvedValue(base); });
describe('song revision UI', () => {
  it('gates generation on saving and selection on listening, then exposes the rebuild path', async () => {
    api.save.mockImplementation(async (_id, next) => ({ project: { ...base, songRevision: { ...base.songRevision, fields: { ...next, style: next.style.trim() } } } }));
    api.act.mockImplementation(async (_id, action) => ({ project: { ...base, songRevision: {
      ...base.songRevision, fields: { ...fields, lyrics: 'Edited morning' }, status: action === 'select' ? 'selected' : 'review',
      candidates: [{ songId: 'song-a', filename: 'example.m4a' }],
    } } }));
    render(<Harness />);
    expect(api.act).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Revision lyrics'), { target: { value: 'Edited morning' } });
    fireEvent.change(screen.getByLabelText('Suno musical style'), { target: { value: ' Pop ' } });
    expect(screen.getByRole('button', { name: /Generate with Suno/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save song draft' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate with Suno/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate with Suno/ }));
    const select = await screen.findByRole('button', { name: 'Use candidate 1' });
    expect(select).toBeDisabled(); fireEvent.play(screen.getByLabelText('Listen to candidate 1')); fireEvent.click(select);
    expect(await screen.findByText(/New master selected/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Regenerate or reimport/ })).toHaveAttribute('href', '/music-video/fork/produce#mv-composition');
    expect(screen.getByRole('link', { name: /align its lyrics on the Song step/ })).toHaveAttribute('href', '/music-video/fork/setup#mv-lyric-timing');
    expect(screen.getByRole('link', { name: /Rebuild and review proofs/ })).toHaveAttribute('href', '/music-video/fork/produce#mv-review-proof');
    expect(api.act.mock.calls.map((call) => call[1])).toEqual(['generate', 'select']);
  });
  it('recovers a revision completed while Setup was closed and adopts its saved fields', async () => {
    api.get.mockResolvedValue({ ...base, songRevision: { ...base.songRevision, id: 'recovered', sequence: 5,
      fields: { ...fields, lyrics: 'Recovered lyrics' }, status: 'failed', submitted: true, songIds: ['take-a'] } });
    render(<Harness initial={{ ...base, songRevision: null }} />);
    await waitFor(() => expect(screen.getByLabelText('Revision lyrics')).toHaveValue('Recovered lyrics'));
    expect(screen.getByRole('button', { name: 'Resume candidate downloads' })).toBeEnabled();
    expect(api.act).not.toHaveBeenCalled();
  });
  it('does not adopt stale save fields after a newer revision arrives', async () => {
    const pending = Promise.withResolvers();
    api.save.mockReturnValue(pending.promise);
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Suno musical style'), { target: { value: ' Pop edited ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save song draft' }));
    const receive = socket.on.mock.calls.find(([event]) => event === 'music-video:song-revision')[1];
    act(() => receive({ projectId: base.id, project: { ...base, songRevision: { ...base.songRevision, sequence: 3, status: 'canceled' } } }));
    await act(async () => pending.resolve({ project: { ...base, songRevision: { ...base.songRevision, sequence: 2, fields: { ...fields, style: 'Pop edited' } } } }));
    expect(screen.getByLabelText('Suno musical style')).toHaveValue(' Pop edited ');
    expect(screen.getByText('Song revision: canceled')).toBeInTheDocument();
  });
  it('keeps a failed save dirty and cancels without selecting audio', async () => {
    api.save.mockRejectedValue(new Error('Save unavailable'));
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Suno musical style'), { target: { value: 'New style' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save song draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save unavailable');
    expect(screen.getByRole('button', { name: /Generate with Suno/ })).toBeDisabled();
    api.act.mockResolvedValue({ project: { ...base, songRevision: { ...base.songRevision, status: 'canceled' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel song revision' }));
    await screen.findByText('Song revision: canceled');
    expect(api.act).toHaveBeenCalledWith('fork', 'cancel', { revisionId: 'rev' }, { silent: true });
  });
  it('hides the panel when there are no lyrics or song to revise on a non-fork project', () => {
    const { container } = render(
      <MemoryRouter>
        <SongRevisionPanel project={{ id: 'p1', version: 1 }} tracks={[]} onUpdated={() => {}} onFork={() => {}} />
      </MemoryRouter>,
    );
    expect(container.firstChild).toBeNull();
  });
  it('shows the fork callout when the project has audio or lyrics attached', () => {
    render(
      <MemoryRouter>
        <SongRevisionPanel project={{ id: 'p1', trackId: 't1', version: 1 }} tracks={[{ id: 't1', title: 'Song', audioFilename: 's.mp3' }]} onUpdated={() => {}} onFork={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Revise lyrics & song' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fork & revise song' })).toBeInTheDocument();
  });
});

