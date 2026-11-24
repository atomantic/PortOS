import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../../services/apiMeatspace.js', () => ({
  getMemoryItems: vi.fn(),
  createMemoryItem: vi.fn(),
  deleteMemoryItem: vi.fn(),
}));

import MemoryBuilder from './MemoryBuilder';
import { getMemoryItems } from '../../../services/apiMeatspace.js';

describe('MemoryBuilder load states', () => {
  beforeEach(() => getMemoryItems.mockReset());

  it('shows no empty copy while loading, then the empty copy for a genuinely empty list', async () => {
    let resolve;
    getMemoryItems.mockReturnValue(new Promise(r => { resolve = r; }));
    render(<MemoryBuilder onBack={() => {}} onSelectItem={() => {}} />);
    expect(screen.queryByText(/No memory items yet/)).toBeNull();
    expect(screen.queryByText(/all caught up/)).toBeNull();
    resolve([]);
    await screen.findByText(/No memory items yet/);
    screen.getByText(/all caught up/);
  });

  it('shows a load error with Retry on failure, and Retry loads the list', async () => {
    getMemoryItems.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([]);
    render(<MemoryBuilder onBack={() => {}} onSelectItem={() => {}} />);
    await screen.findByText(/Could not load memory items/);
    expect(screen.queryByText(/No memory items yet/)).toBeNull();
    expect(screen.queryByText(/all caught up/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => screen.getByText(/No memory items yet/));
  });
});
