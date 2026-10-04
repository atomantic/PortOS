import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  listUploads: vi.fn(),
  uploadFile: vi.fn(),
  deleteUpload: vi.fn(),
  deleteAllUploads: vi.fn(),
  getUploadUrl: vi.fn(name => `/uploads/${name}`),
}));
vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import Uploads from './Uploads';

const oneFile = {
  uploads: [{ filename: 'a.txt', mimeType: 'text/plain', sizeFormatted: '1 B', createdAt: '2026-01-01T00:00:00Z' }],
  count: 1,
  totalSizeFormatted: '1 B',
};

describe('Uploads inventory states', () => {
  beforeEach(() => vi.clearAllMocks());

  it('initial read failure shows unavailable state, not the empty claim; retry recovers', async () => {
    api.listUploads.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ uploads: [], count: 0, totalSizeFormatted: '0 B' });
    render(<Uploads />);
    expect(await screen.findByText('Uploads could not be loaded')).toBeTruthy();
    expect(screen.getByText('Upload totals unavailable')).toBeTruthy();
    expect(screen.queryByText('No files uploaded yet')).toBeNull();
    expect(screen.queryByText(/0 files/)).toBeNull();

    fireEvent.click(screen.getByText('Retry upload inventory'));
    expect(await screen.findByText('No files uploaded yet')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.uploadFile).not.toHaveBeenCalled();
    expect(api.deleteUpload).not.toHaveBeenCalled();
  });

  it('failed refresh keeps last-good rows and labels them stale', async () => {
    api.listUploads.mockResolvedValueOnce(oneFile).mockRejectedValueOnce(new Error('boom'));
    render(<Uploads />);
    expect(await screen.findByText('a.txt')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Refresh'));
    expect(await screen.findByText(/could not be refreshed/)).toBeTruthy();
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(screen.getByText('1 file (1 B)')).toBeTruthy();
    expect(screen.queryByText('No files uploaded yet')).toBeNull();

    api.listUploads.mockResolvedValueOnce(oneFile);
    fireEvent.click(screen.getByText('Retry upload inventory'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
