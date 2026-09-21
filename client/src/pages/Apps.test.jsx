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

const launchUrlMock = vi.hoisted(() => ({
  getLaunchUrls: vi.fn((app) => ({
    https: null,
    http: app.uiPort ? `http://host-alpha.example-tailnet.ts.net:${app.uiPort}` : null,
    dev: app.devUiPort ? `http://host-alpha.example-tailnet.ts.net:${app.devUiPort}` : null,
  })),
}));

vi.mock('../services/appUrls', () => launchUrlMock);

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
  handleSelfRestart: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), custom: vi.fn() }
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

import * as api from '../services/api';
import toast from '../components/ui/Toast';
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

  it('keeps Archive and PortOS removal out of the resting row, leaving Manage as the visible action', async () => {
    await renderApps();

    expect(screen.getByRole('link', { name: 'Manage Example App' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop Example App' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remove from PortOS$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Archive$/ })).toBeNull();
  });

  it('renders the app name as a link to its detail route', async () => {
    await renderApps();

    const nameLink = screen.getByRole('link', { name: 'Example App' });
    expect(nameLink.getAttribute('href')).toBe('/apps/app-alpha');
    // Underlined so the name reads as a link, not plain text.
    expect(nameLink.className).toContain('underline');
  });

  it('keeps deep diagnostics out of collection rows and routes management to detail', async () => {
    api.getApps.mockResolvedValue([{
      ...APPS[0],
      startCommands: ['npm run start'],
      pm2Status: { 'example-server': { name: 'example-server', status: 'online' } },
      jira: { enabled: true, instanceId: 'jira-1', projectKey: 'EX' },
    }]);
    await renderApps();

    expect(screen.queryByRole('button', { name: /Expand .* details/ })).toBeNull();
    expect(screen.queryByText('Repository Path')).toBeNull();
    expect(screen.queryByText('PM2 Processes')).toBeNull();
    expect(screen.queryByText('My Sprint Tickets')).toBeNull();
    expect(screen.getByRole('link', { name: 'Manage Example App' })).toHaveAttribute('href', '/apps/app-alpha/overview');
  });

  it('keeps a long non-PM2 repository path wrapping within its collection row', async () => {
    api.getApps.mockResolvedValue([{
      ...APPS[0],
      id: 'app-longpath',
      name: 'Example Long Path App',
      type: 'ios-native',
      repoPath: '/srv/thisisaverylongsingledirectorysegmentwithnobreakpoints/example-ios',
      pm2ProcessNames: [],
      processes: [],
    }]);
    render(<MemoryRouter><Apps /></MemoryRouter>);
    await screen.findByRole('link', { name: 'Example Long Path App' });

    const repoPathSpan = screen.getByText('/srv/thisisaverylongsingledirectorysegmentwithnobreakpoints/example-ios');
    expect(repoPathSpan.className).toContain('break-all');
  });

  it('exposes Archive and PortOS removal only through the overflow menu', async () => {
    const user = userEvent.setup();
    await renderApps();

    await openRowMenu(user);
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Remove from PortOS' })).toBeTruthy();
  });

  it('requires an inline confirm before deleting, and cancelling leaves the app alone', async () => {
    const user = userEvent.setup();
    await renderApps();

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Remove from PortOS' }));

    expect(api.deleteApp).not.toHaveBeenCalled();
    const confirm = screen.getByLabelText('Confirm removal of Example App from PortOS');
    expect(confirm.textContent).toContain('repository will stay on disk');

    // Focus follows the revealed confirmation instead of being stranded on the
    // "…" trigger whose menu just closed.
    expect(document.activeElement).toBe(confirm);

    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(api.deleteApp).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Confirm removal of Example App from PortOS')).toBeNull();
    // Dismissing hands focus back to the trigger it came from, not to <body>.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More actions for Example App' }));
  });

  it('deletes only after the inline confirm is accepted', async () => {
    const user = userEvent.setup();
    await renderApps();

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Remove from PortOS' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.deleteApp).toHaveBeenCalledWith('app-alpha'));
    expect(toast.success).toHaveBeenCalledWith('Example App removed from PortOS — files kept on disk');
    expect(screen.queryByRole('link', { name: 'Example App' })).toBeNull();
  });

  it('archives from the overflow menu', async () => {
    const user = userEvent.setup();
    await renderApps();

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));

    await waitFor(() => expect(api.archiveApp).toHaveBeenCalledWith('app-alpha'));
  });

});

