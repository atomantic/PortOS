import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  getDigitalTwinDocuments: vi.fn(),
  getDigitalTwinDocument: vi.fn(),
  updateSoulDocument: vi.fn(),
  createSoulDocument: vi.fn(),
  deleteSoulDocument: vi.fn()
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}));

import DocumentsTab from './DocumentsTab';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';

const DOC = { id: 'doc-1', title: 'Core Values', category: 'core', enabled: true, weight: 5, content: 'original', lastModified: '2026-01-01T00:00:00.000Z' };

describe('DocumentsTab failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDigitalTwinDocuments.mockResolvedValue([DOC]);
    api.getDigitalTwinDocument.mockResolvedValue(DOC);
  });

  it('re-enables Save after a rejected update so the unsaved edit can be retried', async () => {
    api.updateSoulDocument.mockRejectedValueOnce(new Error('Document is locked'));
    const user = userEvent.setup();
    render(<DocumentsTab onRefresh={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /Core Values/ }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateSoulDocument).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled());
    expect(toast.success).not.toHaveBeenCalled();

    // The retry goes through: the editor was not stranded behind a stuck `saving` flag.
    api.updateSoulDocument.mockResolvedValueOnce({});
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Document saved'));
  });
});
