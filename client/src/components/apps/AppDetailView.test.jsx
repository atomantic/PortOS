import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

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
}));

vi.mock('../../services/socket', () => ({
  default: {
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
vi.mock('./DesktopLaunchProgress', () => ({ default: () => null }));
vi.mock('./tabs/OverviewTab', () => ({ default: () => null }));
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
import AppDetailView from './AppDetailView';

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
  return <output data-testid="location">{pathname}</output>;
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
    expect(screen.queryByRole('button', { name: 'DataDog' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'JIRA' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'GSD' })).toBeNull();
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
    expect(screen.getByRole('button', { name: 'DataDog' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'JIRA' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'GSD' })).toBeNull();
  });

  it('keeps a disabled feature tab reachable from a direct URL', async () => {
    instanceFeatureMock.features = [
      { id: 'datadog', enabled: false },
      { id: 'jira', enabled: false },
      { id: 'gsd', enabled: false },
    ];

    renderDetail('/apps/app-1/datadog');

    await screen.findByRole('heading', { name: 'Example App' });
    expect(screen.queryByRole('button', { name: 'DataDog' })).toBeNull();
    expect(screen.getByTestId('datadog-tab')).toBeInTheDocument();
  });
});
