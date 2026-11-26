import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getLegacyExportPreview: vi.fn(),
  downloadLegacyExport: vi.fn(),
}));
vi.mock('../../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('../../ui/Toast');
vi.mock('../../../lib/downloadBlob', () => ({
  downloadBlob: vi.fn(),
}));

import LegacyExportTab from './LegacyExportTab';
import { getLegacyExportPreview, downloadLegacyExport } from '../../../services/apiDigitalTwin.js';
import { downloadBlob } from '../../../lib/downloadBlob';
import toast from '../../ui/Toast';
import socket from '../../../services/socket';

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
    expect(boxes).toHaveLength(3);
    expect(screen.getByLabelText('Include PDF portrait (legacy-portrait.pdf)')).not.toBeChecked();
    expect(boxes.slice(0, 2).every(b => b.checked)).toBe(true);
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
    expect(downloadLegacyExport).toHaveBeenCalledWith({ sections: null, includePdf: false }, { silent: true });
    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalled();
  });


  it('includes the PDF option and displays live generation phases', async () => {
    let onProgress;
    socket.on.mockImplementation((event, handler) => {
      if (event === 'legacy-export:progress') onProgress = handler;
    });
    downloadLegacyExport.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<LegacyExportTab />);
    await screen.findByText('Identity & Values');
    await user.click(screen.getByLabelText('Include PDF portrait (legacy-portrait.pdf)'));
    await user.click(screen.getByRole('button', { name: /generate & download/i }));

    await waitFor(() => expect(downloadLegacyExport).toHaveBeenCalledWith(
      { sections: null, includePdf: true }, { silent: true },
    ));
    await act(async () => onProgress({ phase: 'gathered' }));
    expect(screen.getByText('Gathering sections…')).toBeInTheDocument();
    await act(async () => onProgress({ phase: 'pdf', pageCount: 4 }));
    expect(screen.getByText('Rendering PDF portrait… (4 pages)')).toBeInTheDocument();
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
    expect(downloadLegacyExport).toHaveBeenCalledWith({ sections: ['goals'], includePdf: false }, { silent: true });
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

describe('LegacyExportTab preview failure', () => {
  it('shows a retryable error, not the "no identity data" empty state, when the preview read fails', async () => {
    const user = userEvent.setup();
    getLegacyExportPreview.mockRejectedValueOnce(new Error('preview offline'));
    render(<LegacyExportTab />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load legacy bundle sections — preview offline');
    expect(screen.queryByText(/No identity data available yet/)).not.toBeInTheDocument();

    await user.click(alert.querySelector('button'));
    expect(await screen.findByLabelText(/Identity & Values/)).toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the empty-state copy when the preview genuinely has no present sections', async () => {
    getLegacyExportPreview.mockResolvedValueOnce({
      fileCount: 0,
      estimatedBytes: 0,
      sections: { health: { label: 'Health Summary', present: false, included: false } },
    });
    render(<LegacyExportTab />);

    expect(await screen.findByText(/No identity data available yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
