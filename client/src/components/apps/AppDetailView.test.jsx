import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';

const socketHandlers = new Map();
const instanceFeatureMock = vi.hoisted(() => ({
  features: [
    { id: 'datadog', enabled: true },
    { id: 'jira', enabled: true },
    { id: 'gsd', enabled: true },
  ],
  error: null,
}));

vi.mock('../../services/api', () => ({
  PORTOS_APP_ID: 'portos-default',
  getApp: vi.fn(),
  getProcessesList: vi.fn(),
  launchNativeApp: vi.fn(),
}));

vi.mock('../../services/socket', () => ({
  default: {
    emit: vi.fn(),
    on: vi.fn((event, handler) => socketHandlers.set(event, handler)),
    off: vi.fn((event, handler) => {
      if (socketHandlers.get(event) === handler) socketHandlers.delete(event);
    }),
  },
}));

vi.mock('../../hooks/useInstanceFeatures.js', () => ({
  useInstanceFeatures: () => instanceFeatureMock,
}));

vi.mock('../../services/appUrls', () => ({
  getLaunchUrls: vi.fn(() => ({ https: null, http: null, dev: null })),
}));

vi.mock('../ui/Toast', () => ({
  default: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('../BrailleSpinner', () => ({ default: () => null }));
vi.mock('../StatusBadge', () => ({ default: () => null }));
vi.mock('./DeployPanel', () => ({ default: () => null }));
vi.mock('./EditAppDrawer', () => ({ default: () => null }));
vi.mock('./DesktopLaunchProgress', () => ({ default: ({ online }) => <output data-testid="native-state">{online ? 'Running' : 'Exited'}</output> }));
vi.mock('./tabs/OverviewTab', () => ({ default: ({ app }) => <output data-testid="overview-app">{app.id}</output> }));
vi.mock('./tabs/TasksTab', () => ({ default: () => null }));
vi.mock('./tabs/AutomationTab', () => ({ default: () => null }));
vi.mock('./tabs/DocumentsTab', () => ({ default: () => null }));
vi.mock('./tabs/GitTab', () => ({ default: () => null }));
vi.mock('./tabs/GsdTab', () => ({ default: () => null }));
vi.mock('./tabs/IssuesTab', () => ({ default: () => null }));
vi.mock('./tabs/JiraTab', () => ({ default: () => null }));
vi.mock('./tabs/ProcessesTab', () => ({ default: () => null }));
vi.mock('./tabs/ReferencesTab', () => ({ default: () => null }));
vi.mock('./tabs/SubmodulesTab', () => ({ default: () => null }));
vi.mock('./tabs/DatadogTab', () => ({ default: () => <div data-testid="datadog-tab" /> }));
vi.mock('./tabs/UpdateTab', () => ({ default: () => null }));

import * as api from '../../services/api';
import AppDetailView, { APP_DETAIL_TAB_ICONS } from './AppDetailView';
import { APP_DETAIL_TABS } from './constants';

const APP = {
  id: 'app-1',
  name: 'Example App',
  type: 'static',
  repoPath: '/mock/example-app',
  pm2ProcessNames: [],
  processes: [],
};

function LocationProbe() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return <>
    <output data-testid="location">{pathname}</output>
    <button onClick={() => navigate('/apps/app-2/overview')}>View second app</button>
  </>;
}

function renderDetail(initialEntry = '/apps/app-1/overview') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/apps/:appId/:tab" element={<AppDetailView />} />
        <Route path="/apps" element={<div>Apps index</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppDetailView app-removal socket handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketHandlers.clear();
    instanceFeatureMock.features = [
      { id: 'datadog', enabled: true },
      { id: 'jira', enabled: true },
      { id: 'gsd', enabled: true },
    ];
    instanceFeatureMock.error = null;
    api.getApp.mockResolvedValue(APP);
  });

  it('navigates away without refetching a detail record known to be deleted', async () => {
    renderDetail();

    await screen.findByRole('heading', { name: 'Example App' });
    const handleAppsChanged = socketHandlers.get('apps:changed');
    expect(handleAppsChanged).toBeTypeOf('function');

    await act(async () => {
      handleAppsChanged({ action: 'delete', appId: 'app-1' });
    });

    expect(screen.getByTestId('location')).toHaveTextContent('/apps');
    expect(api.getApp).toHaveBeenCalledTimes(1);
  });
});

