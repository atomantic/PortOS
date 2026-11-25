import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getSocialAccounts: vi.fn(),
  getSocialAccountPlatforms: vi.fn(),
  getSocialAccountStats: vi.fn(),
  createSocialAccount: vi.fn(),
  updateSocialAccount: vi.fn(),
  deleteSocialAccount: vi.fn(),
}));
vi.mock('../../../services/apiPrivacy.js', () => ({
  getSocialAccountOrgLinks: vi.fn(),
  createPrivacyOrg: vi.fn(),
}));

vi.mock('../../ui/Toast');

import AccountsTab from './AccountsTab';
import {
  getSocialAccounts,
  getSocialAccountPlatforms,
  getSocialAccountStats,
  createSocialAccount,
  updateSocialAccount,
} from '../../../services/apiDigitalTwin.js';
import { getSocialAccountOrgLinks } from '../../../services/apiPrivacy.js';

const MOCK_PLATFORMS = {
  platforms: [
    { id: 'github', label: 'GitHub', category: 'developer', urlTemplate: 'https://github.com/{username}' },
    { id: 'x', label: 'X (Twitter)', category: 'social', urlTemplate: 'https://x.com/{username}' }
  ]
};

const MOCK_STATS = {
  total: 2,
  ingestionEnabled: 1,
  byCategory: { developer: 1, social: 1 },
  byPlatform: { github: 1, x: 1 }
};

const MOCK_ACCOUNTS = {
  accounts: [
    {
      id: 'acc-1',
      platform: 'github',
      username: 'octocat',
      displayName: 'The Octocat',
      url: 'https://github.com/octocat',
      bio: 'Mona Lisa Octocat',
      notes: 'Work account',
      ingestionEnabled: true
    },
    {
      id: 'acc-2',
      platform: 'x',
      username: 'octo_x',
      displayName: 'Octo X',
      url: 'https://x.com/octo_x',
      bio: '',
      notes: '',
      ingestionEnabled: false
    }
  ]
};

beforeEach(() => {
  vi.clearAllMocks();
  getSocialAccounts.mockResolvedValue(MOCK_ACCOUNTS);
  getSocialAccountPlatforms.mockResolvedValue(MOCK_PLATFORMS);
  getSocialAccountStats.mockResolvedValue(MOCK_STATS);
  getSocialAccountOrgLinks.mockResolvedValue([]);
  createSocialAccount.mockResolvedValue({ id: 'acc-3', platform: 'github', username: 'newuser' });
  updateSocialAccount.mockResolvedValue({ id: 'acc-1', platform: 'github', username: 'octocat' });
});

