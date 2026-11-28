import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../services/apiPrivacy.js', () => ({
  getPrivacyOrgs: vi.fn(),
  deletePrivacyOrg: vi.fn(),
  getVaultRecords: vi.fn(),
  getOrgHoldings: vi.fn(),
  createPrivacyOrg: vi.fn(),
  updatePrivacyOrg: vi.fn(),
  setOrgHoldings: vi.fn(),
}));
vi.mock('../../services/apiDigitalTwin.js', () => ({
  getSocialAccounts: vi.fn(),
}));

import { getPrivacyOrgs, getVaultRecords, getOrgHoldings } from '../../services/apiPrivacy.js';
import PrivacyOrgsTab from './PrivacyOrgsTab';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PrivacyOrgsTab', () => {
  it('shows a failed organization read as a retryable error, not "No organizations yet"', async () => {
    getPrivacyOrgs.mockRejectedValueOnce(new Error('boom'));
    getPrivacyOrgs.mockResolvedValue([{ id: 'org-1', name: 'Acme Bank', category: 'bank', trust: 'trusted', status: 'active' }]);
    getVaultRecords.mockResolvedValue([]);
    getOrgHoldings.mockResolvedValue([]);
    render(<PrivacyOrgsTab subjectId="self" />);

    expect(await screen.findByText(/Could not load organizations/)).toBeInTheDocument();
    expect(screen.queryByText(/No organizations yet/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Acme Bank')).toBeInTheDocument();
  });

  it('shows a holdings error instead of "No holdings recorded" when a badge read fails, and Retry restores it', async () => {
    getPrivacyOrgs.mockResolvedValue([{ id: 'org-1', name: 'Acme Bank', category: 'bank', trust: 'trusted', status: 'active' }]);
    getVaultRecords.mockResolvedValue([]);
    getOrgHoldings.mockRejectedValueOnce(new Error('holdings down'));
    getOrgHoldings.mockResolvedValue([{ vaultRecordId: 'v1', status: 'current' }]);
    render(<PrivacyOrgsTab subjectId="self" />);

    expect(await screen.findByText(/Could not load holdings/)).toBeInTheDocument();
    expect(screen.queryByText('No holdings recorded')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/1 current/i)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load holdings/)).not.toBeInTheDocument();
  });

  it('renders a safe privacy portal link only for http(s) portalUrl values', async () => {
    getPrivacyOrgs.mockResolvedValue([
      { id: 'org-1', name: 'Acme Bank', category: 'bank', trust: 'trusted', status: 'active', contact: { portalUrl: 'https://privacy.example.com' } },
      { id: 'org-2', name: 'Unsafe Org', category: 'other', trust: 'unwanted', status: 'active', contact: { portalUrl: 'javascript:alert(1)' } },
    ]);
    getVaultRecords.mockResolvedValue([]);
    getOrgHoldings.mockResolvedValue([]);
    render(<PrivacyOrgsTab subjectId="self" />);

    const portalLinks = await screen.findAllByRole('link', { name: 'Open privacy portal' });
    expect(portalLinks).toHaveLength(1);
    expect(portalLinks[0]).toHaveAttribute('href', 'https://privacy.example.com');
  });
});
