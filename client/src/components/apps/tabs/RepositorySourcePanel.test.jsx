import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getAppRepositorySources: vi.fn(),
  syncAppRepositoryFork: vi.fn(),
  pullAndUpdateApp: vi.fn(),
}));

import * as api from '../../../services/api';
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
  api.getAppRepositorySources.mockResolvedValue(canonicalStatus());
  api.syncAppRepositoryFork.mockResolvedValue({ synced: true, alreadyUpToDate: false });
  api.pullAndUpdateApp.mockResolvedValue({ success: true });
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
    expect(api.pullAndUpdateApp).not.toHaveBeenCalled();
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
    expect(dialog).toHaveTextContent('Restart the app\'s managed processes');

    fireEvent.click(screen.getByRole('button', { name: 'Sync fork and update' }));
    await waitFor(() => expect(api.pullAndUpdateApp).toHaveBeenCalledWith(
      'app-example',
      { syncFork: true },
      { silent: true },
    ));
    expect(api.syncAppRepositoryFork).not.toHaveBeenCalled();
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
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

    await waitFor(() => expect(api.pullAndUpdateApp).toHaveBeenCalledOnce());
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
