import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import SearchTab from './SearchTab';
import { searchNotes } from '../../../services/apiNotes.js';

vi.mock('../../../services/apiNotes.js');

const renderTab = (vaultId) => (
  <MemoryRouter><SearchTab vaultId={vaultId} /></MemoryRouter>
);

describe('SearchTab superseded searches (#12951)', () => {
  it('drops a slower earlier-vault response that resolves after the current search', async () => {
    let resolveOld;
    searchNotes.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    searchNotes.mockResolvedValueOnce({ results: [], total: 0 });
    const { rerender } = render(renderTab('v1'));
    const box = screen.getByLabelText('Search wiki pages and raw sources');
    fireEvent.change(box, { target: { value: 'alpha' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    rerender(renderTab('v2'));
    fireEvent.keyDown(box, { key: 'Enter' });
    await act(async () => {});

    await act(async () => { resolveOld({ results: [{ path: 'old/stale.md', name: 'Stale Result', snippet: 'x' }], total: 1 }); });
    expect(screen.queryByText('Stale Result')).not.toBeInTheDocument();
  });

  it('lays out search input, clear button, and submit button in flow without overlapping', () => {
    render(renderTab('v1'));
    const box = screen.getByLabelText('Search wiki pages and raw sources');
    expect(box.className).toContain('min-w-0');
    expect(box.parentElement.className).toContain('flex');

    fireEvent.change(box, { target: { value: 'query' } });
    const clear = screen.getByRole('button', { name: 'Clear search' });
    expect(clear.className).toContain('min-h-[44px]');
    expect(clear.className).toContain('min-w-[44px]');
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
  });
});
