import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ listeners: new Set(), sync: vi.fn(), success: vi.fn() }));
vi.mock('../../../services/socket', () => ({ default: {
  on: vi.fn((event, handler) => mocks.listeners.add(handler)),
  off: vi.fn((event, handler) => mocks.listeners.delete(handler))
} }));
vi.mock('../../../services/api', () => ({
  getGenomeSummary: vi.fn(async () => ({ uploaded: true, markers: [] })),
  getClinvarStatus: vi.fn(async () => ({ synced: false })),
  syncClinvar: mocks.sync
}));
vi.mock('../../ui/Toast', () => ({ default: { success: mocks.success } }));
vi.mock('../EpigeneticTracker', () => ({ default: () => null }));
import GenomeTab from './GenomeTab';

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
