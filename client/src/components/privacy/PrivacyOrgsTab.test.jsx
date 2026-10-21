import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getPrivacyOrgs: vi.fn(),
  deletePrivacyOrg: vi.fn(),
  getVaultRecords: vi.fn(),
  getOrgHoldings: vi.fn(),
  createPrivacyOrg: vi.fn(),
  updatePrivacyOrg: vi.fn(),
  setOrgHoldings: vi.fn(),
  getSocialAccounts: vi.fn(),
}));

import * as api from '../../services/api';
import PrivacyOrgsTab from './PrivacyOrgsTab';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PrivacyOrgsTab', () => {
  it('shows a failed organization read as a retryable error, not "No organizations yet"', async () => {
    api.getPrivacyOrgs.mockRejectedValueOnce(new Error('boom'));
    api.getPrivacyOrgs.mockResolvedValue([{ id: 'org-1', name: 'Acme Bank', category: 'bank', trust: 'trusted', status: 'active' }]);
    api.getVaultRecords.mockResolvedValue([]);
    api.getOrgHoldings.mockResolvedValue([]);
    render(<PrivacyOrgsTab subjectId="self" />);

    expect(await screen.findByText(/Could not load organizations/)).toBeInTheDocument();
    expect(screen.queryByText(/No organizations yet/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Acme Bank')).toBeInTheDocument();
  });
});
