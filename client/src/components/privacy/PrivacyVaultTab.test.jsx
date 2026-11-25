import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getVaultRecords: vi.fn(),
  getPrivacyStatus: vi.fn(),
  deleteVaultRecord: vi.fn(),
  revealVaultRecord: vi.fn(),
  updateVaultRecord: vi.fn(),
}));
vi.mock('../../services/apiPrivacy.js', () => ({
  getVaultRecords: api.getVaultRecords,
  getPrivacyStatus: api.getPrivacyStatus,
  deleteVaultRecord: api.deleteVaultRecord,
  revealVaultRecord: api.revealVaultRecord,
  updateVaultRecord: api.updateVaultRecord,
}));
vi.mock('../ui/Toast');
vi.mock('./VaultRecordDrawer', () => ({ default: () => null }));
const loginSectionMounts = vi.hoisted(() => []);
vi.mock('./WebsiteLoginsSection', async () => {
  const { useState } = await import('react');
  return {
    // A lazy initializer runs once per mount, so this records remounts.
    default: function WebsiteLoginsSectionStub({ subjectId }) {
      useState(() => loginSectionMounts.push(subjectId));
      return null;
    },
  };
});

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

describe('PrivacyVaultTab website logins (#17397)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loginSectionMounts.length = 0;
    api.getPrivacyStatus.mockResolvedValue({ keyConfigured: true });
    api.getVaultRecords.mockResolvedValue([]);
  });

  it('keeps encryption and records unknown after failed reads, then renders empty on retry', async () => {
    api.getPrivacyStatus.mockRejectedValueOnce(new Error('Unavailable'));
    api.getVaultRecords.mockRejectedValueOnce(new Error('Unavailable'));
    render(<PrivacyVaultTab />);

    expect(await screen.findAllByRole('alert')).toHaveLength(2);
    expect(screen.queryByText(/Encryption engaged|No vault records yet/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);

    expect(await screen.findByText(/No vault records yet/)).toBeInTheDocument();
    expect(screen.getByText('Encryption engaged')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('remounts the Website logins section per subject so no state crosses scopes', async () => {
    const { rerender } = render(<PrivacyVaultTab subjectId="subject-a" />);
    rerender(<PrivacyVaultTab subjectId="subject-b" />);
    await waitFor(() => expect(loginSectionMounts).toEqual(['subject-a', 'subject-b']));
  });
});
