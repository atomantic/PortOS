import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../services/api', () => ({
  addLoomEpisode: vi.fn(),
  addLoomNode: vi.fn(),
  deleteLoomEpisode: vi.fn(),
  getLoom: vi.fn(),
  getPipelineSeries: vi.fn(),
  updateLoomEpisode: vi.fn(),
  updateLoomNode: vi.fn(),
  weaveLoomEpisode: vi.fn(),
}));

// The graph canvas and the rails are irrelevant to the header — stub them so
// the suite exercises the loom → series backlink and nothing else.
vi.mock('../components/fableloom/LoomCanvas', () => ({ default: () => <div /> }));
vi.mock('../components/fableloom/LoomNodeEditor', () => ({ default: () => <div /> }));
vi.mock('../components/fableloom/LoomPlayPanel', () => ({ default: () => <div /> }));
vi.mock('../components/fableloom/LoomSettingsDrawer', () => ({ default: () => <div /> }));
vi.mock('../components/fableloom/LoomValidationPanel', () => ({ default: () => <div /> }));

import * as api from '../services/api';
import FableLoomStory from './FableLoomStory';

const loom = (fields = {}) => ({
  id: 'loom-1',
  name: 'Example Loom',
  format: 'prose',
  universeId: null,
  seriesId: null,
  episodes: [],
  ...fields,
});

const renderEditor = () => render(
  <MemoryRouter initialEntries={['/fableloom/loom-1']}>
    <Routes>
      <Route path="/fableloom/:loomId" element={<FableLoomStory />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getLoom.mockResolvedValue(loom());
});

describe('FableLoomStory series backlink', () => {
  it('links back to the series a loom is soft-linked to', async () => {
    api.getLoom.mockResolvedValue(loom({ seriesId: 'ser-1' }));
    api.getPipelineSeries.mockResolvedValue({ id: 'ser-1', name: 'Example Series' });
    renderEditor();

    const link = await screen.findByRole('link', { name: /Example Series/ });
    expect(link).toHaveAttribute('href', '/pipeline/series/ser-1');
    expect(api.getPipelineSeries).toHaveBeenCalledWith('ser-1', { silent: true });
  });

  it('renders no chip (not a dead link) when the linked series has been deleted', async () => {
    api.getLoom.mockResolvedValue(loom({ seriesId: 'ser-gone' }));
    api.getPipelineSeries.mockRejectedValue(new Error('Series not found'));
    renderEditor();

    await screen.findByText('Example Loom');
    await waitFor(() => expect(api.getPipelineSeries).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /series/i })).toBeNull();
  });

  it('falls back to a placeholder for a series with no name', async () => {
    api.getLoom.mockResolvedValue(loom({ seriesId: 'ser-1' }));
    api.getPipelineSeries.mockResolvedValue({ id: 'ser-1', name: '' });
    renderEditor();

    expect(await screen.findByRole('link', { name: /Untitled series/ }))
      .toHaveAttribute('href', '/pipeline/series/ser-1');
  });

  it('never asks for a series when the loom is standalone', async () => {
    renderEditor();
    await screen.findByText('Example Loom');
    expect(api.getPipelineSeries).not.toHaveBeenCalled();
  });
});
