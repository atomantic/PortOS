import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentsPage } from './AgentsPage';

const mocks = vi.hoisted(() => ({
  killAgent: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  updateData: vi.fn(),
}));

vi.mock('../services/apiAgents.js', () => ({ getAgents: vi.fn(), killAgent: mocks.killAgent }));
vi.mock('../components/ui/Toast', () => ({ default: mocks.toast }));
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
vi.mock('../hooks/useSocketResource', () => ({
  useSocketResource: () => ({
    data: [{ pid: 4242, agentName: 'agent', cpu: 1, memory: 2, command: 'node x' }],
    loading: false, error: null, refetch: vi.fn(), updateData: mocks.updateData,
  }),
}));

describe('AgentsPage kill feedback', () => {
  beforeEach(() => vi.resetAllMocks());

  it('toasts one clear error when the server reports success:false', async () => {
    mocks.killAgent.mockResolvedValue({ success: false, error: 'Permission denied' });
    render(<AgentsPage />);
    await userEvent.click(screen.getAllByTitle('Kill process')[0]);
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Permission denied'));
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(mocks.killAgent).toHaveBeenCalledWith(4242, { silent: true });
    expect(mocks.updateData).not.toHaveBeenCalled();
  });

  it('toasts the rejection message when the request fails', async () => {
    mocks.killAgent.mockRejectedValue(new Error('Network down'));
    render(<AgentsPage />);
    await userEvent.click(screen.getAllByTitle('Kill process')[0]);
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Network down'));
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
  });

  it('toasts success and removes the row', async () => {
    mocks.killAgent.mockResolvedValue({ success: true });
    render(<AgentsPage />);
    await userEvent.click(screen.getAllByTitle('Kill process')[0]);
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Agent process stopped'));
    expect(mocks.updateData).toHaveBeenCalled();
  });
});
