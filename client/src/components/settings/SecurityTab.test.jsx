import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SecurityTab } from './SecurityTab';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  getAuthStatus: vi.fn(),
  setAuthPassword: vi.fn(),
  clearAuthPassword: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('SecurityTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the enabled password controls after a valid status response', async () => {
    api.getAuthStatus.mockResolvedValue({ enabled: true });

    render(<SecurityTab />);

    expect(await screen.findByText('Login password enabled')).toBeInTheDocument();
    expect(screen.getByText('Change password')).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable login' })).toBeInTheDocument();
    expect(screen.queryByText('Set a password')).not.toBeInTheDocument();
    expect(api.getAuthStatus).toHaveBeenCalledWith({ silent: true });
  });

  it('renders the disabled password controls after a valid status response', async () => {
    api.getAuthStatus.mockResolvedValue({ enabled: false });

    render(<SecurityTab />);

    expect(await screen.findByText('Login password disabled')).toBeInTheDocument();
    expect(screen.getByText('Set a password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable login' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
  });

  it('keeps both password flows hidden when the status request rejects', async () => {
    api.getAuthStatus.mockRejectedValue(new Error('Server unavailable'));

    render(<SecurityTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Authentication status unknown');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Login password disabled')).not.toBeInTheDocument();
    expect(screen.queryByText('Set a password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable login' })).not.toBeInTheDocument();
  });

  it('treats a malformed success payload as an unknown status', async () => {
    api.getAuthStatus.mockResolvedValue({ enabled: 'false' });

    render(<SecurityTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Authentication status unknown');
    expect(screen.queryByText('Login password disabled')).not.toBeInTheDocument();
    expect(screen.queryByText('Set a password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable login' })).not.toBeInTheDocument();
  });

  it('retries a failed status load and restores the matching controls', async () => {
    api.getAuthStatus
      .mockRejectedValueOnce(new Error('Server unavailable'))
      .mockResolvedValueOnce({ enabled: true });

    render(<SecurityTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Login password enabled')).toBeInTheDocument();
    expect(screen.getByText('Change password')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(api.getAuthStatus).toHaveBeenCalledTimes(2));
  });

  it('ignores an obsolete failure when a newer StrictMode request succeeds', async () => {
    const firstRequest = deferred();
    const secondRequest = deferred();
    api.getAuthStatus
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);

    render(
      <StrictMode>
        <SecurityTab />
      </StrictMode>,
    );

    await waitFor(() => expect(api.getAuthStatus).toHaveBeenCalledTimes(2));
    await act(async () => firstRequest.reject(new Error('Server unavailable')));
    await act(async () => secondRequest.resolve({ enabled: true }));

    expect(await screen.findByText('Login password enabled')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
