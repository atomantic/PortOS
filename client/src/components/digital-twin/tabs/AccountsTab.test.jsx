import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  getSocialAccounts: vi.fn(),
  getSocialAccountPlatforms: vi.fn(),
  getSocialAccountStats: vi.fn(),
  getSocialAccountOrgLinks: vi.fn(),
  createSocialAccount: vi.fn(),
  updateSocialAccount: vi.fn(),
  deleteSocialAccount: vi.fn(),
  createPrivacyOrg: vi.fn()
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}));

import AccountsTab from './AccountsTab';
import * as api from '../../../services/api';

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
  api.getSocialAccounts.mockResolvedValue(MOCK_ACCOUNTS);
  api.getSocialAccountPlatforms.mockResolvedValue(MOCK_PLATFORMS);
  api.getSocialAccountStats.mockResolvedValue(MOCK_STATS);
  api.getSocialAccountOrgLinks.mockResolvedValue([]);
  api.createSocialAccount.mockResolvedValue({ id: 'acc-3', platform: 'github', username: 'newuser' });
  api.updateSocialAccount.mockResolvedValue({ id: 'acc-1', platform: 'github', username: 'octocat' });
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

    await waitFor(() => expect(api.createSocialAccount).toHaveBeenCalledOnce());
    const submittedPayload = api.createSocialAccount.mock.calls[0][0];

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

    await waitFor(() => expect(api.updateSocialAccount).toHaveBeenCalledOnce());
    const [id, submittedPayload] = api.updateSocialAccount.mock.calls[0];

    expect(id).toBe('acc-1');
    expect(submittedPayload.displayName).toBe('Updated Octocat');
    expect(submittedPayload.platform).toBe('github');
    expect(submittedPayload.username).toBe('octocat');
    expect(submittedPayload.ingestionEnabled).toBeUndefined();
    expect('ingestionEnabled' in submittedPayload).toBe(false);
  });

  it('renders updated empty state without content-learning claims', async () => {
    api.getSocialAccounts.mockResolvedValue({ accounts: [] });
    api.getSocialAccountStats.mockResolvedValue({ total: 0, ingestionEnabled: 0 });

    render(<AccountsTab />);
    expect(await screen.findByText('No social accounts yet')).toBeInTheDocument();
    expect(screen.getByText(/Add your social media accounts to build your digital identity profile and reference your profiles across platforms\./i)).toBeInTheDocument();
    expect(screen.queryByText(/content learning/i)).not.toBeInTheDocument();
  });
});
