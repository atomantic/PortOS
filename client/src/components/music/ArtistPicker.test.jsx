import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import ArtistPicker from './ArtistPicker';

const listArtists = vi.fn();
vi.mock('../../services/api', () => ({
  listArtists: (...args) => listArtists(...args),
}));

const renderPicker = (props) => render(
  <MemoryRouter>
    <ArtistPicker onChange={vi.fn()} {...props} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  listArtists.mockResolvedValue([
    { id: 'ar1', name: 'The Kestrels' },
    { id: 'ar2', name: 'Neon Static' },
  ]);
});

describe('ArtistPicker', () => {
  it('lists fetched artists and reports both the id and name on change', async () => {
    const onChange = vi.fn();
    renderPicker({ value: '', name: '', onChange });
    await screen.findByRole('option', { name: 'The Kestrels' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ar2' } });
    expect(onChange).toHaveBeenCalledWith('ar2', 'Neon Static');
  });

  it('keeps a linked artist the fetched list no longer has selectable, using the stored name', async () => {
    renderPicker({ value: 'deleted-artist', name: 'Deleted Artist' });
    await screen.findByRole('option', { name: 'The Kestrels' });
    const select = screen.getByRole('combobox');
    expect(select.value).toBe('deleted-artist');
    expect(screen.getByRole('option', { name: 'Deleted Artist' })).toBeTruthy();
  });

  it('falls back to a generic label for an unlisted artist with no stored name', async () => {
    renderPicker({ value: 'deleted-artist', name: '' });
    await screen.findByRole('option', { name: 'The Kestrels' });
    expect(screen.getByRole('option', { name: 'Linked artist (unavailable)' })).toBeTruthy();
  });

  it('does not add a synthetic option once the value is a real artist', async () => {
    renderPicker({ value: 'ar1', name: 'The Kestrels' });
    await screen.findByRole('option', { name: 'The Kestrels' });
    expect(screen.getAllByRole('option', { name: 'The Kestrels' })).toHaveLength(1);
  });

  it('shows a load error with Retry, not the empty-personas copy, when the read fails', async () => {
    listArtists.mockRejectedValueOnce(new Error('Artists unavailable'));
    renderPicker({ value: '', name: '' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load artist personas — Artists unavailable');
    expect(screen.queryByText(/No artist personas yet/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('option', { name: 'The Kestrels' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the empty-personas copy only once an empty list loaded', async () => {
    listArtists.mockResolvedValueOnce([]);
    renderPicker({ value: '', name: '' });
    expect(await screen.findByText(/No artist personas yet/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
