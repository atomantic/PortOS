import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { blenderFilmState } from '../../test/blenderFilmFixture.js';

vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
vi.mock('../../services/apiCodeAnimation', () => ({ getCodeAnimationProject: vi.fn() }));
vi.mock('../../services/apiCodeAnimationFilm.js', async load => {
  const actual = await load();
  return {
    ...actual,
    codeAnimationFilmApi: {
      ...actual.codeAnimationFilmApi,
      getMusicVideoBlender: vi.fn(),
      listMusicVideoBlenderModels: vi.fn(async () => ({ models: [] })),
      listMusicVideoBlenderFiles: vi.fn(),
      getMusicVideoBlenderFile: vi.fn(),
      assembleMusicVideoBlenderCut: vi.fn(),
    },
    patchFilm: vi.fn(),
    promoteFilm: vi.fn(),
  };
});
vi.mock('../../services/apiTracks.js', () => ({
  listTracks: vi.fn(),
}));
vi.mock('../../services/apiMedia.js', () => ({
  uploadFile: vi.fn(),
}));
vi.mock('../musicVideo/blender/BlenderReadiness.jsx', () => ({ default: () => <div>Blender setup</div> }));
import ProductionFilm from './ProductionFilm.jsx';
import { getCodeAnimationProject } from '../../services/apiCodeAnimation';
import * as filmApi from '../../services/apiCodeAnimationFilm.js';
import socket from '../../services/socket';
import { listTracks } from '../../services/apiTracks.js';

const id = '00000000-0000-4000-8000-000000000001';
const project = { id, kind: 'film', title: 'Silent example', film: {
  timeline: { durationSec: 12, fps: 24 }, settings: { fps: 24 }, audio: { filename: null },
} };
const Location = () => <output aria-label="Location">{useLocation().pathname}</output>;
beforeEach(() => {
  vi.clearAllMocks();
  getCodeAnimationProject.mockResolvedValue(project);
  filmApi.codeAnimationFilmApi.getMusicVideoBlender.mockResolvedValue(blenderFilmState({ timeline: project.film.timeline }));
  filmApi.codeAnimationFilmApi.listMusicVideoBlenderFiles.mockResolvedValue({ files: [{ path: 'film.py', text: true }] });
  filmApi.codeAnimationFilmApi.getMusicVideoBlenderFile.mockResolvedValue({ path: 'film.py', content: '# example' });
  filmApi.codeAnimationFilmApi.assembleMusicVideoBlenderCut.mockResolvedValue({ job: { id: 'cut', kind: 'cut', quality: 'final', status: 'queued' } });
});

afterEach(() => vi.restoreAllMocks());

it('opens the URL-selected film shot, uses standalone media/files/cut APIs and preserves tab navigation in the path', async () => {
  const { container } = render(<MemoryRouter initialEntries={[`/code-animation/production/films/${id}/shots/s020`]}>
    <Location /><Routes><Route path="/code-animation/production/films/:filmId/:tab?/:shotId?" element={<ProductionFilm />} /></Routes>
  </MemoryRouter>);
  expect(await screen.findByRole('heading', { name: 'Silent example' })).toBeTruthy();
  await screen.findByLabelText('Preview render of First verse');
  expect(filmApi.codeAnimationFilmApi.getMusicVideoBlender).toHaveBeenCalledWith(id, { silent: true });
  expect(socket.on).toHaveBeenCalledWith('code-animation:film', expect.any(Function));
  for (const media of container.querySelectorAll('video[src], img[src]')) expect(media.getAttribute('src')).toContain(`/api/code-animation/films/${id}/blender/media`);
  fireEvent.click(screen.getByRole('tab', { name: 'Files', exact: true }));
  await waitFor(() => expect(screen.getByLabelText('Location').textContent).toBe(`/code-animation/production/films/${id}/files/s020`));
  await waitFor(() => expect(filmApi.codeAnimationFilmApi.listMusicVideoBlenderFiles).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('tab', { name: 'Cut', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Assemble final cut' }));
  await waitFor(() => expect(filmApi.codeAnimationFilmApi.assembleMusicVideoBlenderCut).toHaveBeenCalledWith(id, { quality: 'final' }, { silent: true }));
  expect(screen.queryByText('Also publish as review draft')).toBeNull();
  expect(screen.queryByText('Open Film look')).toBeNull();
});

it('keeps film detail drafts after a rejected save', async () => {
  filmApi.patchFilm.mockRejectedValue(new Error('Save failed'));
  render(<MemoryRouter initialEntries={[`/code-animation/production/films/${id}/shots`]}><Routes>
    <Route path="/code-animation/production/films/:filmId/:tab?" element={<ProductionFilm />} />
  </Routes></MemoryRouter>);
  const title = await screen.findByLabelText('Title');
  fireEvent.change(title, { target: { value: 'Unsaved direction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save film details' }));
  await waitFor(() => expect(filmApi.patchFilm).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save film details' }).disabled).toBe(false));
  expect(title.value).toBe('Unsaved direction');
});

it('sends the selected track without analysis and links to the new Music Video with coverage guidance', async () => {
  const duplicateKeyWarnings = vi.spyOn(console, 'error');
  listTracks.mockResolvedValue([{ id: 'track', title: 'Example song', audioFilename: 'example.wav' }]);
  filmApi.promoteFilm.mockResolvedValue({ project: { id: 'mv-copy', name: 'Song version' }, coverageProblems: ['No shot covers the song after 12 s.'] });
  render(<MemoryRouter initialEntries={[`/code-animation/production/films/${id}/shots`]}><Routes>
    <Route path="/code-animation/production/films/:filmId/:tab?" element={<ProductionFilm />} />
  </Routes></MemoryRouter>);
  const send = await screen.findByRole('button', { name: 'Send to Music Video' });
  await act(async () => { fireEvent.click(send); });
  const picker = within(screen.getByRole('dialog', { name: 'Send to Music Video' }));
  const track = picker.getByRole('radio', { name: 'Select Example song' });
  fireEvent.click(track);
  expect(track.checked).toBe(true);
  const select = picker.getByRole('button', { name: 'Select track' });
  // Flush the mocked async promotion before querying the full film UI.
  await act(async () => { fireEvent.click(select); });
  expect(filmApi.promoteFilm).toHaveBeenCalledWith(id, { trackId: 'track' }, { silent: true });
  const link = screen.getByRole('link', { name: 'Open Song version in Music Video' });
  expect(link.getAttribute('href')).toBe('/music-video/mv-copy');
  expect(screen.getByText('No shot covers the song after 12 s.')).toBeTruthy();
  expect(screen.getByText('The copy needs song analysis and a shot sync. Sending starts no jobs.')).toBeTruthy();
  expect(screen.getAllByRole('heading', { name: 'Silent example' })).toHaveLength(1);
  expect(duplicateKeyWarnings.mock.calls.filter(([message]) => String(message).includes('same key'))).toHaveLength(0);
});
