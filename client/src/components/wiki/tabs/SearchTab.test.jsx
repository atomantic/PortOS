import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import SearchTab from './SearchTab';
import * as api from '../../../services/api';

vi.mock('../../../services/api');

const renderTab = (vaultId) => (
  <MemoryRouter><SearchTab vaultId={vaultId} /></MemoryRouter>
);

describe('SearchTab superseded searches (#12951)', () => {
  it('drops a slower earlier-vault response that resolves after the current search', async () => {
    let resolveOld;
    api.searchNotes.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    api.searchNotes.mockResolvedValueOnce({ results: [], total: 0 });
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
});
