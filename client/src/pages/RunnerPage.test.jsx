import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getApps: vi.fn(),
  getProviders: vi.fn().mockResolvedValue({ providers: [], activeProvider: null }),
  getAllowedCommands: vi.fn(),
  createRun: vi.fn(),
  stopRun: vi.fn(),
  executeCommand: vi.fn(),
  stopCommand: vi.fn(),
}));

vi.mock('../services/api', () => api);
vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('../hooks/useSocketSubscription', () => ({
  useSocketSubscription: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { RunnerPage } from './RunnerPage';

describe('RunnerPage list resources (#12171)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
  });

  it('shows error row with Retry when workspaces fail to load, and recovers on retry', async () => {
    api.getApps.mockRejectedValueOnce(new Error('apps offline'));
    api.getAllowedCommands.mockResolvedValue(['git status']);

    render(
      <MemoryRouter>
        <RunnerPage />
      </MemoryRouter>
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load workspaces — apps offline');

    api.getApps.mockResolvedValueOnce([{ id: 'app-1', name: 'My App', repoPath: '/test' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    const select = await screen.findByLabelText('Workspace');
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'My App' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows empty option when workspaces list is empty', async () => {
    api.getApps.mockResolvedValue([]);
    api.getAllowedCommands.mockResolvedValue(['git status']);

    render(
      <MemoryRouter>
        <RunnerPage />
      </MemoryRouter>
    );

    const select = await screen.findByLabelText('Workspace');
    expect(within(select).getByRole('option', { name: 'No workspaces found' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows error row with Retry when allowed commands fail to load, and recovers on retry', async () => {
    api.getApps.mockResolvedValue([{ id: 'app-1', name: 'My App', repoPath: '/test' }]);
    api.getAllowedCommands.mockRejectedValueOnce(new Error('commands offline'));

    render(
      <MemoryRouter>
        <RunnerPage />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Shell Command' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load allowed commands — commands offline');

    api.getAllowedCommands.mockResolvedValueOnce(['npm test', 'git status']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Allowed: npm test, git status/)).toBeInTheDocument();
  });

  it('shows empty copy when allowed commands list is empty', async () => {
    api.getApps.mockResolvedValue([{ id: 'app-1', name: 'My App', repoPath: '/test' }]);
    api.getAllowedCommands.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <RunnerPage />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Shell Command' }));

    expect(await screen.findByText('No allowed commands configured')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
