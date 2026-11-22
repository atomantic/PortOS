import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getWebsiteLogins: vi.fn(),
  createWebsiteLogin: vi.fn(),
  updateWebsiteLogin: vi.fn(),
  deleteWebsiteLogin: vi.fn(),
}));
vi.mock('../../services/apiPrivacy.js', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import WebsiteLoginsSection from './WebsiteLoginsSection';

const LOGIN = {
  id: 'login-1', label: 'Distributor portal', origins: ['https://example.com', 'https://id.example.com'],
  maskedUsername: 'a•••@example.com', hasTotp: true, notes: '',
};

const openDrawerForm = async () => {
  const dialog = await screen.findByRole('dialog');
  return within(dialog);
};

describe('WebsiteLoginsSection (#17397)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getWebsiteLogins.mockResolvedValue([LOGIN]);
  });

  it('lists metadata only: label, masked username, exact origins and the 2FA badge', async () => {
    render(<WebsiteLoginsSection subjectId="subject-a" />);
    expect(await screen.findByText('Distributor portal')).toBeTruthy();
    expect(screen.getByText('a•••@example.com')).toBeTruthy();
    expect(screen.getByText('https://id.example.com')).toBeTruthy();
    expect(screen.getByText('2FA Auto')).toBeTruthy();
    expect(api.getWebsiteLogins).toHaveBeenCalledWith({ subjectId: 'subject-a', silent: true });
  });

  it('creates a login from one-origin-per-line input under the active subject', async () => {
    api.getWebsiteLogins.mockResolvedValue([]);
    api.createWebsiteLogin.mockResolvedValue({ ...LOGIN, id: 'login-2', label: 'New portal', hasTotp: false });
    render(<WebsiteLoginsSection subjectId="subject-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /new login/i }));
    const form = await openDrawerForm();
    fireEvent.change(form.getByLabelText('Label'), { target: { value: 'New portal' } });
    fireEvent.change(form.getByLabelText('Allowed origins'), { target: { value: 'https://example.com\n https://id.example.com ' } });
    fireEvent.change(form.getByLabelText('Username or email'), { target: { value: 'alice@example.com' } });
    fireEvent.change(form.getByLabelText('Password'), { target: { value: 'pw-client-test-1' } });
    fireEvent.click(form.getByRole('button', { name: 'Save login' }));
    await waitFor(() => expect(api.createWebsiteLogin).toHaveBeenCalled());
    expect(api.createWebsiteLogin.mock.calls[0][0]).toEqual({
      label: 'New portal', origins: ['https://example.com', 'https://id.example.com'], notes: '',
      username: 'alice@example.com', password: 'pw-client-test-1', subjectId: 'subject-a',
    });
    expect(await screen.findByText('New portal')).toBeTruthy();
  });

  it('keeps New login disabled until the list has loaded', async () => {
    let finish;
    api.getWebsiteLogins.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<WebsiteLoginsSection subjectId="subject-a" />);
    expect(screen.getByRole('button', { name: /new login/i })).toBeDisabled();
    finish([LOGIN]);
    await waitFor(() => expect(screen.getByRole('button', { name: /new login/i })).toBeEnabled());
  });

  it('refetches after a create when the list had failed to load', async () => {
    api.getWebsiteLogins.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([LOGIN, { ...LOGIN, id: 'login-2', label: 'Second portal', hasTotp: false }]);
    api.createWebsiteLogin.mockResolvedValue({ ...LOGIN, id: 'login-2', label: 'Second portal' });
    render(<WebsiteLoginsSection subjectId="subject-a" />);
    expect(await screen.findByText('Website logins could not be loaded.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /new login/i }));
    const form = await openDrawerForm();
    fireEvent.change(form.getByLabelText('Label'), { target: { value: 'Second portal' } });
    // A comma inside a pasted URL stays one origin.
    fireEvent.change(form.getByLabelText('Allowed origins'), { target: { value: 'https://example.com/?ids=1,2' } });
    fireEvent.change(form.getByLabelText('Username or email'), { target: { value: 'alice@example.com' } });
    fireEvent.change(form.getByLabelText('Password'), { target: { value: 'pw-client-test-2' } });
    fireEvent.click(form.getByRole('button', { name: 'Save login' }));
    await waitFor(() => expect(api.createWebsiteLogin).toHaveBeenCalled());
    expect(api.createWebsiteLogin.mock.calls[0][0].origins).toEqual(['https://example.com/?ids=1,2']);
    expect(await screen.findByText('Distributor portal')).toBeTruthy();
    expect(screen.getByText('Second portal')).toBeTruthy();
    expect(api.getWebsiteLogins).toHaveBeenCalledTimes(2);
  });

  it('edits without resending blank secrets and can remove the 2FA key', async () => {
    api.updateWebsiteLogin.mockResolvedValue({ ...LOGIN, hasTotp: false });
    render(<WebsiteLoginsSection subjectId="subject-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Distributor portal' }));
    const form = await openDrawerForm();
    expect(form.getByLabelText('Username or email').value).toBe('');
    expect(form.getByLabelText('Password').value).toBe('');
    fireEvent.click(form.getByLabelText('Remove the saved 2FA setup key'));
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateWebsiteLogin).toHaveBeenCalled());
    // Untouched notes and blank secrets are not resent.
    expect(api.updateWebsiteLogin.mock.calls[0].slice(0, 2)).toEqual(['login-1', {
      label: 'Distributor portal', origins: ['https://example.com', 'https://id.example.com'], totpSecret: null,
    }]);
    await waitFor(() => expect(screen.queryByText('2FA Auto')).toBeNull());
  });

  it('deletes once, only after the inline confirmation, even when confirmed twice', async () => {
    let settle;
    api.deleteWebsiteLogin.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    render(<WebsiteLoginsSection subjectId="subject-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Distributor portal' }));
    expect(api.deleteWebsiteLogin).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: /^delete$/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(api.deleteWebsiteLogin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Delete Distributor portal' })).toBeDisabled();
    settle({ ok: true });
    await waitFor(() => expect(screen.queryByText('Distributor portal')).toBeNull());
    expect(api.deleteWebsiteLogin).toHaveBeenCalledTimes(1);
  });

  it('sends changed notes on edit', async () => {
    api.updateWebsiteLogin.mockResolvedValue({ ...LOGIN, notes: 'Use the EU region' });
    render(<WebsiteLoginsSection subjectId="subject-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Distributor portal' }));
    const form = await openDrawerForm();
    fireEvent.change(form.getByLabelText('Notes'), { target: { value: 'Use the EU region' } });
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateWebsiteLogin).toHaveBeenCalled());
    expect(api.updateWebsiteLogin.mock.calls[0][1]).toMatchObject({ notes: 'Use the EU region' });
  });
});
