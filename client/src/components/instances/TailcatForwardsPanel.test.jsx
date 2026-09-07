import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  getTailcatForwards: vi.fn(),
  retryTailcatForward: vi.fn(),
  forgetTailcatForward: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import { getTailcatForwards, retryTailcatForward, forgetTailcatForward } from '../../services/api';
import TailcatForwardsPanel from './TailcatForwardsPanel';

const failedForward = {
  id: 'fwd_1',
  peerId: null,
  // Only ever the redacted form reaches the client.
  tcAddress: 'tcEX…wxyz',
  localPort: null,
  remotePort: 5555,
  name: 'sandbox',
  protocol: 'http',
  hasAuth: false,
  status: 'failed',
  lastError: 'tailcat listener startup timed out — tailcat said: fetching DERPMap: context deadline exceeded',
  lastErrorAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  live: false,
};

describe('TailcatForwardsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTailcatForwards.mockResolvedValue({ forwards: [failedForward] });
  });

  it('renders nothing when the install has no saved forwards', async () => {
    getTailcatForwards.mockResolvedValue({ forwards: [] });
    const { container } = render(<TailcatForwardsPanel />);
    await waitFor(() => expect(getTailcatForwards).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('surfaces what tailcat actually said, which is the whole point of saving the forward', async () => {
    render(<TailcatForwardsPanel />);
    expect(await screen.findByText(/context deadline exceeded/)).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    // No port bound yet, because the original add never got that far.
    expect(screen.getByText(/no port yet/)).toBeInTheDocument();
  });

  it('does not report a forward as running when its tunnel cannot deliver', async () => {
    // Exactly the shape of the operator symptom: the listener is bound and
    // tracked, so status/live both read healthy, but every request is reset.
    getTailcatForwards.mockResolvedValue({ forwards: [{
      ...failedForward,
      status: 'active',
      localPort: 15555,
      live: true,
      lastError: null,
      lastErrorAt: null,
      tunnelError: 'dial remote port 5555: context deadline exceeded',
      tunnelErrorAt: '2026-01-02T00:00:00.000Z',
    }] });
    render(<TailcatForwardsPanel />);
    expect(await screen.findByText('no route')).toBeInTheDocument();
    expect(screen.queryByText('running')).not.toBeInTheDocument();
    expect(screen.getByText(/dial remote port 5555/)).toBeInTheDocument();
  });

  it('retries from the stored address and re-reads the server-derived status', async () => {
    retryTailcatForward.mockResolvedValue({ id: 'peer-9', port: 15555 });
    getTailcatForwards.mockResolvedValueOnce({ forwards: [failedForward] })
      .mockResolvedValue({ forwards: [{ ...failedForward, status: 'active', localPort: 15555, live: true, lastError: null }] });
    const onChange = vi.fn();
    render(<TailcatForwardsPanel onChange={onChange} />);

    await userEvent.click(await screen.findByRole('button', { name: /Retry/ }));

    expect(retryTailcatForward).toHaveBeenCalledWith('fwd_1');
    expect(await screen.findByText('running')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalled();
  });

  it('keeps the row when a retry fails, so the reason stays on screen', async () => {
    retryTailcatForward.mockRejectedValue(new Error('still broken'));
    const onChange = vi.fn();
    render(<TailcatForwardsPanel onChange={onChange} />);

    await userEvent.click(await screen.findByRole('button', { name: /Retry/ }));

    await waitFor(() => expect(getTailcatForwards).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/context deadline exceeded/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drops a forgotten forward from the list without refetching', async () => {
    forgetTailcatForward.mockResolvedValue({ id: 'fwd_1', peerId: null });
    render(<TailcatForwardsPanel />);

    await userEvent.click(await screen.findByRole('button', { name: /Forget/ }));

    await waitFor(() => expect(screen.queryByText('sandbox')).not.toBeInTheDocument());
    expect(getTailcatForwards).toHaveBeenCalledTimes(1);
  });
});
