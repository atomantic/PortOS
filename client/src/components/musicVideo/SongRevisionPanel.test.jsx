import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import SongRevisionPanel from './SongRevisionPanel.jsx';
const api = vi.hoisted(() => ({ save: vi.fn(), act: vi.fn(), get: vi.fn() }));
vi.mock('../../services/apiMusicVideo.js', () => ({ saveMusicVideoSongRevision: api.save, actOnMusicVideoSongRevision: api.act, getMusicVideoProject: api.get }));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
const fields = { title: 'Example song', style: 'Pop', lyrics: 'New morning', instrumental: false };
const base = { id: 'fork', parentProjectId: 'original', version: 2, songRevision: { id: 'rev', fields, status: 'draft', candidates: [] } };
function Harness() {
  const [project, setProject] = useState(base);
  return <MemoryRouter><SongRevisionPanel project={project} onUpdated={setProject} onFork={() => {}} /></MemoryRouter>;
}
beforeEach(() => vi.clearAllMocks());
describe('song revision UI', () => {
  it('gates generation on saving and selection on listening, then exposes the rebuild path', async () => {
    api.save.mockImplementation(async (_id, next) => ({ project: { ...base, songRevision: { ...base.songRevision, fields: next } } }));
    api.act.mockImplementation(async (_id, action) => ({ project: { ...base, songRevision: {
      ...base.songRevision, fields: { ...fields, lyrics: 'Edited morning' }, status: action === 'select' ? 'selected' : 'review',
      candidates: [{ songId: 'song-a', filename: 'example.m4a' }],
    } } }));
    render(<Harness />);
    expect(api.act).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Revision lyrics'), { target: { value: 'Edited morning' } });
    expect(screen.getByRole('button', { name: /Generate with Suno/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save song draft' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate with Suno/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate with Suno/ }));
    const select = await screen.findByRole('button', { name: 'Use candidate 1' });
    expect(select).toBeDisabled(); fireEvent.play(screen.getByLabelText('Listen to candidate 1')); fireEvent.click(select);
    expect(await screen.findByText(/New master selected/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Regenerate or reimport/ })).toHaveAttribute('href', '/music-video/fork/compose');
    expect(api.act.mock.calls.map((call) => call[1])).toEqual(['generate', 'select']);
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
});
