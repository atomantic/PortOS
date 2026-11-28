import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../services/apiPrivacy.js', () => ({
  createPrivacyOrg: vi.fn(),
  updatePrivacyOrg: vi.fn(),
  getOrgHoldings: vi.fn(),
  setOrgHoldings: vi.fn(),
}));
vi.mock('../../services/apiDigitalTwin.js', () => ({
  getSocialAccounts: vi.fn(),
}));

import { getSocialAccounts } from '../../services/apiDigitalTwin.js';
import { updatePrivacyOrg, setOrgHoldings, getOrgHoldings } from '../../services/apiPrivacy.js';
import OrgDrawer from './OrgDrawer';

const ORG = { id: 'org-1', name: 'Acme Bank', category: 'bank' };
const VAULT = [{ id: 'v1', label: 'Example email', type: 'email', maskedValue: 'a***@example.com' }];

const renderDrawer = () => {
  const onSaved = vi.fn();
  render(<OrgDrawer open org={ORG} vaultRecords={VAULT} onClose={() => {}} onSaved={onSaved} />);
  return { onSaved };
};

beforeEach(() => {
  getSocialAccounts.mockResolvedValue({ accounts: [] });
  updatePrivacyOrg.mockImplementation(async (id, payload) => ({ id, ...payload }));
  setOrgHoldings.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrgDrawer holdings (replace-set)', () => {
  it('never erases stored holdings when their read failed', async () => {
    getOrgHoldings.mockRejectedValueOnce(new Error('boom'));
    const { onSaved } = renderDrawer();

    expect(await screen.findByText(/Could not load this organization's holdings/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updatePrivacyOrg).toHaveBeenCalledWith('org-1', expect.objectContaining({ name: 'Acme Bank' }), { silent: true });
    expect(setOrgHoldings).not.toHaveBeenCalled();
  });

  it('writes the loaded holdings once a retry succeeds', async () => {
    getOrgHoldings.mockRejectedValueOnce(new Error('boom'));
    getOrgHoldings.mockResolvedValue([{ vaultRecordId: 'v1' }]);
    const { onSaved } = renderDrawer();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('checkbox')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(setOrgHoldings).toHaveBeenCalledWith('org-1', [{ vaultRecordId: 'v1' }], { silent: true });
  });
});

describe('OrgDrawer linked social account picker', () => {
  it('shows a retryable error, not an unavailable link, when the account read failed', async () => {
    getOrgHoldings.mockResolvedValue([]);
    getSocialAccounts.mockRejectedValueOnce(new Error('twin down'));
    getSocialAccounts.mockResolvedValue({ accounts: [{ id: 'acct-1', platform: 'github', username: 'alice' }] });
    render(<OrgDrawer open org={{ ...ORG, socialAccountId: 'acct-1' }} vaultRecords={VAULT} onClose={() => {}} onSaved={() => {}} />);

    expect(await screen.findByText(/Could not load Digital Twin social accounts/)).toBeInTheDocument();
    expect(screen.queryByText('Linked account (unavailable)')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'github · @alice' })).toBeInTheDocument();
    expect(screen.queryByText(/Could not load Digital Twin social accounts/)).not.toBeInTheDocument();
  });
});

describe('OrgDrawer contact fields', () => {
  it('loads, preserves, and updates contact portalUrl and mailingAddress', async () => {
    getOrgHoldings.mockResolvedValue([]);
    const onSaved = vi.fn();
    const orgWithContact = {
      ...ORG,
      contact: {
        email: 'privacy@example.com',
        phone: '555-0100',
        portalUrl: 'https://privacy.example.com/optout',
        mailingAddress: '100 Example Ave, Suite 200',
      },
    };
    render(<OrgDrawer open org={orgWithContact} vaultRecords={VAULT} onClose={() => {}} onSaved={onSaved} />);

    const portalInput = screen.getByLabelText('Privacy portal URL');
    const addressInput = screen.getByLabelText('Mailing address');
    expect(portalInput).toHaveValue('https://privacy.example.com/optout');
    expect(addressInput).toHaveValue('100 Example Ave, Suite 200');

    fireEvent.change(portalInput, { target: { value: ' https://privacy.example.com/requests ' } });
    fireEvent.change(addressInput, { target: { value: ' 200 Example Blvd ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updatePrivacyOrg).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        contact: {
          email: 'privacy@example.com',
          phone: '555-0100',
          portalUrl: 'https://privacy.example.com/requests',
          mailingAddress: '200 Example Blvd',
        },
      }),
      { silent: true },
    );
  });
});