describe('AppDetailView header title', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketHandlers.clear();
  });

  // A truncated h1 is the ONLY place the app name appears on this route, and
  // clipped text is neither selectable nor expandable — the tooltip is the sole
  // access path to the rest of a long name on a phone (#5694).
  it('exposes the full app name through the heading title attribute', async () => {
    const longName = 'Example Application With A Deliberately Very Long Managed App Name For Wrapping';
    api.getApp.mockResolvedValue({ ...APP, name: longName });

    renderDetail();

    const heading = await screen.findByRole('heading', { name: longName });
    expect(heading).toHaveAttribute('title', longName);
  });

  it('keeps the edit control next to the app identity on desktop', async () => {
    api.getApp.mockResolvedValue(APP);
    renderDetail();

    const heading = await screen.findByRole('heading', { name: APP.name });
    expect(heading.parentElement).toHaveClass('flex-1', 'lg:flex-initial', 'min-w-0');
  });

  it('does not display PM2 process names in the header', async () => {
    api.getApp.mockResolvedValue({
      ...APP,
      pm2ProcessNames: ['example-backend', 'example-worker'],
    });
    renderDetail();

    await screen.findByRole('heading', { name: APP.name });
    expect(screen.queryByText(/example-backend/)).toBeNull();
    expect(screen.queryByText(/example-worker/)).toBeNull();
  });
});

describe('AppDetailView managed-app feature tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketHandlers.clear();
    api.getApp.mockResolvedValue(APP);
  });

  it('hides globally disabled feature tabs', async () => {
    instanceFeatureMock.features = [
      { id: 'datadog', enabled: false },
      { id: 'jira', enabled: false },
      { id: 'gsd', enabled: false },
    ];

    renderDetail();

    await screen.findByRole('heading', { name: 'Example App' });
    expect(screen.queryByRole('tab', { name: 'DataDog' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'JIRA' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'GSD' })).toBeNull();
  });

  it('lets app overrides show or hide tabs independently of global settings', async () => {
    instanceFeatureMock.features = [
      { id: 'datadog', enabled: false },
      { id: 'jira', enabled: false },
      { id: 'gsd', enabled: true },
    ];
    api.getApp.mockResolvedValue({
      ...APP,
      featureOverrides: { datadog: true, jira: true, gsd: false },
    });

    renderDetail();

    await screen.findByRole('heading', { name: 'Example App' });
    expect(screen.getByRole('tab', { name: 'DataDog' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'JIRA' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'GSD' })).toBeNull();
  });

  it('keeps a disabled feature tab reachable from a direct URL', async () => {
    instanceFeatureMock.features = [
      { id: 'datadog', enabled: false },
      { id: 'jira', enabled: false },
      { id: 'gsd', enabled: false },
    ];

    renderDetail('/apps/app-1/datadog');

    await screen.findByRole('heading', { name: 'Example App' });
    expect(screen.queryByRole('tab', { name: 'DataDog' })).toBeNull();
    expect(screen.getByTestId('datadog-tab')).toBeInTheDocument();
  });

  it('assigns a unique icon to every app-detail tab', () => {
    const icons = APP_DETAIL_TABS.map((tab) => APP_DETAIL_TAB_ICONS[tab.id]);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(APP_DETAIL_TABS.length);
  });
});

