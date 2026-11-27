import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
    data: [
      { pid: 4242, agentName: 'agent', cpu: 1, memory: 2, command: 'node x' },
      { pid: 4243, agentName: 'agent', cpu: 1, memory: 2, command: 'node y' },
    ],
    loading: false, error: null, refetch: vi.fn(), updateData: mocks.updateData,
  }),
}));

const desktop = () => within(screen.getByRole('table', { name: 'Running AI agents' }));
const kill = 'Kill agent process 4242';
const confirm = 'Confirm kill agent process 4242';

async function confirmDesktopKill() {
  await userEvent.click(desktop().getByRole('button', { name: kill }));
  await userEvent.click(desktop().getByRole('button', { name: confirm }));
}

describe('AgentsPage kill feedback', () => {
  beforeEach(() => vi.resetAllMocks());

  it('labels Kill by PID and exposes cancellation and mobile disclosure state', async () => {
    mocks.killAgent.mockResolvedValue({ success: true });
    render(<AgentsPage />);

    expect(desktop().getByRole('button', { name: 'Kill agent process 4243' })).toBeEnabled();
    await userEvent.click(desktop().getByRole('button', { name: kill }));
    expect(mocks.killAgent).not.toHaveBeenCalled();
    await userEvent.click(desktop().getByRole('button', { name: 'Cancel' }));
    expect(mocks.killAgent).not.toHaveBeenCalled();

    const mobile = within(screen.getAllByRole('button', { name: kill })[0].parentElement.parentElement);
    const details = mobile.getByRole('button', { name: 'Show details' });
    expect(details).toHaveAttribute('type', 'button');
    expect(details).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(details);
    expect(mobile.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(mobile.getByRole('button', { name: kill }));
    expect(mocks.killAgent).not.toHaveBeenCalled();
    await userEvent.click(mobile.getByRole('button', { name: confirm }));
    expect(mocks.killAgent).toHaveBeenCalledExactlyOnceWith(4242, { silent: true });
  });

  it('toasts one clear error when the server reports success:false', async () => {
    mocks.killAgent.mockResolvedValue({ success: false, error: 'Permission denied' });
    render(<AgentsPage />);
    await confirmDesktopKill();
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Permission denied'));
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(mocks.killAgent).toHaveBeenCalledWith(4242, { silent: true });
    expect(mocks.updateData).not.toHaveBeenCalled();
  });

  it('toasts the rejection message when the request fails', async () => {
    mocks.killAgent.mockRejectedValue(new Error('Network down'));
    render(<AgentsPage />);
    await confirmDesktopKill();
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Network down'));
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
  });

  it('toasts success and removes the row', async () => {
    mocks.killAgent.mockResolvedValue({ success: true });
    render(<AgentsPage />);
    await confirmDesktopKill();
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Agent process stopped'));
    expect(mocks.updateData).toHaveBeenCalled();
  });
});
