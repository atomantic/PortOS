import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  createPrivacyOrg: vi.fn(),
  updatePrivacyOrg: vi.fn(),
  getOrgHoldings: vi.fn(),
  setOrgHoldings: vi.fn(),
  getSocialAccounts: vi.fn(),
}));

import * as api from '../../services/api';
import OrgDrawer from './OrgDrawer';

const ORG = { id: 'org-1', name: 'Acme Bank', category: 'bank' };
const VAULT = [{ id: 'v1', label: 'Example email', type: 'email', maskedValue: 'a***@example.com' }];

const renderDrawer = () => {
  const onSaved = vi.fn();
  render(<OrgDrawer open org={ORG} vaultRecords={VAULT} onClose={() => {}} onSaved={onSaved} />);
  return { onSaved };
};

beforeEach(() => {
  api.getSocialAccounts.mockResolvedValue({ accounts: [] });
  api.updatePrivacyOrg.mockImplementation(async (id, payload) => ({ id, ...payload }));
  api.setOrgHoldings.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrgDrawer holdings (replace-set)', () => {
  it('never erases stored holdings when their read failed', async () => {
    api.getOrgHoldings.mockRejectedValueOnce(new Error('boom'));
    const { onSaved } = renderDrawer();

    expect(await screen.findByText(/Could not load this organization's holdings/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.updatePrivacyOrg).toHaveBeenCalledWith('org-1', expect.objectContaining({ name: 'Acme Bank' }), { silent: true });
    expect(api.setOrgHoldings).not.toHaveBeenCalled();
  });

  it('writes the loaded holdings once a retry succeeds', async () => {
    api.getOrgHoldings.mockRejectedValueOnce(new Error('boom'));
    api.getOrgHoldings.mockResolvedValue([{ vaultRecordId: 'v1' }]);
    const { onSaved } = renderDrawer();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('checkbox')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.setOrgHoldings).toHaveBeenCalledWith('org-1', [{ vaultRecordId: 'v1' }], { silent: true });
  });
});
