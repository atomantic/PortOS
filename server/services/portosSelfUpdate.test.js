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
  launchUpdate: vi.fn().mockResolvedValue({ started: true, completion: Promise.resolve({ success: true, version: '1.26.0' }) }),
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
import { launchUpdate } from './updateExecutor.js';
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
    launchUpdate.mockResolvedValue({ started: true, completion: Promise.resolve({ success: true, version: '1.26.0' }) });
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
    expect(launchUpdate).toHaveBeenCalledOnce();
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

    expect(launchUpdate).toHaveBeenCalledWith(
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
    launchUpdate.mockImplementation(async (_tag, emit) => {
      emit('pm2-stop', 'running', 'Stopping PortOS apps...');
      return { started: true, completion: Promise.resolve({ success: true, version: '1.26.0' }) };
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
    // launchUpdate's still-running guard returns `started: false` without ever
    // spawning. Returning `started: true` for that leaves App Management's
    // operation registered forever (its handler skips cleanup on a real
    // handoff), so every later update is refused as a duplicate while the UI
    // waits for a restart that is not coming.
    launchUpdate.mockResolvedValue({
      started: false, result: {
        success: false, failedStep: 'starting',
        errorMessage: 'A previous update script is still running',
      },
    });

    await expect(startPortosSelfUpdate({ io, mode: 'refresh' }))
      .rejects.toMatchObject({ status: 409, code: 'UPDATE_LAUNCH_FAILED' });
  });

  it('reports a launch that threw, instead of claiming the script started', async () => {
    launchUpdate.mockRejectedValue(new Error('spawn EACCES'));

    await expect(startPortosSelfUpdate({ io, mode: 'refresh' }))
      .rejects.toThrow('spawn EACCES');
  });

  it('resolves once the script is spawned, without waiting for it to finish', async () => {
    // The whole point: update.sh outlives this process, so the launcher must
    // return at the spawn. A promise that only settles when the script is done
    // would never resolve here — the pm2 delete kills the awaiting process.
    let finish;
    launchUpdate.mockResolvedValue({
      started: true, completion: new Promise((resolve) => { finish = resolve; }),
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

  it('observes a rejected completion after returning the successful handoff', async () => {
    let fail;
    launchUpdate.mockResolvedValue({
      started: true, completion: new Promise((_resolve, reject) => { fail = reject; }),
    });
    await expect(startPortosSelfUpdate({ io, mode: 'refresh' }))
      .resolves.toEqual({ started: true, tag: 'v1.26.0' });
    fail(new Error('completion failed'));
    await vi.waitFor(() => expect(updateChecker.setUpdateInProgress).toHaveBeenCalledWith(false));
    expect(io.emit).toHaveBeenCalledWith('portos:update:error', {
      message: 'completion failed', step: 'unknown',
    });
  });

  it('releases the update lock when the launch itself rejects', async () => {
    // The executor clears the flag through recordUpdateResult on refusal and
    // completion; a rejection reports none, and the stuck flag then
    // wedges every later update and every CoS agent spawn (#6036).
    launchUpdate.mockRejectedValue(new Error('spawn EACCES'));

    await startPortosSelfUpdate({ io, mode: 'refresh' }).catch(() => {});

    await vi.waitFor(() => expect(updateChecker.setUpdateInProgress).toHaveBeenCalledWith(false));
    expect(io.emit).toHaveBeenCalledWith('portos:update:error', expect.objectContaining({
      message: 'spawn EACCES',
    }));
  });
});
