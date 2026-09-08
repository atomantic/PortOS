import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

// The regression this file exists for (fork issue #1, final live pass): the
// arming gate — instance feature plus a stored token — used to be read at boot
// and nowhere else, so connecting on a running install left realtime down and
// no sweep registered for as long as the process stayed up, and a disconnect
// left the relay running on a revoked token.
//
// The scheduler side runs for REAL here (real `eventScheduler`, real
// `beeperScheduler`) so "registered" is the scheduler's own answer rather than a
// mock's; only the socket is doubled, since it owns a `ws` connection.
const state = {
  armed: true,
  config: { enabled: true, intervalMinutes: 5 },
};

const socket = {
  running: false,
  starts: 0,
  stops: 0,
  // Both default to an immediate no-op so every existing test below observes
  // exactly the old synchronous mock. The overlapping arm/disarm test further
  // down replaces them for that one case, to force `startBeeperSocket()` to
  // suspend at a known point instead of resolving on the same microtask tick.
  gate: Promise.resolve(),
  onStart: () => {},
};

vi.mock('./beeperSync.js', () => ({
  isBeeperIngestionArmed: async () => state.armed,
  getBeeperSyncConfig: async () => state.config,
  runBeeperSweep: vi.fn(),
}));

vi.mock('./beeperSocket.js', () => ({
  // Same contract as the real module: declines (false) when already running.
  startBeeperSocket: async () => {
    socket.starts += 1;
    socket.onStart();
    await socket.gate;
    if (socket.running) return false;
    socket.running = true;
    return true;
  },
  stopBeeperSocket: () => {
    socket.stops += 1;
    const wasRunning = socket.running;
    socket.running = false;
    return wasRunning;
  },
  isBeeperSocketRunning: () => socket.running,
}));

const { reconcileBeeperIngestion } = await import('./beeperArming.js');
const { runBeeperSweep } = await import('./beeperSync.js');
const { cancel, getEvent } = await import('./eventScheduler.js');

function captureLogs() {
  const lines = [];
  vi.spyOn(console, 'log').mockImplementation((line) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line) => { lines.push(String(line)); });
  return lines;
}

beforeEach(() => {
  state.armed = true;
  state.config = { enabled: true, intervalMinutes: 5 };
  socket.running = false;
  socket.starts = 0;
  socket.stops = 0;
  socket.gate = Promise.resolve();
  socket.onStart = () => {};
  runBeeperSweep.mockClear();
});

afterEach(() => {
  cancel('beeper-sync');
  vi.restoreAllMocks();
});

