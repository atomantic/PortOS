import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import AuthorPicker from './AuthorPicker';

const listAuthors = vi.fn();
vi.mock('../../services/api', () => ({
  listAuthors: (...args) => listAuthors(...args),
}));

const renderPicker = (props) => render(
  <MemoryRouter>
    <AuthorPicker onChange={vi.fn()} {...props} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  listAuthors.mockResolvedValue([
    { id: 'a1', name: 'Alice' },
    { id: 'a2', name: 'Bob' },
  ]);
});

describe('AuthorPicker', () => {
  it('lists fetched authors and reports both the id and name on change', async () => {
    const onChange = vi.fn();
    renderPicker({ value: '', byline: '', onChange });
    await screen.findByRole('option', { name: 'Alice' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a2' } });
    expect(onChange).toHaveBeenCalledWith('a2', 'Bob');
  });

  it('keeps a linked author the fetched list no longer has selectable, using the stored byline', async () => {
    renderPicker({ value: 'deleted-author', byline: 'Deleted Persona' });
    await screen.findByRole('option', { name: 'Alice' });
    const select = screen.getByRole('combobox');
    expect(select.value).toBe('deleted-author');
    expect(screen.getByRole('option', { name: 'Deleted Persona' })).toBeTruthy();
  });

  it('falls back to a generic label for an unlisted author with no stored byline', async () => {
    renderPicker({ value: 'deleted-author', byline: '' });
    await screen.findByRole('option', { name: 'Alice' });
    expect(screen.getByRole('option', { name: 'Linked author (unavailable)' })).toBeTruthy();
  });

  it('does not add a synthetic option once the value is a real author', async () => {
    renderPicker({ value: 'a1', byline: 'Alice' });
    await screen.findByRole('option', { name: 'Alice' });
    expect(screen.getAllByRole('option', { name: 'Alice' })).toHaveLength(1);
  });

  it('shows a load error with Retry, not the empty-personas copy, when the read fails', async () => {
    listAuthors.mockRejectedValueOnce(new Error('Authors unavailable'));
    renderPicker({ value: '', byline: '' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load author personas — Authors unavailable');
    expect(screen.queryByText(/No author personas yet/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('option', { name: 'Alice' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the empty-personas copy only once an empty list loaded', async () => {
    listAuthors.mockResolvedValueOnce([]);
    renderPicker({ value: '', byline: '' });
    expect(await screen.findByText(/No author personas yet/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
