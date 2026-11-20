import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../services/apiMeatspace.js', () => ({
  getBloodTests: vi.fn(),
  getMeatspaceConfig: vi.fn(async () => ({})),
}));
vi.mock('../../../lib/clipboard', () => ({ copyToClipboard: vi.fn() }));
import ExportTab from './ExportTab';
import { getBloodTests, getMeatspaceConfig } from '../../../services/apiMeatspace.js';

afterEach(cleanup);

describe('ExportTab load failure vs empty', () => {
  it('offers no Print/Copy when the blood read rejects, and recovers on retry', async () => {
    getBloodTests.mockRejectedValueOnce(new Error('boom'));
    render(<ExportTab />);
    expect(await screen.findByText(/Could not build the clinician summary\. Retry\./)).toBeInTheDocument();
    expect(screen.queryByText(/No blood test data on record/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Print/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy markdown/ })).not.toBeInTheDocument();
    expect(getBloodTests).toHaveBeenLastCalledWith({ silent: true });
    getBloodTests.mockResolvedValueOnce({ tests: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Print/ })).toBeInTheDocument();
  });

  it('offers no Print/Copy when the profile read rejects, so a blank lifestyle section is never printed', async () => {
    getBloodTests.mockResolvedValueOnce({ tests: [] });
    getMeatspaceConfig.mockRejectedValueOnce(new Error('boom'));
    render(<ExportTab />);
    expect(await screen.findByText(/Could not build the clinician summary\. Retry\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Print/ })).not.toBeInTheDocument();
    expect(getMeatspaceConfig).toHaveBeenLastCalledWith({ silent: true });
  });

  it('keeps the report and its empty sentence for a successful empty payload', async () => {
    getBloodTests.mockResolvedValueOnce({ tests: [] });
    render(<ExportTab />);
    expect(await screen.findByText('No blood test data on record.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Print/ })).toBeInTheDocument();
  });
});