describe('reconcileBeeperIngestion', () => {
  it('arms the transport and the sweep when a credential lands on a running install', async () => {
    captureLogs();

    const result = await reconcileBeeperIngestion({ reason: 'oauth-connect' });

    expect(socket.running).toBe(true);
    expect(getEvent('beeper-sync')).toBeTruthy();
    expect(result).toMatchObject({ armed: true, socketRunning: true, schedulerRegistered: true, changed: true });
  });

  it('is idempotent — a repeat call restarts nothing and does not push the next sweep out', async () => {
    captureLogs();
    await reconcileBeeperIngestion({ reason: 'oauth-connect' });
    const firstRun = getEvent('beeper-sync').nextRunAt;

    const result = await reconcileBeeperIngestion({ reason: 'feature-toggle' });

    // `eventScheduler.schedule` cancels and replaces an event with the same id,
    // resetting `nextRunAt` a whole interval into the future. Re-registering on
    // every unrelated toggle would keep the sweep permanently five minutes away.
    expect(getEvent('beeper-sync').nextRunAt).toBe(firstRun);
    expect(socket.running).toBe(true);
    expect(result.changed).toBe(false);
  });

  it('arms the transport but registers no sweep while the user has scheduled sync off', async () => {
    // The two flags stay distinct (#11): the feature+token gate arms the
    // transport, `settings.beeper.enabled` is the ingestion opt-in.
    state.config = { enabled: false, intervalMinutes: 5 };
    captureLogs();

    const result = await reconcileBeeperIngestion({ reason: 'oauth-connect' });

    expect(socket.running).toBe(true);
    expect(getEvent('beeper-sync')).toBeFalsy();
    expect(result).toMatchObject({ armed: true, schedulerRegistered: false });
  });

  it('stops the relay and cancels the sweep when the credential is deleted', async () => {
    captureLogs();
    await reconcileBeeperIngestion({ reason: 'oauth-connect' });
    expect(socket.running).toBe(true);

    state.armed = false;
    const result = await reconcileBeeperIngestion({ reason: 'disconnect' });

    expect(socket.running).toBe(false);
    expect(getEvent('beeper-sync')).toBeFalsy();
    expect(result).toMatchObject({ armed: false, socketRunning: false, schedulerRegistered: false, changed: true });
  });

  it('does nothing and says nothing on an install that was never armed', async () => {
    // #32's acceptance: with the feature off or no token, nothing registers and
    // nothing logs — a fresh install must not narrate a feature it does not have.
    state.armed = false;
    const logs = captureLogs();

    const result = await reconcileBeeperIngestion({ reason: 'feature-toggle' });

    expect(getEvent('beeper-sync')).toBeFalsy();
    expect(socket.running).toBe(false);
    expect(result.changed).toBe(false);
    expect(logs).toEqual([]);
  });

  it('serializes overlapping triggers so a toggle landing mid-connect cannot double-arm', async () => {
    captureLogs();

    await Promise.all([
      reconcileBeeperIngestion({ reason: 'oauth-connect' }),
      reconcileBeeperIngestion({ reason: 'feature-toggle' }),
    ]);

    expect(socket.running).toBe(true);
    // Two calls into the transport, but only the first one started it.
    expect(socket.starts).toBe(2);
    expect(getEvent('beeper-sync')).toBeTruthy();
  });

  // The serialization case an arm+arm race does not stress: two OPPOSITE
  // triggers landing in the same tick. Without the `tail` queue in
  // `reconcileBeeperIngestion`, both calls' `reconcileOnce()` run concurrently
  // instead of one fully finishing before the next starts, and whichever one's
  // async chain happens to settle LAST wins — not whichever was issued last.
  // Here that would leave the socket running and the sweep registered even
  // though `disconnect` (issued second) is the trigger that should have had
  // the final say.
  //
  // This is proved by temporarily removing the queue: replace
  // `reconcileBeeperIngestion`'s body in beeperArming.js with
  // `return reconcileOnce(reason);` and re-run this file. The socket stays
  // running (asserted false below) because the arm call's `startBeeperSocket()`
  // — parked on `socket.gate` until this test releases it — resumes and starts
  // the socket AFTER the disarm call has already run and found nothing to stop.
  // Restore the `tail.then(run, run)` body afterward; this test passes again
  // once it is back.
  it('lets a disarm issued while an arm is still starting the socket win the final state', async () => {
    captureLogs();
    let releaseSocket;
    socket.gate = new Promise((resolve) => { releaseSocket = resolve; });
    const socketStartSeen = new Promise((resolve) => { socket.onStart = resolve; });

    // `state.armed` is read again inside `reconcileOnce` — flipping it here
    // (once the arm call has already captured `true` and is parked inside
    // `startBeeperSocket()`) is what makes the disarm call, issued next, a
    // genuine disarm rather than a second arm.
    const armPromise = reconcileBeeperIngestion({ reason: 'oauth-connect' });
    await socketStartSeen;
    state.armed = false;
    const disarmPromise = reconcileBeeperIngestion({ reason: 'disconnect' });
    releaseSocket();

    await Promise.all([armPromise, disarmPromise]);

    expect(socket.running).toBe(false);
    expect(getEvent('beeper-sync')).toBeFalsy();
  });

  // Pins the arming-level half of the settings-route sync-toggle fix
  // (server/routes/settings.js): saving `settings.beeper.enabled` now calls
  // `reconcileBeeperIngestion({ reason: 'sync-toggle' })` when the flag
  // actually changes. Registering the sweep on that call is this module's
  // job; STOPPING it on a false flip is not — `reconcileOnce` only disarms
  // when the feature+token gate itself is false, so a sync-toggle reconcile
  // with the gate still armed must leave an already-running sweep alone. The
  // scheduler's own per-tick `getBeeperSyncConfig()` re-read is what actually
  // stops runs in that case (see server/routes/settings.test.js's
  // true→false case for the route side of this).
  it('registers the scheduler on a sync-toggle reconcile when enabled is true, but does not stop it when enabled flips false while still armed', async () => {
    captureLogs();

    const armedResult = await reconcileBeeperIngestion({ reason: 'sync-toggle' });

    expect(socket.running).toBe(true);
    expect(getEvent('beeper-sync')).toBeTruthy();
    expect(armedResult).toMatchObject({ armed: true, schedulerRegistered: true, changed: true });

    // The gate (feature + token) stays armed; only the user's own sync opt-in
    // flips off. A reconcile here must not disarm anything.
    state.config = { enabled: false, intervalMinutes: 5 };
    const disabledResult = await reconcileBeeperIngestion({ reason: 'sync-toggle' });

    expect(getEvent('beeper-sync')).toBeTruthy();
    expect(socket.running).toBe(true);
    expect(disabledResult.changed).toBe(false);
  });

  // Fork issue #79: before this, connecting (or flipping a feature/sync
  // toggle on) registered the interval timer but fired nothing until a full
  // interval had elapsed. This fails on the old code — which never called
  // `runBeeperSweep` from `reconcileOnce` at all.
  describe('immediate sweep on arm (#79)', () => {
    it('kicks one sweep immediately when a reconcile newly registers the scheduler', async () => {
      captureLogs();

      await reconcileBeeperIngestion({ reason: 'oauth-connect' });

      expect(runBeeperSweep).toHaveBeenCalledTimes(1);
      expect(runBeeperSweep).toHaveBeenCalledWith({ reason: 'arm' });
    });

    it('does not kick a second sweep on a reconcile that finds the scheduler already registered', async () => {
      captureLogs();
      await reconcileBeeperIngestion({ reason: 'oauth-connect' });
      runBeeperSweep.mockClear();

      await reconcileBeeperIngestion({ reason: 'feature-toggle' });

      expect(runBeeperSweep).not.toHaveBeenCalled();
    });

    it('does not kick a sweep when the gate is armed but the user has scheduled sync off', async () => {
      state.config = { enabled: false, intervalMinutes: 5 };
      captureLogs();

      await reconcileBeeperIngestion({ reason: 'oauth-connect' });

      expect(getEvent('beeper-sync')).toBeFalsy();
      expect(runBeeperSweep).not.toHaveBeenCalled();
    });

    it('does not kick a sweep on disarm', async () => {
      captureLogs();
      await reconcileBeeperIngestion({ reason: 'oauth-connect' });
      runBeeperSweep.mockClear();

      state.armed = false;
      await reconcileBeeperIngestion({ reason: 'disconnect' });

      expect(runBeeperSweep).not.toHaveBeenCalled();
    });

    // A rejected kick is logged, not thrown — the fire-and-forget promise
    // must never turn a completed arm into a caller-visible failure.
    it('logs rather than throws when the kicked sweep rejects', async () => {
      runBeeperSweep.mockRejectedValueOnce(new Error('boom'));
      const logs = captureLogs();

      const result = await reconcileBeeperIngestion({ reason: 'oauth-connect' });

      expect(result.armed).toBe(true);
      // Give the unawaited rejection's `.catch` a turn of the microtask queue.
      await Promise.resolve();
      await Promise.resolve();
      expect(logs.some((line) => line.includes('immediate sweep on arm failed'))).toBe(true);
    });
  });
});
