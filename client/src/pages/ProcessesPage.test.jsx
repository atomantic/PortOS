import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getApps: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock('../services/apiApps.js', () => ({ getApps: api.getApps }));
vi.mock('../services/apiCommands.js', () => ({ executeCommand: api.executeCommand }));
vi.mock('../components/apps/tabs/ProcessesTab', () => ({
  default: () => <div data-testid="processes-tab">Processes Tab</div>,
}));
vi.mock('../components/ui/Toast');
vi.mock('./AgentsPage', () => ({
  default: () => <p>Running AI agents</p>,
}));

import { ProcessesPage } from './ProcessesPage';

describe('ProcessesPage list resources (#12171)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows error row with Retry when managed apps fail to load, and recovers on retry', async () => {
    api.getApps.mockRejectedValueOnce(new Error('pm2 offline'));

    render(<MemoryRouter initialEntries={['/devtools/processes']}><ProcessesPage /></MemoryRouter>);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load managed apps — pm2 offline');

    api.getApps.mockResolvedValueOnce([{ id: 'app-1', name: 'App 1', pm2ProcessNames: ['portos-app-1'] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('processes-tab')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Processes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PM2 Save/ })).toBeInTheDocument();
  });

  it('opens the agent tab without loading PM2 and switches back to the PM2 view', async () => {
    api.getApps.mockResolvedValue([]);
    render(<MemoryRouter initialEntries={['/devtools/processes/agents']}><ProcessesPage /></MemoryRouter>);

    expect(screen.getByRole('tab', { name: 'AI Agents', selected: true })).toBeInTheDocument();
    expect(screen.getByText('Running AI agents')).toBeInTheDocument();
    expect(api.getApps).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'PM2' }));
    expect(await screen.findByText('No managed apps configured.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'PM2', selected: true })).toBeInTheDocument();
  });

  it('shows empty copy when managed apps list is empty', async () => {
    api.getApps.mockResolvedValue([]);

    render(<MemoryRouter initialEntries={['/devtools/processes']}><ProcessesPage /></MemoryRouter>);

    expect(await screen.findByText('No managed apps configured.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('processes-tab')).toBeInTheDocument();
  });
});