describe('Apps collection load states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('distinguishes an unavailable collection from empty and retries in place', async () => {
    api.getApps
      .mockRejectedValueOnce(new Error('Server unreachable'))
      .mockResolvedValueOnce(APPS);
    const user = userEvent.setup();
    render(<MemoryRouter><Apps /></MemoryRouter>);

    const unavailable = await screen.findByRole('alert');
    expect(unavailable).toHaveTextContent('Apps unavailable');
    expect(screen.queryByText('No apps registered')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('link', { name: 'Example App' });
    expect(api.getApps).toHaveBeenLastCalledWith({ includeQuality: true, silent: true });
  });

  it('keeps a real empty collection distinct from an unavailable collection', async () => {
    api.getApps.mockResolvedValue([]);
    render(<MemoryRouter><Apps /></MemoryRouter>);

    expect(await screen.findByText('No apps registered')).toBeTruthy();
    expect(screen.queryByText('Apps unavailable')).toBeNull();
  });

  it('keeps the last loaded collection visible when a refresh fails', async () => {
    api.getApps
      .mockResolvedValueOnce(APPS)
      .mockRejectedValueOnce(new Error('Server unreachable'));
    render(<MemoryRouter><Apps /></MemoryRouter>);
    await screen.findByRole('link', { name: 'Example App' });

    const [, handleAppsChanged] = socket.on.mock.calls.find(([event]) => event === 'apps:changed');
    await act(async () => { await handleAppsChanged(); });

    expect(screen.getByRole('link', { name: 'Example App' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('showing the last loaded collection');
  });

  it('keeps an in-flight operation visible while the initial collection is unavailable', async () => {
    api.getApps.mockRejectedValueOnce(new Error('Server unreachable'));
    render(<MemoryRouter><Apps /></MemoryRouter>);
    await screen.findByRole('alert');

    const [, handleOperations] = socket.on.mock.calls.find(([event]) => event === 'app:operations:active');
    await act(async () => {
      await handleOperations({
        operations: [{ appId: 'app-alpha', appName: 'Example App', type: 'update', steps: [] }],
      });
    });

    expect(screen.getByRole('status', { name: 'App operation status' })).toHaveTextContent('Updating Example App');
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

describe('Apps in-flight operation banner (#3435)', () => {
  const SECOND_APP = { ...APPS[0], id: 'app-beta', name: 'Second App' };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([APPS[0], SECOND_APP]);
  });

  // Fire a socket event the page subscribed to, the way the server broadcasts it.
  const emitSocket = async (event, payload) => {
    const [, handler] = socket.on.mock.calls.find(([evt]) => evt === event);
    await act(async () => { await handler(payload); });
  };

  const activeUpdate = (steps = []) => ({
    operations: [{ appId: 'app-alpha', appName: 'Example App', type: 'update', steps }]
  });

  it('asks the server for in-flight operations on mount', async () => {
    await renderApps();
    expect(socket.emit).toHaveBeenCalledWith('app:operations:list');
  });

  it('shows an operation started elsewhere with every row collapsed', async () => {
    await renderApps();
    await emitSocket('app:operations:active', activeUpdate([
      { appId: 'app-alpha', step: 'pull', status: 'running', message: 'Pulling latest…' }
    ]));

    // No row is expanded — the banner is the only place progress could show.
    expect(screen.queryByText('Repository Path')).toBeNull();
    const banner = screen.getByRole('status', { name: 'App operation status' });
    expect(banner.textContent).toContain('Updating Example App');
    expect(banner.textContent).toContain('Pulling latest…');
  });

  it('keeps streaming steps into the banner while the row stays collapsed', async () => {
    await renderApps();
    await emitSocket('app:operations:active', activeUpdate());
    await emitSocket('app:update:step', { appId: 'app-alpha', step: 'install', status: 'running', message: 'Installing deps…' });

    expect(screen.getByRole('status', { name: 'App operation status' }).textContent).toContain('Installing deps…');
  });

  it('clears a stale banner when the server reports no operation and none finished', async () => {
    await renderApps();
    await emitSocket('app:operations:active', activeUpdate());
    expect(screen.getByRole('status', { name: 'App operation status' })).toBeTruthy();

    // e.g. the server restarted mid-operation — the work is genuinely gone.
    await emitSocket('app:operations:active', { operations: [] });
    expect(screen.queryByRole('status', { name: 'App operation status' })).toBeNull();
  });
});

describe('Apps concurrent operations and duplicate dispatch (#3435)', () => {
  const SECOND_APP = { ...APPS[0], id: 'app-beta', name: 'Second App' };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([APPS[0], SECOND_APP]);
  });

  const emitSocket = async (event, payload) => {
    const [, handler] = socket.on.mock.calls.find(([evt]) => evt === event);
    await act(async () => { await handler(payload); });
  };

  const banners = () => screen.getAllByRole('status', { name: 'App operation status' });

  it('represents every running operation rather than shadowing one with the other', async () => {
    await renderApps();
    await emitSocket('app:operations:active', {
      operations: [
        { appId: 'app-alpha', appName: 'Example App', type: 'update', steps: [] },
        { appId: 'app-beta', appName: 'Second App', type: 'standardize', steps: [] }
      ]
    });
    await emitSocket('app:standardize:step', { appId: 'app-beta', step: 'analyze', status: 'running', message: 'Analyzing…' });

    const text = banners().map(b => b.textContent).join(' ');
    expect(text).toContain('Updating Example App');
    expect(text).toContain('Standardizing Second App');
    // The second app's steps land on the second app's banner, not the first's.
    expect(banners()[1].textContent).toContain('Analyzing…');
  });

  it('does not report a refused duplicate dispatch as the running operation failing', async () => {
    await renderApps();
    await emitSocket('app:operations:active', {
      operations: [{ appId: 'app-alpha', appName: 'Example App', type: 'update', steps: [] }]
    });

    await emitSocket('app:update:error', {
      appId: 'app-alpha',
      duplicate: true,
      message: 'An update is already running for Example App'
    });

    // Still shown as running — the rejection was about the second dispatch.
    expect(banners()[0].textContent).toContain('Updating Example App');
    expect(banners()[0].textContent).not.toContain('failed');
  });

  it('treats an unsuccessful completion as a failure instead of "complete"', async () => {
    await renderApps();
    await emitSocket('app:operations:active', {
      operations: [{ appId: 'app-alpha', appName: 'Example App', type: 'update', steps: [] }]
    });
    await emitSocket('app:update:complete', { appId: 'app-alpha', success: false, steps: [] });

    expect(banners()[0].textContent).toContain('Update failed for Example App');
  });
});

describe('Apps archive result reporting (#3436)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue(APPS);
  });

  it('does not claim an app was archived when the request failed', async () => {
    api.archiveApp.mockRejectedValue(new Error('Server unreachable'));
    const user = userEvent.setup();
    await renderApps();

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(api.archiveApp).toHaveBeenCalledWith('app-alpha'));

    // request() already toasted the failure — a green "archived" on top of it
    // told the user CoS would skip the app when nothing changed.
    expect(toast.success).not.toHaveBeenCalled();

    // …and the menu item is back from "Working…" so the action can be retried.
    await openRowMenu(user);
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
  });

  it('does not claim an app was unarchived when the request failed', async () => {
    api.getApps.mockResolvedValue([ARCHIVED_APP]);
    api.unarchiveApp.mockRejectedValue(new Error('Server unreachable'));
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/apps?view=archived']}><Apps /></MemoryRouter>);
    await screen.findByRole('link', { name: 'Example App' });

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Unarchive' }));
    await waitFor(() => expect(api.unarchiveApp).toHaveBeenCalledWith('app-alpha'));

    expect(toast.success).not.toHaveBeenCalled();
  });

  it('confirms and reflects a successful archive without waiting for a refetch', async () => {
    api.archiveApp.mockResolvedValue({ ...APPS[0], archived: true });
    const user = userEvent.setup();
    await renderApps();

    await openRowMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('archived')));
    // Local state moved the row into the archived list — no refetch needed.
    expect(await screen.findByRole('button', { name: /Archived \(1\)/ })).toBeTruthy();
  });
});
