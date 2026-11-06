import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CatalogSheetRecovery from './CatalogSheetRecovery';
import { listCatalogSheetJobs } from '../../services/apiCatalog';
import socket from '../../services/socket';

vi.mock('../../services/apiCatalog', () => ({ listCatalogSheetJobs: vi.fn() }));
vi.mock('../../services/socket', () => {
  const listeners = new Map();
  return { default: { connected: true, on: vi.fn((event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
  }), off: vi.fn((event, fn) => listeners.get(event)?.delete(fn)), emit: vi.fn(),
  fire: (event, payload) => listeners.get(event)?.forEach(fn => fn(payload)) } };
});
const saved = { jobId: 'failed-job', role: 'sheet:face', status: 'failed', error: 'Post-processing failed', savedFilename: 'original.png' };
const mount = (props = {}) => render(<MemoryRouter><CatalogSheetRecovery ingredientId="character-1" sheetMedia={[]} {...props} /></MemoryRouter>);
beforeEach(() => { vi.clearAllMocks(); listCatalogSheetJobs.mockResolvedValue({ jobs: [saved], hasMore: false }); });

describe('saved sheet recovery', () => {
  it('rediscovers a failed render after navigation and attaches only on an explicit click', async () => {
    const attach = vi.fn(async () => { listCatalogSheetJobs.mockResolvedValue({ jobs: [], hasMore: false }); return true; });
    mount({ onSheetFile: attach });
    expect(await screen.findByText('Post-processing failed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Preview saved image' })).toHaveAttribute('href', '/media/image?preview=image%3Aoriginal.png');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(attach).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Attach saved sheet' }));
    await waitFor(() => expect(attach).toHaveBeenCalledWith('original.png', 'sheet:face', 'Saved sheet attached for review'));
    await waitFor(() => expect(screen.queryByText('Post-processing failed')).not.toBeInTheDocument());
  });

  it('keeps failed attachment visible, hides missing-source recovery, and refreshes on queue changes', async () => {
    const attach = vi.fn().mockResolvedValue(false);
    mount({ onSheetFile: attach });
    fireEvent.click(await screen.findByRole('button', { name: 'Attach saved sheet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The original is still in the image library');
    listCatalogSheetJobs.mockResolvedValue({ jobs: [{ ...saved, savedFilename: null }], hasMore: false });
    socket.fire('media-jobs:changed', {});
    expect(await screen.findByText(/No saved image is available/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach saved sheet' })).not.toBeInTheDocument();
  });

  it('does not advertise recovery for already-attached images', async () => {
    mount({ sheetMedia: [{ mediaKey: 'original.png' }] });
    await waitFor(() => expect(listCatalogSheetJobs).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Sheet render recovery' })).not.toBeInTheDocument();
  });
});
