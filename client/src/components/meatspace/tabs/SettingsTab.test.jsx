import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../services/socket', () => ({ default: {
  on: vi.fn(),
  off: vi.fn()
} }));
vi.mock('../../../services/api', () => ({
  uploadAppleHealthXml: vi.fn(),
  ingestAppleHealth: vi.fn()
}));
import SettingsTab from './SettingsTab';
import * as api from '../../../services/api';

const PICK_LABEL = 'Choose XML or ZIP file to import';

function pickFile() {
  const input = screen.getByLabelText(PICK_LABEL);
  fireEvent.change(input, { target: { files: [new File(['<HealthData/>'], 'export.xml', { type: 'text/xml' })] } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SettingsTab Apple Health XML import', () => {
  it('settles from the upload response alone, with no health:xml:complete event', async () => {
    let resolveUpload;
    api.uploadAppleHealthXml.mockReturnValueOnce(new Promise((resolve) => { resolveUpload = resolve; }));
    render(<SettingsTab />);

    pickFile();
    expect(screen.getByLabelText(PICK_LABEL)).toBeDisabled();

    resolveUpload({ days: 12, records: 3400, clinical: { clinicalRecords: 7, newDates: 2, newValues: 5 } });

    expect(await screen.findByText('Import successful')).toBeInTheDocument();
    expect(screen.getByLabelText(PICK_LABEL)).not.toBeDisabled();
    expect(screen.getByText('Clinical records').nextSibling).toHaveTextContent('7');
    expect(screen.getByText('Records imported').nextSibling).toHaveTextContent('3,400');
  });

  it('omits the clinical count when the ZIP carried no clinical records', async () => {
    api.uploadAppleHealthXml.mockResolvedValueOnce({ days: 1, records: 10 });
    render(<SettingsTab />);

    pickFile();

    expect(await screen.findByText('Import successful')).toBeInTheDocument();
    expect(screen.queryByText('Clinical records')).not.toBeInTheDocument();
  });

  it('shows the error and clears the importing state when the upload rejects', async () => {
    api.uploadAppleHealthXml.mockRejectedValueOnce(new Error('Import failed: bad export'));
    render(<SettingsTab />);

    pickFile();

    expect(await screen.findByText('Import failed: bad export')).toBeInTheDocument();
    expect(screen.queryByText('Import successful')).not.toBeInTheDocument();
    expect(screen.getByLabelText(PICK_LABEL)).not.toBeDisabled();
    await waitFor(() => expect(api.uploadAppleHealthXml).toHaveBeenCalledWith(expect.any(File), { silent: true }));
  });
});
