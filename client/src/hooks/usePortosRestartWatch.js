import { useCallback, useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import * as api from '../services/api';
import { useAutoRefetch } from './useAutoRefetch';
import useMounted from './useMounted';

const POLL_MS = 2000;
// The watch has two phases with wildly different budgets, so one flat ceiling is
// wrong for both. Until the server is seen DOWN the update has not reached
// `pm2-stop` — or the launch failed outright — and a stall there should be
// reported quickly rather than parked under an indefinite "restarting" toast.
// Once it IS down, the poll has to outlast the window it stays down: `pm2-stop`
// through the client build is npm install + setup + migrations + build, minutes
// on a warm tree and tens of them on a cold `node_modules`. The old flat 60s
// budget was the second phase measured with the first phase's ruler, so every
// real update timed out while it was still going fine in the background (#6169).
//
// Budgets are wall clock, not attempt counts: `useAutoRefetch` skips its tick
// while the tab is hidden, so counting attempts would silently stretch the
// ceiling by however long PortOS sat in a background tab.
const DOWN_WAIT_MS = 60 * 1000;
const RECOVERY_TIMEOUT_MS = 30 * 60 * 1000;
// A raw 'disconnect' is not proof the update tore the process down — PortOS is
// commonly used remotely over Tailscale, and a network blip during the early
// steps (git-pull/submodules, while the server is very much alive) fires one
// too. Confirm the server is actually unreachable before arming.
const DISCONNECT_CONFIRM_MS = 1500;
// Slack absorbing clock jitter when comparing the server's post-restart uptime
// against its pre-restart peak.
const UPTIME_DROP_SLACK_S = 5;
const TOAST_ID = 'portos-update-restart';

/**
 * Watch for PortOS restarting itself, and reload the page once it is back.
 *
 * Any surface that launches a PortOS self-update needs this, because there is
 * no completion event to wait for: `update.sh` runs `pm2 delete
 * ecosystem.config.cjs` partway through, so the server — and this socket — die
 * well before the script reaches its 'restart' step. Without this watch the UI
 * simply hangs on "Stopping apps..." forever while the update finishes fine in
 * the background. The server side of that contract is
 * `server/services/portosSelfUpdate.js`.
 *
 * `useAppOperation` wires this for every App Management surface, so a component
 * updating an app gets it without asking. Call it directly only from a surface
 * that launches a self-update WITHOUT going through an app operation — today
 * just the Update page.
 *
 * Detection is deliberately over-determined, because a reconcile often lands
 * the SAME version (new commits, no release bump) and its restart can be too
 * fast for a 2s poll to ever sample the down window:
 *   - the version reported by /api/system/health differs from before, OR
 *   - health went down and came back, OR
 *   - the server's uptime reset below its pre-restart peak.
 *
 * @param {object} options
 * @param {boolean} [options.enabled] - false skips the socket subscriptions entirely
 * @param {boolean} [options.active] - an update this surface launched is in flight
 * @param {() => void} [options.onRestart] - the restart was detected; stop treating the update as in-flight
 * @param {(detail: {message: string|null}) => void} [options.onFailure] - the update reported failure instead
 * @returns {{polling: boolean, captureBaseline: (currentVersion?: string|null) => Promise<void>, arm: (opts?: {healthDown?: boolean}) => void}}
 */
export function usePortosRestartWatch({ enabled = true, active = false, onRestart, onFailure } = {}) {
  const [polling, setPolling] = useState(false);
  const mountedRef = useMounted();
  const activeRef = useRef(active);
  const pollingRef = useRef(false);
  const pollStartedAtRef = useRef(0);
  const preUpdateVersionRef = useRef(null);
  // Whether health went down during this poll cycle — a down→up transition is
  // what proves a same-version reconcile actually restarted.
  const healthWentDownRef = useRef(false);
  // Highest uptime seen so far, seeded by captureBaseline from the still-running
  // server so even an instant restart reads as a drop.
  const maxUptimeRef = useRef(0);
  const callbacksRef = useRef({ onRestart, onFailure });

  useEffect(() => { callbacksRef.current = { onRestart, onFailure }; });
  useEffect(() => { activeRef.current = active; }, [active]);

  const captureBaseline = useCallback(async (currentVersion = null) => {
    const preHealth = await api.checkHealth().catch(() => null);
    preUpdateVersionRef.current = currentVersion || preHealth?.version || null;
    maxUptimeRef.current = typeof preHealth?.uptime === 'number' ? preHealth.uptime : 0;
  }, []);

  // "The server is (or is about to be) restarting — stop trusting the socket and
  // start polling." `activeRef` is cleared SYNCHRONOUSLY (not just via the
  // syncing effect, which only runs after the next commit) so a 'disconnect'
  // arriving in the same tick right after this can't read a stale `true`.
  // `healthDown` carries an already-CONFIRMED down observation into the poll.
  // The disconnect path proves the server is unreachable before it arms, and on
  // a same-version reconcile with no baseline (a page that adopted an update it
  // did not start) that proof is the only restart evidence there is. Today the
  // poll re-establishes it anyway, because `useAutoRefetch` fires once
  // immediately on enable while the server is still down — but that makes this
  // hook's correctness depend on another hook's `immediate` default. Carrying
  // the observation forward costs nothing and severs that link.
  const arm = useCallback(({ healthDown = false } = {}) => {
    if (pollingRef.current) return;
    activeRef.current = false;
    pollingRef.current = true;
    pollStartedAtRef.current = Date.now();
    healthWentDownRef.current = healthDown;
    setPolling(true);
    toast.loading('PortOS is restarting...', { id: TOAST_ID, duration: Infinity });
    callbacksRef.current.onRestart?.();
  }, []);

  const stopPolling = useCallback(() => {
    pollingRef.current = false;
    setPolling(false);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    const fail = (message) => {
      activeRef.current = false;
      stopPolling();
      toast.dismiss(TOAST_ID);
      callbacksRef.current.onFailure?.({ message });
    };

    const handleStep = ({ step, status }) => {
      // The PM2 restart may kill the server before portos:update:complete fires,
      // so this step is usually the last thing that reaches us.
      if ((step === 'restarting' || step === 'restart') && status !== 'error' && activeRef.current) arm();
    };

    const handleComplete = ({ success }) => {
      if (success === false) {
        fail(null);
        return;
      }
      if (activeRef.current) arm();
    };

    const handleError = ({ message }) => fail(message || 'Update failed');

    const handleDisconnect = () => {
      if (!activeRef.current) return;
      setTimeout(async () => {
        if (!activeRef.current || !mountedRef.current) return;
        // silent: true — a failed check here just means "confirmed, arm
        // polling"; the generic "Server unreachable" toast would otherwise fire
        // right alongside (and ahead of) the intended "restarting" toast on the
        // exact real-disconnect case this confirmation exists for.
        const ok = await api.checkHealth({ silent: true }).catch(() => null);
        if (!ok && activeRef.current && mountedRef.current) arm({ healthDown: true });
      }, DISCONNECT_CONFIRM_MS);
    };

    socket.on('portos:update:step', handleStep);
    socket.on('portos:update:complete', handleComplete);
    socket.on('portos:update:error', handleError);
    socket.on('disconnect', handleDisconnect);

    return () => {
      socket.off('portos:update:step', handleStep);
      socket.off('portos:update:complete', handleComplete);
      socket.off('portos:update:error', handleError);
      socket.off('disconnect', handleDisconnect);
    };
  }, [arm, enabled, mountedRef, stopPolling]);

  const pollHealth = useCallback(async () => {
    // silent: true — the server being unreachable is the EXPECTED state for most
    // of this poll (that's the down→up transition it watches for), not an error;
    // the generic toast would spam "Server unreachable" every 2s throughout the
    // "PortOS is restarting..." loading toast's own lifetime.
    const ok = await api.checkHealth({ silent: true }).catch(() => null);
    const preUpdateVersion = preUpdateVersionRef.current;
    if (!ok) {
      // Server is mid-restart (PM2 stopped it) — record the dip so a
      // same-version recovery still counts as "restarted".
      healthWentDownRef.current = true;
    } else if (preUpdateVersion && ok.version && ok.version !== preUpdateVersion) {
      // The running version differs from before the update — restart confirmed.
      stopPolling();
      toast.success(`Updated to v${ok.version}`, { id: TOAST_ID });
      setTimeout(() => window.location.reload(), 1000);
      return;
    } else if (
      ok.version &&
      (healthWentDownRef.current ||
        (typeof ok.uptime === 'number' && ok.uptime < maxUptimeRef.current - UPTIME_DROP_SLACK_S))
    ) {
      // Same version, but the restart is proven either by a down→up dip or by
      // the uptime resetting below its pre-restart peak.
      stopPolling();
      toast.success('Install reconciled — reloading', { id: TOAST_ID });
      setTimeout(() => window.location.reload(), 1000);
      return;
    }
    // Track the running peak so a later uptime drop is detectable. Guard on
    // `ok` — the server-down branch falls through to here, and a null deref
    // would throw before the timeout check below, hanging the UI on a restart
    // that never recovers.
    if (ok && typeof ok.uptime === 'number' && ok.uptime > maxUptimeRef.current) {
      maxUptimeRef.current = ok.uptime;
    }
    // Checked LAST, so a tick arriving after a long hidden-tab gap still gets
    // to recognize a finished restart above before the budget applies.
    const budget = healthWentDownRef.current ? RECOVERY_TIMEOUT_MS : DOWN_WAIT_MS;
    if (Date.now() - pollStartedAtRef.current >= budget) {
      stopPolling();
      toast.error(healthWentDownRef.current
        ? 'Restart timed out — try reloading manually'
        : 'PortOS never went down — the update may not have started', { id: TOAST_ID });
    }
  }, [stopPolling]);

  useAutoRefetch(pollHealth, POLL_MS, { enabled: polling, pollOnly: true });

  return { polling, captureBaseline, arm };
}
