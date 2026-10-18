import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getApps: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock('../services/api', () => api);
vi.mock('../components/apps/tabs/ProcessesTab', () => ({
  default: () => <div data-testid="processes-tab">Processes Tab</div>,
}));
vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import { ProcessesPage } from './ProcessesPage';

describe('ProcessesPage list resources (#12171)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows error row with Retry when managed apps fail to load, and recovers on retry', async () => {
    api.getApps.mockRejectedValueOnce(new Error('pm2 offline'));

    render(<ProcessesPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load managed apps — pm2 offline');

    api.getApps.mockResolvedValueOnce([{ id: 'app-1', name: 'App 1', pm2ProcessNames: ['portos-app-1'] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('processes-tab')).toBeInTheDocument();
  });

  it('shows empty copy when managed apps list is empty', async () => {
    api.getApps.mockResolvedValue([]);

    render(<ProcessesPage />);

    expect(await screen.findByText('No managed apps configured.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('processes-tab')).toBeInTheDocument();
  });
});
