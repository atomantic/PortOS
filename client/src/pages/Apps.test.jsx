import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

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
  openAppInXcode: vi.fn(() => Promise.resolve({ success: true, path: '/srv/example-ios/ExampleIos.xcodeproj' })),
  handleSelfRestart: vi.fn(),
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

import * as api from '../services/api';
import socket from '../services/socket';
import Apps from './Apps';

const ARCHIVED_APP = { ...APPS[0], archived: true };

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

  it('asks the server to resolve and open the Xcode project instead of guessing the filename', async () => {
    // Display name deliberately differs from the on-disk project name — the old
    // client-side `<name>.xcodeproj` guess was a silent no-op for exactly this app.
    api.getApps.mockResolvedValue([{
      ...APPS[0],
      id: 'app-ios',
      name: 'Example iOS App',
      type: 'ios-native',
      repoPath: '/srv/example-ios',
      pm2ProcessNames: [],
      processes: [],
    }]);
    const user = userEvent.setup();
    render(<MemoryRouter><Apps /></MemoryRouter>);
    await screen.findByRole('link', { name: 'Example iOS App' });

    await user.click(screen.getByRole('button', { name: 'Expand Example iOS App details' }));
    await user.click(screen.getByRole('button', { name: 'Open Example iOS App in Xcode' }));

    await waitFor(() => expect(api.openAppInXcode).toHaveBeenCalledWith('app-ios'));
  });

  it('withholds the overflow menu for the PortOS baseline app', async () => {
    api.getApps.mockResolvedValue([{ ...APPS[0], id: 'portos-default', name: 'PortOS' }]);
    render(<MemoryRouter><Apps /></MemoryRouter>);
    await screen.findByRole('link', { name: 'Manage PortOS' });

    expect(screen.queryByRole('button', { name: /More actions/ })).toBeNull();
  });
});

describe('Apps archived filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([ARCHIVED_APP]);
  });

  // Fire the `apps:changed` handler the page registered, so the list refreshes
  // exactly the way it does in the app after an archive/unarchive round-trip.
  const emitAppsChanged = async () => {
    const [, handler] = socket.on.mock.calls.find(([evt]) => evt === 'apps:changed');
    await act(async () => { await handler(); });
  };

  it('opens the archived list directly from /apps?view=archived', async () => {
    render(<MemoryRouter initialEntries={['/apps?view=archived']}><Apps /></MemoryRouter>);

    await screen.findByRole('link', { name: 'Example App' });
    expect(screen.getByRole('button', { name: /Active \(0\)/ })).toBeTruthy();
  });

  it('leaves a way back to the active list after the last archived app is unarchived', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/apps']}><Apps /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: /Archived \(1\)/ }));
    await screen.findByRole('link', { name: 'Example App' });

    await user.click(screen.getByRole('button', { name: 'More actions for Example App' }));
    await user.click(screen.getByRole('menuitem', { name: 'Unarchive' }));
    await waitFor(() => expect(api.unarchiveApp).toHaveBeenCalledWith('app-alpha'));

    // The archive is now empty, which used to unmount the toggle and strand the
    // user on a blank "No archived apps" card.
    api.getApps.mockResolvedValue([{ ...APPS[0], archived: false }]);
    await emitAppsChanged();

    expect(screen.getByText('No archived apps')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Active \(1\)/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Back to active apps' }));
    await screen.findByRole('link', { name: 'Example App' });
    expect(screen.queryByText('No archived apps')).toBeNull();
  });
});
