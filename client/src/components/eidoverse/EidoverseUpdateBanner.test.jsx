import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  getAppRepositorySources: vi.fn(),
}));
vi.mock('../../hooks/useAppOperation', () => ({
  useAppOperation: vi.fn(),
}));

import * as api from '../../services/api';
import { useAppOperation } from '../../hooks/useAppOperation';
import EidoverseUpdateBanner from './EidoverseUpdateBanner';

const source = ({
  id, label, origin = {}, localVsOrigin = { ahead: 0, behind: 0, state: 'current' },
  forkVsUpstream = null, forkSyncable,
}) => ({
  id,
  label,
  present: true,
  branch: 'main',
  head: `${id}-head`,
  clean: true,
  origin: { hasOrigin: true, isUpstream: true, isFork: false, head: `${id}-origin-head`, ...origin },
  upstream: { fullName: 'anima-research/eidoverse-worlds', branch: 'main' },
  localVsOrigin,
  forkVsUpstream,
  // Mirrors the server's `isForkSyncable` so fixtures carry the payload the
  // client actually reads (server/services/managedAppRepositories.js).
  forkSyncable: forkSyncable ?? (id === 'primary'
    && Boolean(origin.isFork)
    && origin.canPush !== false
    && forkVsUpstream?.state !== 'diverged'),
  remoteFresh: true,
  remoteError: null,
});

const behindStatus = () => ({
  kind: 'managed-app',
  updateAvailable: true,
  updatePullsAll: true,
  updateRestartsApp: true,
  sources: [
    source({
      id: 'primary',
      label: 'Eidoverse Worlds',
      localVsOrigin: { ahead: 0, behind: 3, state: 'behind' },
    }),
    source({ id: 'companion-1', label: 'eidoverse-video' }),
  ],
});

const startUpdate = vi.fn();

const renderBanner = (props = {}) => render(
  <MemoryRouter>
    <EidoverseUpdateBanner appId="app-eidoverse" {...props} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAppOperation.mockReturnValue({
    steps: [], isOperating: false, error: null, completed: false, startUpdate,
  });
  api.getAppRepositorySources.mockResolvedValue(behindStatus());
});

afterEach(() => cleanup());

describe('Eidoverse out-of-date advisory', () => {
  it('stays silent when every checkout is current', async () => {
    api.getAppRepositorySources.mockResolvedValue({ ...behindStatus(), updateAvailable: false });
    renderBanner();

    await waitFor(() => expect(api.getAppRepositorySources).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays silent when the freshness check fails, rather than guessing', async () => {
    api.getAppRepositorySources.mockRejectedValue(new Error('origin unreachable'));
    renderBanner();

    await waitFor(() => expect(api.getAppRepositorySources).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dispatches the managed update, fast-forwarding a behind fork but never a diverged one', async () => {
    const status = behindStatus();
    status.sources[0] = source({
      id: 'primary',
      label: 'Eidoverse Worlds',
      origin: { fullName: 'example-owner/eidoverse-worlds', isUpstream: false, isFork: true },
      forkVsUpstream: { available: true, ahead: 0, behind: 2, state: 'behind', error: null },
    });
    api.getAppRepositorySources.mockResolvedValue(status);
    renderBanner();

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('the Eidoverse Worlds fork is 2 commits behind upstream');
    expect(banner).toHaveTextContent('restarts Eidoverse');
    fireEvent.click(screen.getByRole('button', { name: /Update Eidoverse/ }));
    expect(startUpdate).toHaveBeenCalledWith('app-eidoverse', 'Eidoverse Worlds', { syncFork: true });

    cleanup();
    startUpdate.mockClear();
    localStorage.clear();
    status.sources[0] = source({
      id: 'primary',
      label: 'Eidoverse Worlds',
      origin: { fullName: 'example-owner/eidoverse-worlds', isUpstream: false, isFork: true },
      forkVsUpstream: { available: true, ahead: 1, behind: 2, state: 'diverged', error: null },
    });
    api.getAppRepositorySources.mockResolvedValue(status);
    renderBanner();

    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: /Update Eidoverse/ }));
    expect(startUpdate).toHaveBeenCalledWith('app-eidoverse', 'Eidoverse Worlds', { syncFork: false });
  });

  // The real Eidoverse shape: the video checkout is cloned from a third party's
  // fork of the canonical project. `gh repo sync` would 403 on it and pulling it
  // from its own origin brings nothing new, so an advisory raised for that drift
  // could never be cleared by any button PortOS offers (#6321).
  it('says nothing about a fork PortOS has no push access to', async () => {
    api.getAppRepositorySources.mockResolvedValue({
      kind: 'managed-app',
      // The server computes this from the same rule; a fork PortOS may only
      // read is not an available update.
      updateAvailable: false,
      updatePullsAll: true,
      updateRestartsApp: true,
      sources: [
        source({ id: 'primary', label: 'Eidoverse Worlds' }),
        source({
          id: 'companion-1',
          label: 'eidoverse-video',
          origin: {
            fullName: 'anima-research/eidoverse-video',
            isUpstream: false,
            isFork: true,
            canPush: false,
          },
          forkVsUpstream: { available: true, ahead: 0, behind: 12, state: 'behind', error: null },
        }),
      ],
    });
    renderBanner();

    await waitFor(() => expect(api.getAppRepositorySources).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  // A checkout behind its OWN origin is still actionable even when the same
  // stack carries an unsyncable fork — the advisory must name only the part an
  // update moves, not the part it cannot.
  it('names only the drift an update can pull forward', async () => {
    const status = behindStatus();
    status.sources[1] = source({
      id: 'companion-1',
      label: 'eidoverse-video',
      origin: { fullName: 'anima-research/eidoverse-video', isUpstream: false, isFork: true, canPush: false },
      forkVsUpstream: { available: true, ahead: 0, behind: 12, state: 'behind', error: null },
    });
    api.getAppRepositorySources.mockResolvedValue(status);
    renderBanner();

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('Eidoverse Worlds is 3 commits behind its origin');
    expect(banner).not.toHaveTextContent('eidoverse-video');
  });

  it('keeps a dismissal until the upstream revision changes', async () => {
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();

    cleanup();
    renderBanner();
    await waitFor(() => expect(api.getAppRepositorySources).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).toBeNull();

    cleanup();
    const newer = behindStatus();
    newer.sources[0].origin.head = 'primary-origin-head-2';
    api.getAppRepositorySources.mockResolvedValue(newer);
    renderBanner();
    expect(await screen.findByRole('status')).toHaveTextContent('Eidoverse update available');
  });

  it('reports the running update instead of the advisory, and rechecks when it finishes', async () => {
    useAppOperation.mockReturnValue({
      steps: [{ step: 'git-pull', status: 'running', message: 'Pulling Eidoverse Worlds...' }],
      isOperating: true,
      error: null,
      completed: false,
      startUpdate,
    });
    const onUpdated = vi.fn();
    renderBanner({ onUpdated });

    expect(await screen.findByRole('status', { name: 'App operation status' })).toHaveTextContent('Pulling Eidoverse Worlds...');
    expect(screen.queryByRole('button', { name: /Update Eidoverse/ })).toBeNull();

    await act(async () => { useAppOperation.mock.calls.at(-1)[0].onComplete(); });
    await waitFor(() => expect(api.getAppRepositorySources).toHaveBeenCalledTimes(2));
    expect(onUpdated).toHaveBeenCalled();
  });
});
