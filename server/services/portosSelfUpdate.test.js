import { describe, it, expect, vi, beforeEach } from 'vitest';

// The release and reconcile modes are already driven end-to-end through
// POST /api/update/execute in routes/update.test.js. This suite covers what
// only App Management's Git tab reaches: `refresh` mode, which exists because
// that path pulls the checkout onto its origin default branch BEFORE handing
// off — and the assumptions both other modes rely on then stop holding.
vi.mock('./updateChecker.js', () => ({
  getUpdateStatus: vi.fn(),
  setUpdateInProgress: vi.fn().mockResolvedValue(true),
}));
vi.mock('./updateExecutor.js', () => ({
  executeUpdate: vi.fn().mockResolvedValue({ success: true, version: '1.26.0' }),
}));
const { mockSpawningTasks } = vi.hoisted(() => ({ mockSpawningTasks: new Set() }));
vi.mock('./agentState.js', () => ({
  getActiveAgentIds: vi.fn().mockReturnValue([]),
  spawningTasks: mockSpawningTasks,
}));
vi.mock('./cosAgentLifecycle.js', () => ({ filterLiveAgentIds: vi.fn(async (ids) => ids) }));
vi.mock('./cosState.js', () => ({
  readPersistentMindStateForSafetyCheck: vi.fn(async () => ({
    trusted: true,
    persistentMind: { queuedMessages: [], activeTurn: null },
  })),
  withStateLock: vi.fn(async (fn) => fn()),
}));

import * as updateChecker from './updateChecker.js';
import { executeUpdate } from './updateExecutor.js';
import { startPortosSelfUpdate } from './portosSelfUpdate.js';

// An install with nothing pending and no newer release — the state a reconcile
// refuses outright.
const inSyncStatus = (overrides = {}) => ({
  currentVersion: '1.26.0',
  latestRelease: null,
  remoteInfo: { isFork: false, hasOrigin: true, fullName: 'atomantic/PortOS' },
  upstream: { fullName: 'atomantic/PortOS' },
  forkSyncFresh: false,
  installState: { outOfSync: false, staleDeps: { stale: false, workspaces: [] } },
  ...overrides,
});

