import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  getLegacyExportPreview: vi.fn(),
  downloadLegacyExport: vi.fn(),
}));
vi.mock('../../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../lib/downloadBlob', () => ({
  downloadBlob: vi.fn(),
}));

import LegacyExportTab from './LegacyExportTab';
import { getLegacyExportPreview, downloadLegacyExport } from '../../../services/api';
import { downloadBlob } from '../../../lib/downloadBlob';
import toast from '../../ui/Toast';

const PREVIEW = {
  fileCount: 6,
  estimatedBytes: 4096,
  sections: {
    identity: { label: 'Identity & Values', present: true, included: true, traits: 5 },
    goals: { label: 'Goals & Milestones', present: true, included: true, goals: 3 },
    health: { label: 'Health Summary', present: false, included: false },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  getLegacyExportPreview.mockResolvedValue(PREVIEW);
});

describe('LegacyExportTab', () => {
  it('renders only present sections, defaulted to selected', async () => {
    render(<LegacyExportTab />);
    expect(await screen.findByText('Identity & Values')).toBeInTheDocument();
    expect(screen.getByText('Goals & Milestones')).toBeInTheDocument();
    // Absent section is not offered.
    expect(screen.queryByText('Health Summary')).not.toBeInTheDocument();
    // Both present sections checked by default.
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes.every(b => b.checked)).toBe(true);
    // Count summary surfaces.
    expect(screen.getByText(/5 traits/)).toBeInTheDocument();
  });

  it('sends no section filter when all present sections are selected', async () => {
    downloadLegacyExport.mockResolvedValue(new ArrayBuffer(8));
    const user = userEvent.setup();
    render(<LegacyExportTab />);
    await screen.findByText('Identity & Values');

    await user.click(screen.getByRole('button', { name: /generate & download/i }));

    await waitFor(() => expect(downloadLegacyExport).toHaveBeenCalledOnce());
    expect(downloadLegacyExport).toHaveBeenCalledWith({ sections: null }, { silent: true });
    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalled();
  });

  it('sends the explicit subset when only some sections are selected', async () => {
    downloadLegacyExport.mockResolvedValue(new ArrayBuffer(8));
    const user = userEvent.setup();
    render(<LegacyExportTab />);
    await screen.findByText('Goals & Milestones');

    // Deselect identity (first checkbox), leaving only goals.
    const identityBox = document.getElementById('legacy-section-identity');
    await user.click(identityBox);
    await user.click(screen.getByRole('button', { name: /generate & download/i }));

    await waitFor(() => expect(downloadLegacyExport).toHaveBeenCalledOnce());
    expect(downloadLegacyExport).toHaveBeenCalledWith({ sections: ['goals'] }, { silent: true });
  });

  it('toasts an error and skips download when the build fails', async () => {
    downloadLegacyExport.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<LegacyExportTab />);
    await screen.findByText('Identity & Values');

    await user.click(screen.getByRole('button', { name: /generate & download/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('surfaces a large-bundle warning when the server flags one', async () => {
    getLegacyExportPreview.mockResolvedValue({
      ...PREVIEW,
      estimatedBytes: 30 * 1024 * 1024,
      sizeWarning: { thresholdBytes: 25 * 1024 * 1024, estimatedBytes: 30 * 1024 * 1024, largestSection: 'brain' },
    });
    render(<LegacyExportTab />);
    await screen.findByText('Identity & Values');
    expect(screen.getByText(/large bundle/i)).toBeInTheDocument();
    expect(screen.getByText(/brain/)).toBeInTheDocument();
  });

  it('shows no warning when sizeWarning is null', async () => {
    render(<LegacyExportTab />);
    await screen.findByText('Identity & Values');
    expect(screen.queryByText(/large bundle/i)).not.toBeInTheDocument();
  });

  it('shows an empty state and disables generate when no data is present', async () => {
    getLegacyExportPreview.mockResolvedValue({
      fileCount: 2,
      estimatedBytes: 0,
      sections: { identity: { label: 'Identity & Values', present: false, included: false } },
    });
    render(<LegacyExportTab />);
    expect(await screen.findByText(/no identity data available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate & download/i })).toBeDisabled();
  });
});
