import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ downloadVideoSharingCopy: vi.fn() }));
const saved = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock('../../services/apiImageVideo', () => api);
vi.mock('../../lib/downloadBlob', () => saved);

import SharingDownloadButton from './SharingDownloadButton';

beforeEach(() => vi.clearAllMocks());

describe('SharingDownloadButton', () => {
  it('saves the re-encoded copy for a caller with host control', async () => {
    const blob = new Blob(['video'], { type: 'video/mp4' });
    api.downloadVideoSharingCopy.mockResolvedValue(blob);
    render(<SharingDownloadButton itemId="abc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download for sharing' }));
    await waitFor(() => expect(saved.downloadBlob).toHaveBeenCalledWith(blob, 'sharing-abc.mp4', 'video/mp4'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows an unavailable note, not a saved error body, when host control refuses the encode', async () => {
    api.downloadVideoSharingCopy.mockRejectedValue(Object.assign(new Error('Host control requires an operator session'), { code: 'HOST_CONTROL_FORBIDDEN' }));
    render(<SharingDownloadButton itemId="abc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download for sharing' }));
    expect(await screen.findByRole('status')).toHaveTextContent('needs operator access');
    expect(saved.downloadBlob).not.toHaveBeenCalled();
  });

  it('reports any other failure with the server message', async () => {
    api.downloadVideoSharingCopy.mockRejectedValue(new Error('Set a poster before downloading for sharing'));
    render(<SharingDownloadButton itemId="abc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download for sharing' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Set a poster before downloading for sharing');
  });
});
