import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  PORTOS_APP_ID: 'portos-default',
  getAppRepositorySources: vi.fn(),
  syncAppRepositoryFork: vi.fn(),
  handleSelfRestart: vi.fn(),
}));
vi.mock('../../../hooks/useAppOperation', () => ({
  useAppOperation: vi.fn(),
}));

import * as api from '../../../services/api';
import { useAppOperation } from '../../../hooks/useAppOperation';
import RepositorySourcePanel from './RepositorySourcePanel';

const source = ({
  id,
  label,
  branch,
  head,
  origin,
  localVsOrigin = { ahead: 0, behind: 0, state: 'current' },
  forkVsUpstream = null,
}) => ({
  id,
  label,
  present: true,
  branch,
  head,
  shortHead: head.slice(0, 7),
  clean: true,
  origin: {
    hasOrigin: true,
    isGithub: true,
    head,
    shortHead: head.slice(0, 7),
    ...origin,
  },
  upstream: {
    fullName: `anima-research/${id === 'primary' ? 'example-app' : 'example-runtime'}`,
    branch,
  },
  localVsOrigin,
  forkVsUpstream,
  remoteFresh: true,
  remoteError: null,
});

const canonicalStatus = () => ({
  kind: 'managed-app',
  updateAvailable: true,
  updatePullsAll: true,
  updateRestartsApp: true,
  sources: [
    source({
      id: 'primary',
      label: 'Example App',
      branch: 'main',
      head: '1'.repeat(40),
      origin: {
        fullName: 'anima-research/example-app',
        isUpstream: true,
        isFork: false,
      },
      localVsOrigin: { ahead: 0, behind: 1, state: 'behind' },
    }),
    source({
      id: 'companion-1',
      label: 'example-runtime',
      branch: 'prod-serving',
      head: '2'.repeat(40),
      origin: {
        fullName: 'anima-research/example-runtime',
        isUpstream: true,
        isFork: false,
      },
    }),
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  useAppOperation.mockReturnValue({
    steps: [], isOperating: false, operationType: null, error: null, completed: false,
    startUpdate: vi.fn(),
  });
  api.getAppRepositorySources.mockResolvedValue(canonicalStatus());
  api.syncAppRepositoryFork.mockResolvedValue({ synced: true, alreadyUpToDate: false });
});

afterEach(() => cleanup());

describe('managed app repository sources', () => {
  it('explains and versions both independent checkouts', async () => {
    render(<RepositorySourcePanel appId="app-example" appName="Example App" />);

    expect(await screen.findByText('Repository sources')).toBeInTheDocument();
    expect(screen.getByText('Independent companion checkout · not a submodule')).toBeInTheDocument();
    expect(screen.getByTestId('repository-source-primary')).toHaveTextContent('main @ 1111111');
    expect(screen.getByTestId('repository-source-primary')).toHaveTextContent('Checkout 1 behind');
    expect(screen.getByTestId('repository-source-companion-1')).toHaveTextContent('prod-serving @ 2222222');
    expect(screen.getByTestId('repository-source-companion-1')).toHaveTextContent('Current');
    expect(screen.getByRole('button', { name: 'Update app' })).toBeInTheDocument();
  });

  it('keeps the current update step visible while the operation is running', async () => {
    useAppOperation.mockReturnValue({
      steps: [{ step: 'npm-install:root', status: 'running', message: 'Installing root dependencies...' }],
      isOperating: true,
      operationType: 'update',
      error: null,
      completed: false,
      startUpdate: vi.fn(),
    });
    render(<RepositorySourcePanel appId="app-example" appName="Example App" />);

    expect(await screen.findByRole('status', { name: 'App operation status' })).toHaveTextContent('Installing root dependencies...');
    expect(screen.getByRole('button', { name: 'Updating...' })).toBeDisabled();
  });

  it('shows local, fork, and upstream as separate version hops and can sync only the fork', async () => {
    const status = canonicalStatus();
    status.sources[0] = source({
      id: 'primary',
      label: 'Example App',
      branch: 'main',
      head: '1'.repeat(40),
      origin: {
        fullName: 'example-owner/example-app',
        isUpstream: false,
        isFork: true,
      },
      forkVsUpstream: { available: true, ahead: 0, behind: 2, state: 'behind', error: null },
    });
    api.getAppRepositorySources.mockResolvedValue(status);
    render(<RepositorySourcePanel appId="app-example" appName="Example App" />);

    const primary = await screen.findByTestId('repository-source-primary');
    expect(primary).toHaveTextContent('example-owner/example-app (fork)');
    expect(primary).toHaveTextContent('anima-research/example-app (upstream)');
    expect(screen.getByRole('button', { name: 'Sync fork & update app' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sync fork' }));
    await waitFor(() => expect(api.syncAppRepositoryFork).toHaveBeenCalledWith('app-example', { silent: true }));
    expect(useAppOperation.mock.results[0].value.startUpdate).not.toHaveBeenCalled();
  });

  it('confirms that one managed update syncs the fork and updates every checkout', async () => {
    const status = canonicalStatus();
    status.sources[0] = source({
      id: 'primary',
      label: 'Example App',
      branch: 'main',
      head: '1'.repeat(40),
      origin: {
        fullName: 'example-owner/example-app',
        isUpstream: false,
        isFork: true,
      },
      forkVsUpstream: { available: true, ahead: 0, behind: 2, state: 'behind', error: null },
    });
    api.getAppRepositorySources.mockResolvedValue(status);
    const onUpdated = vi.fn();
    render(<RepositorySourcePanel appId="app-example" appName="Example App" onUpdated={onUpdated} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sync fork & update app' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Pull 1 independent companion checkout');
    expect(dialog).toHaveTextContent('Rebuild the production UI when a build script is configured');
    expect(dialog).toHaveTextContent('Restart the app\'s managed processes');

    fireEvent.click(screen.getByRole('button', { name: 'Sync fork and update' }));
    await waitFor(() => expect(useAppOperation.mock.results[0].value.startUpdate).toHaveBeenCalledWith(
      'app-example', 'Example App', { syncFork: true },
    ));
    expect(api.syncAppRepositoryFork).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('refreshes source status when the parent Git tab reports a branch update', async () => {
    const currentStatus = canonicalStatus();
    currentStatus.updateAvailable = false;
    currentStatus.sources[0] = source({
      id: 'primary',
      label: 'Example App',
      branch: 'main',
      head: '3'.repeat(40),
      origin: {
        fullName: 'anima-research/example-app',
        isUpstream: true,
        isFork: false,
      },
    });
    api.getAppRepositorySources
      .mockResolvedValueOnce(canonicalStatus())
      .mockResolvedValueOnce(currentStatus);

    const { rerender } = render(
      <RepositorySourcePanel appId="app-example" appName="Example App" refreshKey={0} />,
    );
    expect(await screen.findByText('Checkout 1 behind')).toBeInTheDocument();

    rerender(<RepositorySourcePanel appId="app-example" appName="Example App" refreshKey={1} />);

    await waitFor(() => expect(api.getAppRepositorySources).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('repository-source-primary')).toHaveTextContent('Current'));
  });

  it('locks the update action after dispatch until the page reloads', async () => {
    render(<RepositorySourcePanel appId="portos-default" appName="PortOS" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update app' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Update app' }));

    const updateButton = screen.getByRole('button', { name: 'Reload to update again' });
    expect(updateButton).toBeDisabled();
    expect(useAppOperation.mock.results[0].value.startUpdate).toHaveBeenCalledWith(
      'portos-default', 'PortOS', { syncFork: false },
    );
  });

  it('refuses automatic fork sync after divergence but still permits updating from the fork as-is', async () => {
    const status = canonicalStatus();
    status.sources[0] = source({
      id: 'primary',
      label: 'Example App',
      branch: 'main',
      head: '1'.repeat(40),
      origin: {
        fullName: 'example-owner/example-app',
        isUpstream: false,
        isFork: true,
      },
      forkVsUpstream: { available: true, ahead: 1, behind: 2, state: 'diverged', error: null },
    });
    api.getAppRepositorySources.mockResolvedValue(status);
    render(<RepositorySourcePanel appId="app-example" appName="Example App" />);

    expect(await screen.findByRole('button', { name: 'Fork needs reconciliation' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Update app from fork' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Update app' }));

    await waitFor(() => expect(useAppOperation.mock.results[0].value.startUpdate).toHaveBeenCalledOnce());
    expect(api.syncAppRepositoryFork).not.toHaveBeenCalled();
  });

  it('never reports current when the fork-to-upstream comparison failed', async () => {
    const status = canonicalStatus();
    status.updateAvailable = false;
    status.sources[0] = source({
      id: 'primary',
      label: 'Example App',
      branch: 'main',
      head: '1'.repeat(40),
      origin: {
        fullName: 'example-owner/example-app',
        isUpstream: false,
        isFork: true,
      },
      forkVsUpstream: {
        available: false,
        ahead: null,
        behind: null,
        state: 'unknown',
        error: 'Could not compare the fork with canonical upstream',
      },
    });
    api.getAppRepositorySources.mockResolvedValue(status);
    render(<RepositorySourcePanel appId="app-example" appName="Example App" />);

    const primary = await screen.findByTestId('repository-source-primary');
    expect(primary).toHaveTextContent('Upstream check unavailable');
    expect(primary).toHaveTextContent('fork freshness is unknown');
    expect(screen.getByText('Remote freshness is unknown; a managed update can retry the source checkouts.')).toBeInTheDocument();
  });

  it('offers to update from a fork as-is after a FORK_SYNC_REQUIRED refusal', async () => {
    useAppOperation.mockReturnValue({
      steps: [], isOperating: false, operationType: 'update',
      error: 'Running from a fork (alice/PortOS). Sync your fork first, or acknowledge.',
      errorCode: 'FORK_SYNC_REQUIRED', completed: false,
      startUpdate: vi.fn(),
    });
    render(<RepositorySourcePanel appId="portos-default" appName="PortOS" />);

    const retryButton = await screen.findByRole('button', { name: 'Update from fork as-is' });
    fireEvent.click(retryButton);

    expect(useAppOperation.mock.results[0].value.startUpdate).toHaveBeenCalledWith(
      'portos-default', 'PortOS', { acknowledgeFork: true },
    );
  });

  it('offers to update anyway after a PERSISTENT_MIND_IMAGES_IN_FLIGHT refusal', async () => {
    useAppOperation.mockReturnValue({
      steps: [], isOperating: false, operationType: 'update',
      error: 'Persistent Mind has 1 queued image message.',
      errorCode: 'PERSISTENT_MIND_IMAGES_IN_FLIGHT', completed: false,
      startUpdate: vi.fn(),
    });
    render(<RepositorySourcePanel appId="portos-default" appName="PortOS" />);

    const retryButton = await screen.findByRole('button', { name: 'Update anyway (back up first)' });
    fireEvent.click(retryButton);

    expect(useAppOperation.mock.results[0].value.startUpdate).toHaveBeenCalledWith(
      'portos-default', 'PortOS', { acknowledgePersistentMindImageBackup: true },
    );
  });

  it('does not offer an acknowledgement retry for a refusal with no acknowledgement (AGENTS_ACTIVE)', async () => {
    useAppOperation.mockReturnValue({
      steps: [], isOperating: false, operationType: 'update',
      error: '1 CoS agent is running — updating would restart PortOS and sever it.',
      errorCode: 'AGENTS_ACTIVE', completed: false,
      startUpdate: vi.fn(),
    });
    render(<RepositorySourcePanel appId="portos-default" appName="PortOS" />);

    await screen.findByText(/CoS agent is running/);
    expect(screen.queryByRole('button', { name: 'Update from fork as-is' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update anyway (back up first)' })).not.toBeInTheDocument();
  });

  it('does not mislabel an undiscovered repository topology as a custom origin', async () => {
    const status = canonicalStatus();
    status.updateAvailable = false;
    status.sources = [source({
      id: 'primary',
      label: 'Example App',
      branch: 'main',
      head: '1'.repeat(40),
      origin: {
        fullName: 'example-owner/example-app',
        isUpstream: null,
        isFork: false,
      },
    })];
    api.getAppRepositorySources.mockResolvedValue(status);
    render(<RepositorySourcePanel appId="app-example" appName="Example App" />);

    const primary = await screen.findByTestId('repository-source-primary');
    expect(primary).toHaveTextContent('Upstream check unavailable');
    expect(primary).not.toHaveTextContent('Custom origin');
    expect(screen.getByRole('button', { name: 'Update app' })).toBeInTheDocument();
  });
});

describe('PortOS self-update restart handoff', () => {
  it('swaps the banner copy to the restart notice once useAppOperation reports it', async () => {
    // The detection itself lives in useAppOperation (see its own suite). What
    // this panel owes the user is telling them the page will come back rather
    // than leaving "Stopping PortOS apps..." on screen with no explanation.
    useAppOperation.mockReturnValue({
      steps: [{ step: 'pm2-stop', status: 'running', message: 'Stopping PortOS apps...' }],
      isOperating: true, operationType: 'update', error: null, errorCode: null, completed: false,
      restarting: true,
      startUpdate: vi.fn(),
    });
    render(<RepositorySourcePanel appId="portos-default" appName="PortOS" />);

    expect(await screen.findByText(
      'PortOS is restarting — this page reloads once it answers again.',
    )).toBeInTheDocument();
    // Every action stays locked while the install is coming back.
    expect(screen.getByRole('button', { name: 'Check sources' })).toBeDisabled();
  });
});
