import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router';
import PasswordRiskWarning from './PasswordRiskWarning.jsx';
import { acknowledgePasswordRisk, getPasswordRiskStatus } from '../services/apiAuth.js';

vi.mock('../services/apiAuth.js', () => ({ getPasswordRiskStatus: vi.fn(), acknowledgePasswordRisk: vi.fn() }));
const renderWarning = () => render(<MemoryRouter><PasswordRiskWarning /><Link to="/">Home</Link></MemoryRouter>);
beforeEach(() => {
  vi.resetAllMocks();
  getPasswordRiskStatus.mockResolvedValue({ enabled: false, acknowledgementRequired: true });
  acknowledgePasswordRisk.mockResolvedValue({ enabled: false, acknowledgementRequired: false });
});
afterEach(cleanup);

describe('password risk warning', () => {
  it('explains host-control risk and requires explicit, successfully saved acceptance', async () => {
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
    acknowledgePasswordRisk.mockRejectedValueOnce(new Error('write failed'));
    fireEvent.click(dismiss);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(dismiss);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(acknowledgePasswordRisk).toHaveBeenCalledWith({ silent: true });
  });

  it('leaves password settings accessible but warns again if setup was abandoned', async () => {
    renderWarning();
    fireEvent.click(await screen.findByRole('link', { name: 'Set a PortOS password' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(acknowledgePasswordRisk).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { name: 'Home' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    getPasswordRiskStatus.mockResolvedValue({ enabled: true, acknowledgementRequired: false });
    fireEvent(window, new Event('portos:auth-changed'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it.each([{ enabled: true, acknowledgementRequired: false }, { enabled: false, acknowledgementRequired: false }])('respects the saved instance status %j', async (value) => {
    getPasswordRiskStatus.mockResolvedValue(value);
    renderWarning();
    await waitFor(() => expect(getPasswordRiskStatus).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