describe('AccountsTab', () => {
  it('renders directory/profile reference text and hides ingestion metric and badge', async () => {
    render(<AccountsTab />);

    expect(await screen.findByText('Social Accounts')).toBeInTheDocument();
    expect(screen.getByText('Your online presence directory and profile reference')).toBeInTheDocument();

    // Stats tiles: Total, Categories, Platforms are shown, Ingestion Enabled is NOT
    expect(screen.getByText('Total Accounts')).toBeInTheDocument();
    expect(screen.getByText('Categories')).toBeInTheDocument();
    expect(screen.getByText('Platforms')).toBeInTheDocument();
    expect(screen.queryByText(/Ingestion Enabled/i)).not.toBeInTheDocument();

    // Ingestion badge must not appear even though acc-1 has ingestionEnabled: true
    expect(screen.queryByText('ingestion')).not.toBeInTheDocument();
    expect(screen.getByText('@octocat')).toBeInTheDocument();
  });

  it('omits ingestionEnabled when creating a new account and does not render switch', async () => {
    const user = userEvent.setup();
    render(<AccountsTab />);
    await screen.findByText('Social Accounts');

    // Open add account form
    await user.click(screen.getByRole('button', { name: /add account/i }));

    // Verify no ingestion toggle/switch exists
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/ingestion/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/content ingestion/i)).not.toBeInTheDocument();

    // Select platform and fill form
    await user.click(screen.getByRole('button', { name: 'GitHub' }));
    await user.type(screen.getByPlaceholderText(/Your GitHub username/i), 'newuser');
    await user.type(screen.getByPlaceholderText(/Optional display name/i), 'New User');
    await user.type(screen.getByPlaceholderText(/What you use this account for/i), 'Coding samples');
    await user.type(screen.getByPlaceholderText(/Private notes about this account/i), 'Secret notes');

    // Submit form: find the button inside the form actions (second "Add Account" button)
    const addButtons = screen.getAllByRole('button', { name: /^add account$/i });
    const submitBtn = addButtons[addButtons.length - 1];
    await user.click(submitBtn);

    await waitFor(() => expect(createSocialAccount).toHaveBeenCalledOnce());
    const submittedPayload = createSocialAccount.mock.calls[0][0];

    expect(submittedPayload.platform).toBe('github');
    expect(submittedPayload.username).toBe('newuser');
    expect(submittedPayload.displayName).toBe('New User');
    expect(submittedPayload.bio).toBe('Coding samples');
    expect(submittedPayload.notes).toBe('Secret notes');
    expect(submittedPayload.ingestionEnabled).toBeUndefined();
    expect('ingestionEnabled' in submittedPayload).toBe(false);
  });

  it('omits ingestionEnabled on edit and does not render switch for legacy account', async () => {
    const user = userEvent.setup();
    render(<AccountsTab />);
    await screen.findByText('Social Accounts');

    // Click edit on the first account (which has legacy ingestionEnabled: true)
    const editButtons = screen.getAllByRole('button', { name: 'Edit' });
    await user.click(editButtons[0]);

    // Verify edit form header and absence of ingestion switch
    expect(screen.getByText('Edit Account')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/content ingestion/i)).not.toBeInTheDocument();

    // Update display name
    const displayNameInput = screen.getByPlaceholderText(/Optional display name/i);
    expect(displayNameInput).toHaveValue('The Octocat');
    await user.clear(displayNameInput);
    await user.type(displayNameInput, 'Updated Octocat');

    // Submit update
    const updateBtn = screen.getByRole('button', { name: /^update$/i });
    await user.click(updateBtn);

    await waitFor(() => expect(updateSocialAccount).toHaveBeenCalledOnce());
    const [id, submittedPayload] = updateSocialAccount.mock.calls[0];

    expect(id).toBe('acc-1');
    expect(submittedPayload.displayName).toBe('Updated Octocat');
    expect(submittedPayload.platform).toBe('github');
    expect(submittedPayload.username).toBe('octocat');
    expect(submittedPayload.ingestionEnabled).toBeUndefined();
    expect('ingestionEnabled' in submittedPayload).toBe(false);
  });

  it('renders updated empty state without content-learning claims', async () => {
    getSocialAccounts.mockResolvedValue({ accounts: [] });
    getSocialAccountStats.mockResolvedValue({ total: 0, ingestionEnabled: 0 });

    render(<AccountsTab />);
    expect(await screen.findByText('No social accounts yet')).toBeInTheDocument();
    expect(screen.getByText(/Add your social media accounts to build your digital identity profile and reference your profiles across platforms\./i)).toBeInTheDocument();
    expect(screen.queryByText(/content learning/i)).not.toBeInTheDocument();
  });

  it('fails into a retry instead of "No social accounts yet" when the account read fails', async () => {
    getSocialAccounts.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    render(<AccountsTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load social accounts');
    expect(screen.queryByText('No social accounts yet')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('@octocat')).toBeInTheDocument();
  });

  it('fails into a retry when the platform list read fails', async () => {
    getSocialAccountPlatforms.mockRejectedValueOnce(new Error('boom'));
    render(<AccountsTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load social platforms');
  });

  it('withholds "Add to org registry" while the link read is failed, so an already-linked account is not duplicated', async () => {
    getSocialAccountOrgLinks.mockRejectedValueOnce(new Error('privacy down'));
    const user = userEvent.setup();
    render(<AccountsTab />);

    expect(await screen.findByText('@octocat')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load org registry links');
    expect(screen.queryByRole('button', { name: /Add to org registry/ })).not.toBeInTheDocument();

    getSocialAccountOrgLinks.mockResolvedValueOnce([{ socialAccountId: 'acc-1', orgId: 'org-1', orgName: 'Example Org' }]);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('In org registry')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Add to org registry/ })).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the form open with the draft intact when creating an account fails', async () => {
    createSocialAccount.mockRejectedValueOnce(new Error('server down'));
    const user = userEvent.setup();
    render(<AccountsTab />);
    await screen.findByText('Social Accounts');

    await user.click(screen.getByRole('button', { name: /add account/i }));
    await user.click(screen.getByRole('button', { name: 'GitHub' }));
    await user.type(screen.getByPlaceholderText(/Your GitHub username/i), 'newuser');
    const addButtons = screen.getAllByRole('button', { name: /^add account$/i });
    await user.click(addButtons[addButtons.length - 1]);

    await waitFor(() => expect(createSocialAccount).toHaveBeenCalledOnce());
    expect(screen.getByPlaceholderText(/Your GitHub username/i)).toHaveValue('newuser');
    expect(getSocialAccountStats).toHaveBeenCalledTimes(1);
  });
});
