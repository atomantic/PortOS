import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  PORTOS_APP_ID: 'portos-default',
  getAppSpriteBindings: vi.fn(() => Promise.resolve({ bindings: [] })),
  deleteApp: vi.fn(() => Promise.resolve(null)),
  archiveApp: vi.fn(() => Promise.resolve({})),
  unarchiveApp: vi.fn(() => Promise.resolve({})),
  openAppInEditor: vi.fn(() => Promise.resolve({})),
  openAppFolder: vi.fn(() => Promise.resolve({})),
  refreshAppConfig: vi.fn(() => Promise.resolve({})),
  detectAppIcon: vi.fn(() => Promise.resolve({ detected: false })),
  installXcodeScripts: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../../hooks/useAppOperation', () => ({
  useAppOperation: vi.fn(() => ({
    steps: [],
    isOperating: false,
    operationType: null,
    error: null,
    completed: false,
    startUpdate: vi.fn(),
    startStandardize: vi.fn(),
  })),
}));

vi.mock('../ActivityLog', () => ({ default: () => null }));
vi.mock('../SlashDoPanel', () => ({ default: () => null }));
vi.mock('../../ui/Banner', () => ({ default: () => null }));
vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import OverviewTab from './OverviewTab';

const APP = {
  id: 'app-1',
  name: 'Example App',
  type: 'static',
  repoPath: '/mock/example-app',
};

function renderOverview(app = APP) {
  return render(
    <MemoryRouter>
      <OverviewTab app={app} onRefresh={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('OverviewTab PortOS registration removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.deleteApp.mockResolvedValue(null);
    api.getAppSpriteBindings.mockResolvedValue({ bindings: [] });
  });

  it('explains that removal keeps the repository and requires confirmation', async () => {
    const user = userEvent.setup();
    renderOverview();

    expect(screen.getByRole('button', { name: 'Remove from PortOS' })).toBeTruthy();
    expect(screen.getByText(/without deleting its repository from disk/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove from PortOS' }));

    expect(screen.getByText('Remove Example App from PortOS? Its repository will stay on disk.')).toBeTruthy();
    expect(api.deleteApp).not.toHaveBeenCalled();
  });

  it('removes the association and returns to the app registry after confirmation', async () => {
    const user = userEvent.setup();
    renderOverview();

    await user.click(screen.getByRole('button', { name: 'Remove from PortOS' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.deleteApp).toHaveBeenCalledWith('app-1'));
    expect(toast.success).toHaveBeenCalledWith('Example App removed from PortOS — files kept on disk');
  });

  it('does not offer removal for the PortOS baseline app', async () => {
    renderOverview({ ...APP, id: 'portos-default', name: 'PortOS' });

    expect(screen.queryByRole('button', { name: 'Remove from PortOS' })).toBeNull();
    await waitFor(() => expect(api.getAppSpriteBindings).toHaveBeenCalledWith('portos-default'));
  });
});
