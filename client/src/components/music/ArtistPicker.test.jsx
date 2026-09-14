import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