describe('startPortosSelfUpdate — refresh mode', () => {
  const io = { emit: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawningTasks.clear();
    updateChecker.setUpdateInProgress.mockResolvedValue(true);
    updateChecker.getUpdateStatus.mockResolvedValue(inSyncStatus());
    // Signal the launch the way the real executeUpdate does — the launcher holds
    // its return until the spawn, so a mock that never signals is a mock of a
    // launch that never happened.
    executeUpdate.mockImplementation(async (_tag, _emit, opts) => {
      opts?.onLaunched?.();
      return { success: true, version: '1.26.0' };
    });
  });

  it('runs on an in-sync install, where a reconcile would refuse', async () => {
    // The Git tab has already pulled the checkout by the time it hands off, so
    // gating on "is the install out of sync?" would only be re-asking whether
    // that pull happened — and getUpdateStatus can still report the pre-pull
    // snapshot. A refusal here is what would leave the user's explicit "Update
    // app" doing nothing.
    await expect(startPortosSelfUpdate({ io, mode: 'reconcile' }))
      .rejects.toThrow(/already in sync/i);

    const result = await startPortosSelfUpdate({ io, mode: 'refresh' });

    expect(result).toEqual({ started: true, tag: 'v1.26.0' });
    expect(executeUpdate).toHaveBeenCalledOnce();
  });

  it('force-cleans the workspaces whose deps are stale, since update.sh sees no commit diff', async () => {
    // update.sh decides what to reinstall from the diff its OWN `git pull`
    // produces. The Git tab already advanced HEAD, so that diff is empty and
    // stale node_modules would survive the update (#1779) unless the workspaces
    // are named explicitly. 'root' maps to update.sh's '.' token.
    updateChecker.getUpdateStatus.mockResolvedValue(inSyncStatus({
      installState: {
        outOfSync: true,
        staleDeps: {
          stale: true,
          workspaces: [
            { name: 'root', stale: true },
            { name: 'client', stale: true },
            { name: 'server', stale: false },
          ],
        },
      },
    }));

    await startPortosSelfUpdate({ io, mode: 'refresh' });

    expect(executeUpdate).toHaveBeenCalledWith(
      'v1.26.0',
      expect.any(Function),
      expect.objectContaining({ forceCleanWorkspaces: ['.', 'client'] }),
    );
  });

  it('mirrors every step to the caller as well as the portos:update:step bus', async () => {
    // App Management renders the run in its own `app:update:step` frames, so
    // the launcher has to feed both sinks — otherwise the Git tab's progress
    // row stays empty for the whole update.
    const onStep = vi.fn();
    executeUpdate.mockImplementation(async (_tag, emit, opts) => {
      opts?.onLaunched?.();
      emit('pm2-stop', 'running', 'Stopping PortOS apps...');
      return { success: true, version: '1.26.0' };
    });

    await startPortosSelfUpdate({ io, mode: 'refresh', onStep });
    await vi.waitFor(() => expect(onStep).toHaveBeenCalled());

    expect(onStep).toHaveBeenCalledWith('pm2-stop', 'running', 'Stopping PortOS apps...');
    expect(io.emit).toHaveBeenCalledWith('portos:update:step', expect.objectContaining({
      step: 'pm2-stop',
      status: 'running',
    }));
  });

  it('refuses rather than reporting a start when a prior script is still running', async () => {
    // executeUpdate's still-running guard RESOLVES `success: false` without ever
    // spawning. Returning `started: true` for that leaves App Management's
    // operation registered forever (its handler skips cleanup on a real
    // handoff), so every later update is refused as a duplicate while the UI
    // waits for a restart that is not coming.
    executeUpdate.mockResolvedValue({
      success: false, failedStep: 'starting',
      errorMessage: 'A previous update script is still running',
    });

    await expect(startPortosSelfUpdate({ io, mode: 'refresh' }))
      .rejects.toThrow(/still running/i);
  });

  it('reports a launch that threw, instead of claiming the script started', async () => {
    executeUpdate.mockRejectedValue(new Error('spawn EACCES'));

    await expect(startPortosSelfUpdate({ io, mode: 'refresh' }))
      .rejects.toThrow('spawn EACCES');
  });

  it('resolves once the script is spawned, without waiting for it to finish', async () => {
    // The whole point: update.sh outlives this process, so the launcher must
    // return at the spawn. A promise that only settles when the script is done
    // would never resolve here — the pm2 delete kills the awaiting process.
    let finish;
    executeUpdate.mockImplementation((_tag, _emit, { onLaunched }) => {
      onLaunched();
      return new Promise((resolve) => { finish = resolve; });
    });

    await expect(startPortosSelfUpdate({ io, mode: 'refresh' }))
      .resolves.toEqual({ started: true, tag: 'v1.26.0' });
    expect(finish).toBeTypeOf('function');
    // A LATER failure is the fire-and-forget handler's business, not a rejection
    // out of a call that already returned — re-throwing it would be an unhandled
    // rejection, which is fatal on Node >= 15.
    finish({ success: false, failedStep: 'build', errorMessage: 'build failed' });
    await vi.waitFor(() => expect(io.emit).toHaveBeenCalledWith(
      'portos:update:error', expect.objectContaining({ step: 'build' }),
    ));
  });

  it('releases the update lock when the launch itself rejects', async () => {
    // executeUpdate clears the flag through recordUpdateResult on both of its
    // RESOLVED outcomes; a rejection reports none, and the stuck flag then
    // wedges every later update and every CoS agent spawn (#6036).
    executeUpdate.mockRejectedValue(new Error('spawn EACCES'));

    await startPortosSelfUpdate({ io, mode: 'refresh' }).catch(() => {});

    await vi.waitFor(() => expect(updateChecker.setUpdateInProgress).toHaveBeenCalledWith(false));
    expect(io.emit).toHaveBeenCalledWith('portos:update:error', expect.objectContaining({
      message: 'spawn EACCES',
    }));
  });
});
