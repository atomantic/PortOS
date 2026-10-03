import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ConfigTab from './ConfigTab';

const api = vi.hoisted(() => ({
  getGoogleAuthStatus: vi.fn(),
  clearGoogleAuth: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));

const account = { id: 'google-1', name: 'Example Calendar', enabled: true, type: 'google-calendar', syncMethod: 'google-api' };

beforeEach(() => {
  vi.resetAllMocks();
  api.getGoogleAuthStatus.mockResolvedValue({ hasCredentials: true, hasTokens: true });
});

const openAuth = async () => {
  render(<MemoryRouter><ConfigTab accounts={[account]} setAccounts={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Expand calendars for Example Calendar' }));
  await screen.findByText('Google API authenticated');
  return screen.getByRole('button', { name: 'Clear' });
};

describe('Google credential clearing', () => {
  it('blocks duplicate clears and confirms a bodyless success before refreshing auth', async () => {
    let resolve;
    api.clearGoogleAuth.mockImplementation(() => new Promise(done => { resolve = done; }));
    const button = await openAuth();
    api.getGoogleAuthStatus.mockResolvedValue({ hasCredentials: true, hasTokens: false });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(api.clearGoogleAuth).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.getGoogleAuthStatus).toHaveBeenCalledTimes(1);

    await act(async () => resolve(undefined));
    await screen.findByText('Credentials saved but not authorized yet.');
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Google auth cleared');
    expect(api.getGoogleAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('preserves authenticated status on rejection and releases Clear for retry', async () => {
    api.clearGoogleAuth.mockRejectedValueOnce(new Error('Synthetic clear failure')).mockResolvedValueOnce(undefined);
    const button = await openAuth();
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByText('Google API authenticated')).toBeTruthy();
    expect(api.getGoogleAuthStatus).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled(); // API request owns the error notice.

    fireEvent.click(button);
    await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith('Google auth cleared'));
    expect(api.clearGoogleAuth).toHaveBeenCalledTimes(2);
    expect(api.getGoogleAuthStatus).toHaveBeenCalledTimes(2);
  });
});
