import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ listeners: new Set(), sync: vi.fn(), success: vi.fn() }));
vi.mock('../../../services/socket', () => ({ default: {
  on: vi.fn((event, handler) => { if (event === 'genome:clinvar-progress') mocks.listeners.add(handler); }),
  off: vi.fn((event, handler) => { if (event === 'genome:clinvar-progress') mocks.listeners.delete(handler); })
} }));
vi.mock('../../../services/apiMeatspace.js', () => ({
  getGenomeSummary: vi.fn(async () => ({ uploaded: true, markers: [] })),
  getClinvarStatus: vi.fn(async () => ({ synced: false })),
  syncClinvar: mocks.sync,
  scanGenomeMarkers: vi.fn(async () => ({ markers: [] })),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: mocks.success } }));
vi.mock('../EpigeneticTracker', () => ({ default: () => null }));
import GenomeTab from './GenomeTab';
import { getClinvarStatus, getGenomeSummary } from '../../../services/apiMeatspace.js';

const emit = (frame) => act(() => { for (const handler of mocks.listeners) handler(frame); });
const begin = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Sync ClinVar Database' }));
  return mocks.sync.mock.calls.at(-1)[0];
};
beforeEach(() => { mocks.listeners.clear(); mocks.sync.mockReset(); mocks.success.mockClear(); });
afterEach(cleanup);

describe('ClinVar progress interaction', () => {
  it('shows matching live phases, ignores other/settled runs, and trusts HTTP metadata', async () => {
    let resolve;
    mocks.sync.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    render(<GenomeTab />);
    const requestId = await begin();
    expect(mocks.listeners.size).toBe(1);
    emit({ requestId: 'other-request', message: 'Wrong run' });
    expect(screen.getByText('Starting ClinVar sync...')).toBeInTheDocument();
    for (const message of ['Downloading variants', 'Parsing variants', 'Building index']) {
      emit({ requestId, message });
      expect(screen.getByText(message)).toBeInTheDocument();
    }
    await act(async () => resolve({ synced: true, variantCount: 12 }));
    expect(screen.getByText('12 variants indexed')).toBeInTheDocument();
    expect(mocks.listeners.size).toBe(0);
    mocks.sync.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Re-sync' }));
    emit({ requestId, message: 'Old sync' });
    expect(screen.queryByText('Old sync')).not.toBeInTheDocument();
    expect(screen.getByText('Starting ClinVar sync...')).toBeInTheDocument();
  });

  it('releases running state after failure and removes listeners across remount', async () => {
    let reject;
    mocks.sync.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    const view = render(<GenomeTab />);
    await begin();
    await act(async () => reject(new Error('Download failed')));
    expect(screen.queryByText('Starting ClinVar sync...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync ClinVar Database' })).toBeEnabled();
    mocks.sync.mockReturnValue(new Promise(() => {}));
    await begin();
    view.unmount();
    expect(mocks.listeners.size).toBe(0);
    render(<GenomeTab />);
    await begin();
    await waitFor(() => expect(mocks.listeners.size).toBe(1));
  });
});

describe('genome load failure vs empty', () => {
  it('shows a retry notice and no upload drop zone when the summary read rejects', async () => {
    getGenomeSummary.mockRejectedValueOnce(new Error('boom'));
    render(<GenomeTab />);
    expect(await screen.findByText(/Could not load genome data\. Retry before uploading/)).toBeInTheDocument();
    expect(screen.queryByText(/Upload your 23andMe raw data export/)).not.toBeInTheDocument();
    expect(getGenomeSummary).toHaveBeenLastCalledWith({ silent: true });
    getGenomeSummary.mockResolvedValueOnce({ uploaded: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Upload your 23andMe raw data export/)).toBeInTheDocument();
  });

  it('still shows the upload prompt for a successful empty summary', async () => {
    getGenomeSummary.mockResolvedValueOnce({ uploaded: false });
    render(<GenomeTab />);
    expect(await screen.findByText(/Upload your 23andMe raw data export/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load genome data/)).not.toBeInTheDocument();
  });
});

describe('ClinVar status failure vs unsynced', () => {
  it('shows the first-time sync control only for a successful unsynced status', async () => {
    getClinvarStatus.mockResolvedValueOnce({ synced: false });
    render(<GenomeTab />);
    expect(await screen.findByRole('button', { name: 'Sync ClinVar Database' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the last synced status and offers retry when a later status read rejects', async () => {
    getClinvarStatus
      .mockResolvedValueOnce({ synced: true, variantCount: 9 })
      .mockRejectedValueOnce(new Error('status down'))
      .mockResolvedValueOnce({ synced: true, variantCount: 11 });
    render(<GenomeTab />);
    expect(await screen.findByText('9 variants indexed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Scan Known Markers' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not read ClinVar status/);
    expect(screen.queryByRole('button', { name: 'Sync ClinVar Database' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan Against ClinVar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-sync' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('11 variants indexed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan Against ClinVar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-sync' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync ClinVar Database' })).not.toBeInTheDocument();
  });
});
