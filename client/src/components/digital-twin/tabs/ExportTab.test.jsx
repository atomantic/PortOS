import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/api', () => ({
  getDigitalTwinDocuments: vi.fn(),
  getDigitalTwinExportFormats: vi.fn(),
  exportSoul: vi.fn(),
}));

import * as api from '../../../services/api';
import ExportTab from './ExportTab.jsx';

describe('ExportTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDigitalTwinDocuments.mockResolvedValue([{ id: 'doc-1', enabled: true, title: 'Example' }]);
    api.getDigitalTwinExportFormats.mockResolvedValue([]);
  });

  it('re-enables Generate Export after the export request fails', async () => {
    api.exportSoul.mockRejectedValueOnce(new Error('export unavailable'));

    render(<ExportTab />);
    const exportButton = await screen.findByRole('button', { name: 'Generate Export' });

    await act(async () => { fireEvent.click(exportButton); });

    expect(exportButton).toBeEnabled();
    expect(exportButton).toHaveTextContent('Generate Export');
  });

  it('fails the whole tab into a retry when the document read fails, and never exports an unseeded selection', async () => {
    api.getDigitalTwinDocuments.mockRejectedValueOnce(new Error('boom'));

    render(<ExportTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load export options');
    // Without the documents the selection would be empty, which exports EVERY document.
    expect(screen.queryByRole('button', { name: 'Generate Export' })).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByRole('button', { name: 'Generate Export' })).toBeEnabled();
    api.exportSoul.mockResolvedValueOnce({ content: 'x' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate Export' })); });
    await waitFor(() => expect(api.exportSoul).toHaveBeenCalledWith('system_prompt', ['doc-1'], false));
  });

  it('fails into a retry when only the formats read fails', async () => {
    api.getDigitalTwinExportFormats.mockRejectedValueOnce(new Error('boom'));

    render(<ExportTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load export options');
  });
});