describe('AppDetailView fetch lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketHandlers.clear();
    api.getApp.mockReset();
  });

  it('shows a retryable unavailable state for a failed detail request and recovers', async () => {
    api.getApp
      .mockRejectedValueOnce(Object.assign(new Error('Server unreachable'), { status: 503 }))
      .mockResolvedValueOnce(APP);
    renderDetail();

    const unavailable = await screen.findByRole('alert');
    expect(unavailable).toHaveTextContent('App unavailable');
    expect(unavailable).toHaveTextContent('Server unreachable');
    expect(screen.queryByText('App not found')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: APP.name })).toBeInTheDocument();
  });

  it('keeps a confirmed 404 distinct from an unavailable detail request', async () => {
    api.getApp.mockRejectedValue(Object.assign(new Error('App not found'), { status: 404 }));
    renderDetail();

    const missing = await screen.findByText('App not found');
    expect(missing).toHaveTextContent('App not found');
    expect(screen.queryByText('App unavailable')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('clears old child props immediately on navigation and ignores a late old-app refresh', async () => {
    let resolveOld;
    let resolveNew;
    api.getApp.mockResolvedValueOnce(APP)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    renderDetail();
    await screen.findByRole('heading', { name: APP.name });
    await act(async () => socketHandlers.get('apps:changed')({ appId: APP.id }));
    fireEvent.click(screen.getByRole('button', { name: 'View second app' }));
    expect(screen.queryByTestId('overview-app')).toBeNull();
    await act(async () => resolveNew({ ...APP, id: 'app-2', name: 'Second App' }));
    expect(screen.getByTestId('overview-app')).toHaveTextContent('app-2');
    await act(async () => resolveOld(APP));
    expect(screen.getByRole('heading', { name: 'Second App' })).toBeInTheDocument();
    expect(screen.getByTestId('overview-app')).toHaveTextContent('app-2');
  });

  it('ignores a failed previous-route request and recovers from a current-app failed refresh', async () => {
    let rejectOld;
    api.getApp.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
      .mockResolvedValueOnce({ ...APP, id: 'app-2', name: 'Second App' });
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'View second app' }));
    await screen.findByRole('heading', { name: 'Second App' });
    await act(async () => rejectOld(new Error('Old request failed')));
    expect(screen.getByTestId('overview-app')).toHaveTextContent('app-2');

    api.getApp.mockRejectedValueOnce(new Error('Refresh failed'));
    await act(async () => socketHandlers.get('apps:changed')({ appId: 'app-2' }));
    expect(screen.queryByTestId('overview-app')).toBeNull();
    api.getApp.mockResolvedValueOnce({ ...APP, id: 'app-2', name: 'Recovered App' });
    await act(async () => socketHandlers.get('apps:changed')({ appId: 'app-2' }));
    expect(screen.getByRole('heading', { name: 'Recovered App' })).toBeInTheDocument();
  });

  it('filters other-app events, preserves fleet invalidation, and keeps the newest refresh', async () => {
    let resolveOlder;
    api.getApp.mockResolvedValueOnce(APP)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
      .mockResolvedValueOnce({ ...APP, name: 'Updated App' });
    renderDetail();
    await screen.findByRole('heading', { name: APP.name });
    const changed = socketHandlers.get('apps:changed');
    await act(async () => {
      changed({ action: 'update', appId: 'app-2' });
      changed({ action: 'delete', appId: 'app-2' });
    });
    expect(api.getApp).toHaveBeenCalledTimes(1);
    await act(async () => changed({ action: 'update', appId: APP.id }));
    await act(async () => changed({ action: 'update-task-types' }));
    expect(api.getApp).toHaveBeenCalledTimes(3);
    await act(async () => resolveOlder(APP));
    expect(screen.getByRole('heading', { name: 'Updated App' })).toBeInTheDocument();
    api.getApp.mockResolvedValueOnce(APP);
    await act(async () => changed());
    expect(api.getApp).toHaveBeenCalledTimes(4);
  });
});


describe('native launch realtime status', () => {
  afterEach(() => vi.useRealTimers());
  it('applies process pushes without polling and reconciles reconnect/reshow once', async () => {
    vi.clearAllMocks();
    socketHandlers.clear();
    vi.useFakeTimers();
    api.getApp.mockResolvedValue({ ...APP, nativeLaunch: { label: 'Native', processName: 'example-native' } });
    api.launchNativeApp.mockResolvedValue({ processName: 'example-native' });
    api.getProcessesList.mockResolvedValue([{ name: 'example-native', status: 'online' }]);
    const view = renderDetail();
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Launch Native for Example App' })));
    expect(screen.getByTestId('native-state')).toHaveTextContent('Running');
    expect(api.getProcessesList).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(api.getProcessesList).toHaveBeenCalledTimes(1);
    await act(async () => socketHandlers.get('processes:changed')({ appIds: [APP.id], processes: null }));
    expect(screen.getByTestId('native-state')).toHaveTextContent('Running');
    await act(async () => socketHandlers.get('processes:changed')({ appIds: [APP.id], processes: [{ name: 'example-native', status: 'stopped' }] }));
    expect(screen.getByTestId('native-state')).toHaveTextContent('Exited');
    await act(async () => socketHandlers.get('connect')());
    expect(api.getProcessesList).toHaveBeenCalledTimes(2);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(api.getProcessesList).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(socketHandlers.has('processes:changed')).toBe(false);
    expect(socketHandlers.has('connect')).toBe(false);
  });
});
