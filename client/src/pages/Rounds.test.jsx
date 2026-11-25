import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/apiRounds.js', () => ({
  listRounds: vi.fn(),
  createRound: vi.fn(),
  deleteRound: vi.fn(),
  generateRound: vi.fn(),
}));
vi.mock('../components/ui/Toast');

import Rounds from './Rounds';
import { listRounds } from '../services/apiRounds.js';

const renderPage = async () => {
  render(<MemoryRouter><Rounds /></MemoryRouter>);
  await act(async () => {});
};

describe('Rounds index', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the empty copy only for a successful empty read', async () => {
    listRounds.mockResolvedValue({ rounds: [] });
    await renderPage();
    expect(await screen.findByText('No rounds yet — write your first above.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a Retry instead of the empty copy on a failed read, and recovers on Retry', async () => {
    listRounds.mockRejectedValueOnce(new Error('503 down')).mockResolvedValue({
      rounds: [{ id: 'r1', title: 'Example Round', artist: 'Example Artist', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    await renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load rounds');
    expect(screen.queryByText(/No rounds yet/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Example Round')).toBeInTheDocument();
  });
});
