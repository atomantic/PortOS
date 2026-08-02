import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const APPS = [
  {
    id: 'app-alpha',
    name: 'Example App',
    type: 'node',
    icon: 'package',
    repoPath: '/srv/example-app',
    overallStatus: 'online',
    pm2ProcessNames: ['example-server'],
    processes: [{ name: 'example-server', ports: { http: 4000 } }],
  },
];

vi.mock('../services/api', () => ({
  PORTOS_APP_ID: 'portos-default',
  getApps: vi.fn(() => Promise.resolve(APPS)),
  deleteApp: vi.fn(() => Promise.resolve({})),
  archiveApp: vi.fn(() => Promise.resolve({})),
  unarchiveApp: vi.fn(() => Promise.resolve({})),
  startApp: vi.fn(() => Promise.resolve({})),
  stopApp: vi.fn(() => Promise.resolve({})),
  restartApp: vi.fn(() => Promise.resolve({})),
  launchNativeApp: vi.fn(() => Promise.resolve({})),
  buildApp: vi.fn(() => Promise.resolve({})),
  refreshAppConfig: vi.fn(() => Promise.resolve({})),
  getMySprintTickets: vi.fn(() => Promise.resolve([])),
  openAppInEditor: vi.fn(() => Promise.resolve({})),
  openAppFolder: vi.fn(() => Promise.resolve({})),
  handleSelfRestart: vi.fn(),
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

import * as api from '../services/api';
import Apps from './Apps';

const renderApps = async () => {
  render(<MemoryRouter><Apps /></MemoryRouter>);
  await screen.findByRole('link', { name: 'Example App' });
};

const openRowMenu = async (user) => {
  await user.click(screen.getByRole('button', { name: 'More actions for Example App' }));
};

describe('Apps row action hierarchy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue(APPS);
  });

  it('keeps Archive and Delete out of the resting row, leaving Manage as the visible action', async () => {
    await renderApps();

    expect(screen.getByRole('link', { name: 'Manage Example App' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop Example App' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Archive$/ })).toBeNull();
  });

  it('renders the app name as a link to its detail route', async () => {
    await renderApps();

    const nameLink = screen.getByRole('link', { name: 'Example App' });
    expect(nameLink.getAttribute('href')).toBe('/apps/app-alpha');
    // Underlined so the name reads as a link, not plain text.
    expect(nameLink.className).toContain('underline');
  });

  it('exposes Archive and Delete only through the overflow menu', async () => {
    const user = userEvent.setup();
    await renderApps();

    await openRowMenu(user);
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  it('requires an inline confirm before deleting, and cancelling leaves the app alone', async () => {
    const user = userEvent.setup();
    await renderApps();

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(api.deleteApp).not.toHaveBeenCalled();
    const confirm = screen.getByLabelText('Confirm deletion of Example App');
    expect(confirm.textContent).toContain('cannot be undone');

    // Focus follows the revealed confirmation instead of being stranded on the
    // "…" trigger whose menu just closed.
    expect(document.activeElement).toBe(confirm);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.deleteApp).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Confirm deletion of Example App')).toBeNull();
    // Dismissing hands focus back to the trigger it came from, not to <body>.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More actions for Example App' }));
  });

  it('deletes only after the inline confirm is accepted', async () => {
    const user = userEvent.setup();
    await renderApps();

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.deleteApp).toHaveBeenCalledWith('app-alpha'));
  });

  it('archives from the overflow menu', async () => {
    const user = userEvent.setup();
    await renderApps();

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));

    await waitFor(() => expect(api.archiveApp).toHaveBeenCalledWith('app-alpha'));
  });

  it('withholds the overflow menu for the PortOS baseline app', async () => {
    api.getApps.mockResolvedValue([{ ...APPS[0], id: 'portos-default', name: 'PortOS' }]);
    render(<MemoryRouter><Apps /></MemoryRouter>);
    await screen.findByRole('link', { name: 'Manage PortOS' });

    expect(screen.queryByRole('button', { name: /More actions/ })).toBeNull();
  });
});
