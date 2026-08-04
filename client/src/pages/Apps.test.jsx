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
  getJiraBoardColumns: vi.fn(() => Promise.resolve({ columns: [] })),
  updateJiraTicketStatus: vi.fn(() => Promise.resolve({})),
  openAppInEditor: vi.fn(() => Promise.resolve({})),
  openAppFolder: vi.fn(() => Promise.resolve({})),
  openAppInXcode: vi.fn(() => Promise.resolve({ success: true, path: '/srv/example-ios/ExampleIos.xcodeproj' })),
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

  it('states why another app’s Update is unavailable instead of silently greying it out', async () => {
    await renderApps();
    await emitSocket('app:operations:active', activeUpdate());

    await act(async () => {
      screen.getByRole('button', { name: 'Expand Second App details' }).click();
    });

    const busy = screen.getByRole('button', { name: /Update unavailable/ });
    expect(busy.textContent).toContain('Update (busy)');
    expect(busy.disabled).toBe(true);
  });

  it('keeps the completion visible when the server reports nothing in flight', async () => {
    await renderApps();
    await emitSocket('app:operations:active', activeUpdate());
    await emitSocket('app:update:complete', { appId: 'app-alpha', success: true, steps: [] });
    // The server clears its in-flight set right after the completion broadcast.
    await emitSocket('app:operations:active', { operations: [] });

    expect(screen.getByRole('status', { name: 'App operation status' }).textContent).toContain('Updated Example App');
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

describe('Apps sprint-ticket fetch failures (#3437)', () => {
  const JIRA_APP = {
    ...APPS[0],
    jira: { enabled: true, instanceId: 'jira-1', projectKey: 'EX', issueType: 'Task' }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([JIRA_APP]);
  });

  // The toggle relabels itself once open, so match either direction.
  const toggleRow = async (user) => {
    await user.click(screen.getByRole('button', { name: /(Expand|Collapse) Example App details/ }));
  };

  it('reports a failed fetch instead of claiming the sprint is empty, and retries on demand', async () => {
    api.getMySprintTickets.mockRejectedValue(new Error('JIRA instance unreachable'));
    const user = userEvent.setup();
    await renderApps();

    await toggleRow(user);
    await screen.findByText(/Couldn't load sprint tickets/);
    expect(screen.getByText(/JIRA instance unreachable/)).toBeTruthy();
    expect(screen.queryByText('No tickets assigned to you in the current sprint')).toBeNull();

    // Retry re-issues the request, and a now-healthy JIRA renders the board.
    api.getMySprintTickets.mockResolvedValue([
      { key: 'EX-1', summary: 'Example ticket', status: 'To Do' }
    ]);
    await user.click(screen.getByRole('button', { name: 'Retry loading sprint tickets for Example App' }));

    await waitFor(() => expect(api.getMySprintTickets).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Couldn't load sprint tickets/)).toBeNull());
  });

  it('re-issues the request on the next expand after a failure instead of caching it', async () => {
    api.getMySprintTickets.mockRejectedValue(new Error('JIRA instance unreachable'));
    const user = userEvent.setup();
    await renderApps();

    await toggleRow(user);
    await screen.findByText(/Couldn't load sprint tickets/);

    await toggleRow(user);   // collapse
    await toggleRow(user);   // re-expand
    await waitFor(() => expect(api.getMySprintTickets).toHaveBeenCalledTimes(2));
  });

  it('still reports a genuinely empty sprint as empty, and caches it', async () => {
    api.getMySprintTickets.mockResolvedValue([]);
    const user = userEvent.setup();
    await renderApps();

    await toggleRow(user);
    expect(await screen.findByText('No tickets assigned to you in the current sprint')).toBeTruthy();

    await toggleRow(user);   // collapse
    await toggleRow(user);   // re-expand — the cached [] is authoritative
    expect(api.getMySprintTickets).toHaveBeenCalledTimes(1);
  });

  it('renders its own error UI, so the request stays silent', async () => {
    api.getMySprintTickets.mockRejectedValue(new Error('JIRA instance unreachable'));
    const user = userEvent.setup();
    await renderApps();

    await toggleRow(user);
    await screen.findByText(/Couldn't load sprint tickets/);
    expect(api.getMySprintTickets).toHaveBeenCalledWith('jira-1', 'EX', { silent: true });
  });
});

describe('Apps sprint-ticket request races (#3437)', () => {
  const JIRA_APP = {
    ...APPS[0],
    jira: { enabled: true, instanceId: 'jira-1', projectKey: 'EX', issueType: 'Task' }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([JIRA_APP]);
  });

  it('does not start a second fetch while one is still in flight, and the in-flight result still lands', async () => {
    let resolveFirst;
    api.getMySprintTickets.mockImplementation(() => new Promise(resolve => { resolveFirst = resolve; }));

    const user = userEvent.setup();
    await renderApps();
    const toggle = () => user.click(screen.getByRole('button', { name: /(Expand|Collapse) Example App details/ }));

    await toggle();   // first fetch — hangs
    await toggle();   // collapse
    await toggle();   // re-expand while the first request is still open

    // One request, not two — so no older response can land after a newer one
    // and overwrite it.
    expect(api.getMySprintTickets).toHaveBeenCalledTimes(1);

    await act(async () => { resolveFirst([]); });
    expect(await screen.findByText('No tickets assigned to you in the current sprint')).toBeTruthy();
  });
});
