import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  listStoryboards: vi.fn(),
  createStoryboard: vi.fn(),
  deleteStoryboard: vi.fn(),
}));

import Storyboards from './Storyboards';
import { listStoryboards } from '../services/api';

const renderPage = () => render(<MemoryRouter><Storyboards /></MemoryRouter>);

afterEach(cleanup);

describe('Storyboards create actions', () => {
  it('shows the empty-state button as the only create control for an empty list', async () => {
    listStoryboards.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No storyboards yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New storyboard' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^New$/ })).toBeNull();
  });

  it('keeps the header New action while loading, after a failed read, and with boards', async () => {
    listStoryboards.mockRejectedValueOnce(new Error('503'));
    const failed = renderPage();
    expect(screen.getByRole('button', { name: /^New$/ })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^New$/ })).toBeInTheDocument();
    failed.unmount();

    listStoryboards.mockResolvedValue([{ id: 'sb-1', name: 'Example Board', panelCount: 0 }]);
    renderPage();
    expect(await screen.findByText('Example Board')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^New$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New storyboard' })).toBeNull();
  });
});
