import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  createDeck: vi.fn(), deleteDeck: vi.fn(), listDecks: vi.fn(), listUniverseSummaries: vi.fn(),
}));
vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import Decks from './Decks';

describe('Decks universe picker list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listDecks.mockResolvedValue([]);
    api.listUniverseSummaries.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
  });

  it('shows a retry row when universe summaries fail and clears it after a successful empty read', async () => {
    render(<MemoryRouter><Decks /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load universes');
    expect(api.listUniverseSummaries).toHaveBeenCalledWith({ silent: true });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(api.listUniverseSummaries).toHaveBeenCalledTimes(2);
  });
});
