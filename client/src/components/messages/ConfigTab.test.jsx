import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  deleteMessageAccount: vi.fn(),
  getGoogleAuthStatus: vi.fn(),
  getGoogleAuthUrl: vi.fn(),
  getSettings: vi.fn(),
  runGoogleAutoConfig: vi.fn(),
  saveGoogleAuthCredentials: vi.fn(),
  startGoogleAutoConfig: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), {
  error: vi.fn(),
  success: vi.fn(),
}));
const providerModels = vi.hoisted(() => ({
  availableModels: [],
  loading: false,
  providers: [],
  selectedModel: '',
  selectedProviderId: '',
  setSelectedModel: vi.fn(),
  setSelectedProviderId: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => providerModels }));

const ConfigTab = (await import('./ConfigTab')).default;

const gmailAccount = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Personal',
  type: 'gmail',
  email: 'owner@example.com',
  enabled: true,
  syncConfig: { ingestSent: true },
};

function renderConfig(setAccounts = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={['/messages/config']}>
      <ConfigTab accounts={[gmailAccount]} setAccounts={setAccounts} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue({ messages: {} });
  api.getGoogleAuthUrl.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/auth?state=messages' });
  api.saveGoogleAuthCredentials.mockResolvedValue({ clientId: 'client-id' });
  vi.spyOn(window, 'open').mockImplementation(() => null);
});

describe('Messages Gmail OAuth setup', () => {
  it('accepts OAuth credentials in Messages and starts authorization there', async () => {
    api.getGoogleAuthStatus.mockResolvedValue({
      hasCredentials: false,
      hasTokens: false,
      needsScopeUpgrade: true,
    });
    renderConfig();

    expect(await screen.findByText('Google OAuth setup required')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Manual setup (paste credentials)'));
    fireEvent.change(screen.getByLabelText('Google OAuth Client ID'), { target: { value: 'client-id' } });
    fireEvent.change(screen.getByLabelText('Google OAuth Client Secret'), { target: { value: 'client-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Authorize' }));

    await waitFor(() => expect(api.saveGoogleAuthCredentials).toHaveBeenCalledWith(
      { clientId: 'client-id', clientSecret: 'client-secret' },
      { silent: true },
    ));
    await waitFor(() => expect(api.getGoogleAuthUrl).toHaveBeenCalledWith({ returnTo: 'messages', silent: true }));
    expect(window.open).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/auth?state=messages',
      '_blank',
    );
  });

  it('shows an enabled Gmail account as pending until Gmail OAuth is authorized', async () => {
    api.getGoogleAuthStatus.mockResolvedValue({
      hasCredentials: true,
      hasTokens: false,
      needsScopeUpgrade: true,
    });
    renderConfig();

    expect(await screen.findByText('Google OAuth authorization pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pending authorization' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enabled' })).not.toBeInTheDocument();
  });

  it('keeps the account pending when existing Google tokens lack the Gmail scope', async () => {
    api.getGoogleAuthStatus.mockResolvedValue({
      hasCredentials: true,
      hasTokens: true,
      needsScopeUpgrade: true,
    });
    renderConfig();

    expect(await screen.findByText('Google OAuth needs Gmail permission')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pending authorization' })).toBeInTheDocument();
  });
});


describe('Messages account deletion', () => {
  it('retains the account without a success toast on cleanup failure, then allows retry', async () => {
    api.getGoogleAuthStatus.mockResolvedValue({ hasCredentials: true, hasTokens: true });
    api.deleteMessageAccount.mockRejectedValueOnce(new Error('Cleanup failed')).mockResolvedValueOnce(undefined);
    const setAccounts = vi.fn();
    renderConfig(setAccounts);
    await screen.findByRole('button', { name: 'Enabled' });

    fireEvent.click(screen.getByTitle('Delete account'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteMessageAccount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTitle('Delete account')).not.toBeDisabled());
    expect(setAccounts).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText('Personal')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Delete account'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Account deleted'));
    expect(setAccounts.mock.calls[0][0]([gmailAccount])).toEqual([]);
  });
});
