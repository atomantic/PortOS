import { act, fireEvent, render, screen } from '@testing-library/react';
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
});
