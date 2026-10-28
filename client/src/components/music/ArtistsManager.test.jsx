import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../hooks/useMediaJobProgress', () => ({ default: () => ({ status: 'idle' }) }));
const copyToClipboard = vi.fn(async () => true);
vi.mock('../../lib/clipboard', () => ({ copyToClipboard: (...a) => copyToClipboard(...a) }));

const listArtists = vi.fn();
const createArtist = vi.fn();
const updateArtist = vi.fn();
const getArtistSubmissionProfile = vi.fn();
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  listArtists: (...a) => listArtists(...a),
  createArtist: (...a) => createArtist(...a),
  updateArtist: (...a) => updateArtist(...a),
  getArtistSubmissionProfile: (...a) => getArtistSubmissionProfile(...a),
}));

import ArtistsManager from './ArtistsManager';

// A record saved before the press & submission profile existed: no profile keys.
const LEGACY = { id: 'artist-1', name: 'Nova Vale', genre: 'dream pop', bio: 'Long bio.' };

const renderAt = async (path) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/music/artists/:id" element={<ArtistsManager />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
  listArtists.mockResolvedValue([LEGACY]);
});
afterEach(cleanup);

describe('<ArtistsManager> press & submission profile', () => {
  it('edits a bio on an older artist, saves it with the record, then copies the saved profile', async () => {
    await renderAt('/music/artists/artist-1');
    expect(screen.getByText('Bios').closest('summary')).toHaveTextContent('1/3 filled');
    expect(screen.getByLabelText('Full bio')).toHaveValue('Long bio.');

    fireEvent.change(screen.getByLabelText('Short bio'), { target: { value: 'Writes folk songs.' } });
    expect(screen.getByText('3 words · 18/1500 characters')).toBeTruthy();
    const copy = screen.getByRole('button', { name: /Copy profile/ });
    expect(copy).toBeDisabled();

    updateArtist.mockImplementation(async (id, patch) => ({ ...LEGACY, ...patch, id }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(updateArtist).toHaveBeenCalledWith('artist-1', expect.objectContaining({ bioShort: 'Writes folk songs.', bio: 'Long bio.', creditName: '' }), { silent: true });
    expect(copy).not.toBeDisabled();

    getArtistSubmissionProfile.mockResolvedValue({ markdown: '# Nova Vale\n' });
    await act(async () => { fireEvent.click(copy); });
    expect(getArtistSubmissionProfile).toHaveBeenCalledWith('artist-1', { silent: true });
    expect(copyToClipboard).toHaveBeenCalledWith('# Nova Vale\n', 'Profile copied');
  });

  it('keeps copying disabled while a save is in flight even if the form matches the old record', async () => {
    await renderAt('/music/artists/artist-1');
    let finishSave;
    updateArtist.mockImplementation((id, patch) => new Promise((resolve) => {
      finishSave = () => resolve({ ...LEGACY, ...patch, id });
    }));

    const bio = screen.getByLabelText('Short bio');
    const copy = screen.getByRole('button', { name: /Copy profile/ });
    fireEvent.change(bio, { target: { value: 'New bio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(bio, { target: { value: '' } });
    expect(copy).toBeDisabled();

    await act(async () => { finishSave(); });
    expect(bio).toHaveValue(''); // An edit made during the save is preserved.
    expect(copy).toBeDisabled(); // The saved record now differs from the current form.
  });

  it('shows the normalized saved profile and enables copying after a save', async () => {
    await renderAt('/music/artists/artist-1');
    updateArtist.mockImplementation(async (id, patch) => ({ ...LEGACY, ...patch, id, bioShort: patch.bioShort.trim() }));

    const bio = screen.getByLabelText('Short bio');
    fireEvent.change(bio, { target: { value: '  Writes folk songs.  ' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });

    expect(bio).toHaveValue('Writes folk songs.');
    expect(screen.getByRole('button', { name: /Copy profile/ })).not.toBeDisabled();
  });

  it('keeps a different selected artist intact when an earlier save finishes', async () => {
    listArtists.mockResolvedValue([LEGACY, { ...LEGACY, id: 'artist-2', name: 'Second' }]);
    await renderAt('/music/artists/artist-1');
    let finishSave;
    updateArtist.mockImplementation((id, patch) => new Promise((resolve) => {
      finishSave = () => resolve({ ...LEGACY, ...patch, id, bioShort: patch.bioShort.trim() });
    }));

    fireEvent.change(screen.getByLabelText('Short bio'), { target: { value: '  Shared bio  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: /^Second/ }));
    const bio = screen.getByLabelText('Short bio');
    fireEvent.change(bio, { target: { value: '  Shared bio  ' } });
    await act(async () => { finishSave(); });

    expect(bio).toHaveValue('  Shared bio  ');
    expect(screen.getByLabelText('Name')).toHaveValue('Second');
  });

  it('preserves edits made while a new artist is being created', async () => {
    await renderAt('/music/artists/new');
    let finishCreate;
    createArtist.mockImplementation((patch) => new Promise((resolve) => {
      finishCreate = () => resolve({ ...patch, id: 'artist-new', bioShort: patch.bioShort.trim() });
    }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New artist' } });
    const bio = screen.getByLabelText('Short bio');
    fireEvent.change(bio, { target: { value: 'First version' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    fireEvent.change(bio, { target: { value: 'Edited during save' } });
    await act(async () => { finishCreate(); });

    expect(screen.getByLabelText('Short bio')).toHaveValue('Edited during save');
    expect(screen.getByRole('button', { name: /Copy profile/ })).toBeDisabled();
  });

  it('does not navigate away from another artist when creation finishes', async () => {
    await renderAt('/music/artists/new');
    let finishCreate;
    createArtist.mockImplementation((patch) => new Promise((resolve) => {
      finishCreate = () => resolve({ ...patch, id: 'artist-new' });
    }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New artist' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    fireEvent.click(screen.getByRole('button', { name: /^Nova Vale/ }));
    await act(async () => { finishCreate(); });

    expect(screen.getByLabelText('Name')).toHaveValue('Nova Vale');
    expect(screen.getByLabelText('Full bio')).toHaveValue('Long bio.');
  });

  it('keeps a new draft opened after leaving an in-flight creation', async () => {
    await renderAt('/music/artists/new');
    let finishCreate;
    createArtist.mockImplementation((patch) => new Promise((resolve) => {
      finishCreate = () => resolve({ ...patch, id: 'artist-new' });
    }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'First draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    fireEvent.click(screen.getByRole('button', { name: /^Nova Vale/ }));
    fireEvent.click(screen.getByRole('button', { name: 'New Artist' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Second draft' } });
    await act(async () => { finishCreate(); });

    expect(screen.getByLabelText('Name')).toHaveValue('Second draft');
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });
});
