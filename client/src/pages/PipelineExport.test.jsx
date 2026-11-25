import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

const api = vi.hoisted(() => ({
  getPipelineSeries: vi.fn(),
  updatePipelineSeries: vi.fn(),
  fetchProseExport: vi.fn(),
  downloadBlob: vi.fn(),
  listMediaCollections: vi.fn(),
  getGalleryImages: vi.fn(),
  listVideoHistory: vi.fn(),
}));
vi.mock('../services/apiPipeline.js', () => ({
  getPipelineSeries: api.getPipelineSeries,
  updatePipelineSeries: api.updatePipelineSeries,
  fetchProseExport: api.fetchProseExport,
  PROSE_EXPORT_NO_CONTENT: 'PIPELINE_PROSE_EXPORT_NO_CONTENT',
}));
vi.mock('../lib/downloadBlob.js', () => ({ downloadBlob: api.downloadBlob }));
vi.mock('../services/apiImageVideo.js', () => ({
  listMediaCollections: api.listMediaCollections,
  getGalleryImages: api.getGalleryImages,
  listVideoHistory: api.listVideoHistory,
}));
vi.mock('../components/ui/Toast');

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

  it('reads the full video history, not the compact catalog, so stamped video licenses survive the rollup', async () => {
    api.listMediaCollections.mockResolvedValue([{ id: 'sc-ser-1', items: [{ kind: 'image', ref: 'img-1.png' }] }]);
    renderPage();

    expect(await screen.findByLabelText('Attribution and licenses')).toBeTruthy();
    expect(api.listVideoHistory).toHaveBeenCalledWith({ silent: true });
  });
});

describe('PipelineExport downloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPipelineSeries.mockResolvedValue({ id: 'ser-1', name: 'Example Series' });
    api.listMediaCollections.mockResolvedValue([]);
    api.listVideoHistory.mockResolvedValue([]);
    api.getGalleryImages.mockResolvedValue([]);
  });

  const renderPage = () => render(
    <MemoryRouter initialEntries={['/pipeline/ser-1/export']}>
      <Routes><Route path="/pipeline/:seriesId/export" element={<PipelineExport />} /></Routes>
    </MemoryRouter>,
  );

  it('saves each successful download under the server filename', async () => {
    const blob = new Blob(['# Book']);
    api.fetchProseExport.mockResolvedValue({ blob, filename: 'example-series.md' });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Manuscript/ }));
    await vi.waitFor(() => expect(api.downloadBlob).toHaveBeenCalledWith(blob, 'example-series.md'));
    expect(api.fetchProseExport).toHaveBeenCalledWith('ser-1', 'md');

    api.fetchProseExport.mockResolvedValue({ blob, filename: 'example-series.epub' });
    await userEvent.click(screen.getByRole('button', { name: /ePub/ }));
    await vi.waitFor(() => expect(api.downloadBlob).toHaveBeenCalledWith(blob, 'example-series.epub'));
    expect(api.fetchProseExport).toHaveBeenLastCalledWith('ser-1', 'epub');

    api.fetchProseExport.mockResolvedValue({ blob, filename: 'example-series.pdf' });
    await userEvent.click(screen.getByRole('button', { name: /Print Interior/ }));
    await vi.waitFor(() => expect(api.downloadBlob).toHaveBeenCalledWith(blob, 'example-series.pdf'));
    expect(api.fetchProseExport).toHaveBeenLastCalledWith('ser-1', 'pdf');
  });

  it('explains a no-prose refusal with a link to the manuscript editor and starts no download', async () => {
    api.fetchProseExport.mockRejectedValue(Object.assign(new Error('No drafted prose'), { code: 'PIPELINE_PROSE_EXPORT_NO_CONTENT', status: 409 }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Manuscript/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('no issue in this series has drafted prose');
    expect(screen.getByRole('link', { name: 'manuscript editor' })).toHaveAttribute('href', '/pipeline/series/ser-1/manuscript');
    expect(api.downloadBlob).not.toHaveBeenCalled();
  });

  it('shows other failures on the page and allows a retry that clears the error', async () => {
    api.fetchProseExport.mockRejectedValueOnce(Object.assign(new Error('Render crashed'), { status: 500 }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Print Interior/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Export failed: Render crashed. Try again.');

    const blob = new Blob(['pdf']);
    api.fetchProseExport.mockResolvedValueOnce({ blob, filename: 'a.pdf' });
    await userEvent.click(screen.getByRole('button', { name: /Print Interior/ }));
    await vi.waitFor(() => expect(api.downloadBlob).toHaveBeenCalledWith(blob, 'a.pdf'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gates downloads on unsaved settings', async () => {
    renderPage();
    await userEvent.type(await screen.findByLabelText('Subtitle'), 'x');
    await userEvent.click(screen.getByRole('button', { name: /Manuscript/ }));
    expect(api.fetchProseExport).not.toHaveBeenCalled();
  });
});
