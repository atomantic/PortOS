import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getVaultRecords: vi.fn(),
  getPrivacyStatus: vi.fn(),
  deleteVaultRecord: vi.fn(),
  revealVaultRecord: vi.fn(),
  updateVaultRecord: vi.fn(),
}));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./VaultRecordDrawer', () => ({ default: () => null }));

import PrivacyVaultTab from './PrivacyVaultTab';

const record = (label) => ({ id: label, label, type: 'email', status: 'current', maskedValue: '••••' });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('PrivacyVaultTab subject switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPrivacyStatus.mockResolvedValue({ keyConfigured: true });
  });

  it('drops a slow read for the previous subject that lands after the new subject loaded', async () => {
    const slowA = deferred();
    api.getVaultRecords.mockImplementation((_type, { subjectId }) => (
      subjectId === 'subject-a' ? slowA.promise : Promise.resolve([record('Record for B')])
    ));

    const { rerender } = render(<PrivacyVaultTab subjectId="subject-a" />);
    rerender(<PrivacyVaultTab subjectId="subject-b" />);
    await waitFor(() => expect(screen.getByText('Record for B')).toBeTruthy());

    slowA.resolve([record('Record for A')]);
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText('Record for A')).toBeNull();
    expect(screen.getByText('Record for B')).toBeTruthy();
  });
});
