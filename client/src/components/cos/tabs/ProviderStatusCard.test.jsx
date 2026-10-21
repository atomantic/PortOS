import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../../services/api';
import socket from '../../../services/socket';
import ProviderStatusCard from './ProviderStatusCard';

vi.mock('../../../services/api', () => ({
  getProviderStatuses: vi.fn(),
  getProviders: vi.fn(),
  recoverProvider: vi.fn(),
}));

vi.mock('../../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

describe('ProviderStatusCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getProviders.mockResolvedValue({ providers: [{ id: 'example', name: 'Example Provider' }] });
  });

  it('shows normalized API-window counts without raw header data', async () => {
    api.getProviderStatuses.mockResolvedValue({
      providers: {
        example: {
          available: false,
          reason: 'rate-limit',
          message: 'Rate limit exceeded - temporary',
          timeUntilRecovery: '1m',
          rateLimitWindow: {
            observedAt: '2026-08-26T12:00:00.000Z',
            remaining: 0,
            limit: 100,
          },
        },
      },
    });

    render(<ProviderStatusCard />);

    await waitFor(() => expect(screen.getByTestId('rate-limit-window-example')).toHaveTextContent('0 remaining of 100'));
    expect(screen.queryByText(/retry-after/i)).not.toBeInTheDocument();
    expect(socket.on).toHaveBeenCalledWith('provider:status:changed', expect.any(Function));
  });

  it('labels a limit-only window without a dangling separator', async () => {
    api.getProviderStatuses.mockResolvedValue({
      providers: {
        example: {
          available: false,
          reason: 'rate-limit',
          message: 'Rate limited',
          rateLimitWindow: { observedAt: '2026-08-26T12:00:00.000Z', limit: 100 },
        },
      },
    });

    render(<ProviderStatusCard />);

    await waitFor(() => expect(screen.getByTestId('rate-limit-window-example')).toHaveTextContent('API window: limit 100'));
  });

  it('fails into Retry instead of "All Available" when the provider list read fails', async () => {
    api.getProviderStatuses.mockResolvedValue({
      providers: { example: { available: false, reason: 'rate-limit', message: 'Rate limit exceeded' } },
    });
    api.getProviders.mockRejectedValueOnce(new Error('providers 500'));

    render(<ProviderStatusCard />);

    expect(await screen.findByText('Unable to load status')).toBeInTheDocument();
    expect(screen.queryByText('All Available')).not.toBeInTheDocument();

    api.getProviders.mockResolvedValue({ providers: [{ id: 'example', name: 'Example Provider' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading status' }));
    await waitFor(() => expect(screen.queryByText('Unable to load status')).not.toBeInTheDocument());
    expect(screen.getByText('Example Provider')).toBeInTheDocument();
  });
});
