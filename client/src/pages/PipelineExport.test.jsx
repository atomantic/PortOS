import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

const api = vi.hoisted(() => ({
  getPipelineSeries: vi.fn(),
  updatePipelineSeries: vi.fn(),
  proseExportManuscriptUrl: vi.fn(() => '/m'),
  proseExportEpubUrl: vi.fn(() => '/e'),
  proseExportPdfUrl: vi.fn(() => '/p'),
  listMediaCollections: vi.fn(),
  getGalleryImages: vi.fn(),
  listVideoHistory: vi.fn(),
}));
vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

import PipelineExport, { TRIM_SIZE_LABELS, FONT_LABELS } from './PipelineExport.jsx';
import { TRIM_SIZES, INTERIOR_FONTS } from '../lib/proseExportSettings.js';

// A trim size or font added server-side without a label here would render a blank option.
describe('PipelineExport labels', () => {
  it('has exactly one label per server trim size', () => {
    expect(Object.keys(TRIM_SIZE_LABELS).sort()).toEqual(Object.keys(TRIM_SIZES).sort());
  });

  it('has exactly one label per server interior font', () => {
    expect(Object.keys(FONT_LABELS).sort()).toEqual([...INTERIOR_FONTS].sort());
  });
});

describe('PipelineExport attribution rollup', () => {
  const asset = {
    filename: 'img-1.png',
    provenance: { sources: [{ kind: 'model', id: 'model-a', name: 'Example Model', license: 'mit' }] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getPipelineSeries.mockResolvedValue({ id: 'ser-1', name: 'Example Series' });
    api.listVideoHistory.mockResolvedValue([]);
    api.getGalleryImages.mockResolvedValue([asset]);
  });

  const renderPage = () => render(
    <MemoryRouter initialEntries={['/pipeline/ser-1/export']}>
      <Routes><Route path="/pipeline/:seriesId/export" element={<PipelineExport />} /></Routes>
    </MemoryRouter>,
  );

  it('shows a load error with Retry when the asset read fails, instead of silently hiding the licenses', async () => {
    api.listMediaCollections.mockRejectedValueOnce(new Error('Collections unavailable'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load attribution and licenses — Collections unavailable');
    expect(screen.queryByLabelText('Attribution and licenses')).toBeNull();

    api.listMediaCollections.mockResolvedValueOnce([{ id: 'sc-ser-1', items: [{ kind: 'image', ref: 'img-1.png' }] }]);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText('Attribution and licenses')).toHaveTextContent('Example Model');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
