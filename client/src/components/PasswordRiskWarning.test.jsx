import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router';
import PasswordRiskWarning from './PasswordRiskWarning.jsx';
import { getAuthStatus, getPasswordRiskStatus } from '../services/apiAuth.js';

vi.mock('../services/apiAuth.js', () => ({ getAuthStatus: vi.fn(), getPasswordRiskStatus: vi.fn() }));
const renderWarning = () => render(<MemoryRouter><PasswordRiskWarning /><Link to="/">Home</Link><Link to="/apps">Apps</Link></MemoryRouter>);
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  getAuthStatus.mockResolvedValue({ enabled: false });
  getPasswordRiskStatus.mockResolvedValue({ enabled: false, revision: 'initial' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('password risk warning', () => {
  it('requires explicit consent saved in this browser and survives remount', async () => {
    renderWarning();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('compromised machine');
    expect(dialog).toHaveTextContent('Cloudflare');
    const dismiss = screen.getByRole('button', { name: 'Accept risk and dismiss' });
    expect(dismiss).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(dialog.parentElement);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    const write = vi.spyOn(window.localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('storage blocked'); });
    fireEvent.click(dismiss);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be saved in this browser');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    write.mockRestore();
    fireEvent.click(dismiss);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    cleanup();
    renderWarning();
    await waitFor(() => expect(getPasswordRiskStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // A different browser has its own empty storage: another browser's consent
    // (or a server-side acknowledgement field) cannot suppress this warning.
    cleanup();
    localStorage.clear();
    getPasswordRiskStatus.mockResolvedValue({ enabled: false, revision: 'initial', acknowledgementRequired: false });
    renderWarning();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('invalidates an offline browser acknowledgement when the password revision changes', async () => {
    renderWarning();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Accept risk and dismiss' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    cleanup();
    getPasswordRiskStatus.mockResolvedValue({ enabled: false, revision: 'after-password-removal' });
    renderWarning();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('leaves password settings accessible but warns again if setup was abandoned', async () => {
    renderWarning();
    fireEvent.click(await screen.findByRole('link', { name: 'Set a PortOS password' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Home' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    getPasswordRiskStatus.mockResolvedValue({ enabled: true, revision: 'password-set' });
    fireEvent(window, new Event('portos:auth-changed'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not warn an instance with a password', async () => {
    getPasswordRiskStatus.mockResolvedValue({ enabled: true, revision: 'password-set' });
    renderWarning();
    await waitFor(() => expect(getPasswordRiskStatus).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uses public auth status when the risk endpoint is unavailable on a protected instance', async () => {
    getPasswordRiskStatus.mockRejectedValue(new Error('unavailable'));
    getAuthStatus.mockResolvedValue({ enabled: true });
    renderWarning();
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalledWith({ silent: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('persists check-error dismissal across focus, navigation and remount without accepting known risk', async () => {
    getPasswordRiskStatus.mockResolvedValue({ unexpected: true });
    renderWarning();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss and don’t show again' }));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('link', { name: 'Apps' }));
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    cleanup();
    renderWarning();
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    getPasswordRiskStatus.mockResolvedValue({ enabled: false, revision: 'initial' });
    fireEvent(window, new Event('portos:auth-changed'));
    expect(await screen.findByRole('checkbox')).toBeInTheDocument();
  });

  it('shows a recoverable status error without offering risk acceptance on an unknown status', async () => {
    getPasswordRiskStatus.mockRejectedValueOnce(new Error('offline'));
    renderWarning();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not confirm');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('checkbox')).toBeInTheDocument();
  });
});
