import { useCallback, useEffect, useRef, useState } from 'react';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage';
import useMounted from './useMounted';
import socket from '../services/socket';
import * as api from '../services/api';

// Out-of-sync dismissals are keyed by the on-disk commit the advisory was
// raised for, so dismissing it silences THIS half-updated state without
// silencing the next pull. `unknown` covers a tarball install / non-git tree.
const OUT_OF_SYNC_DISMISS_KEY = 'portos:updateChecker:outOfSyncDismissedCommit';

const dismissedCommit = () => safeReadStorage(OUT_OF_SYNC_DISMISS_KEY);

/**
 * Global hook that checks for PortOS updates and reports both a new-version
 * advisory and an "install out of sync" advisory (a bare `git pull` without
 * ./update.sh — issue #1779).
 *
 * It returns state rather than raising toasts: a non-transient advisory must
 * never occlude the current screen's primary action, so Layout renders these
 * as inline banners in normal document flow (issue #3786). At 375px the old
 * `duration: Infinity` corner toast sat permanently on top of bottom-anchored
 * composers and submit buttons.
 *
 * Returns `{ update, outOfSync, ignoreUpdate, dismissUpdate, clearOutOfSync,
 * dismissOutOfSync }`.
 */
export function useUpdateChecker() {
  const [update, setUpdate] = useState(null);
  const [outOfSync, setOutOfSync] = useState(null);
  const mountedRef = useMounted();
  // Versions ignored in THIS session. The server already withholds the
  // `update:available` broadcast for an ignored version, but the ignore POST is
  // in flight while a poll may already be mid-emit — this keeps a just-ignored
  // version from flashing back in on that race.
  const ignoredRef = useRef(new Set());

  useEffect(() => {
    const onUpdateAvailable = (data) => {
      if (!mountedRef.current || ignoredRef.current.has(data.latestVersion)) return;
      setUpdate({ currentVersion: data.currentVersion, latestVersion: data.latestVersion });
    };

    api.getUpdateStatus().then(status => {
      if (!mountedRef.current) return;
      if (status.updateAvailable && status.latestRelease) {
        onUpdateAvailable({
          currentVersion: status.currentVersion,
          latestVersion: status.latestRelease.version
        });
      }
      // Distinct from the release advisory — a half-updated install needs a
      // reconcile (run update.sh), not a version bump.
      if (status.installState?.outOfSync) {
        const commit = status.installState.currentCommit || 'unknown';
        if (dismissedCommit() !== commit) setOutOfSync({ commit });
      }
    }).catch(() => {});

    socket.on('portos:update:available', onUpdateAvailable);
    return () => {
      socket.off('portos:update:available', onUpdateAvailable);
    };
  }, []);

  // The side effects live in the handler, NOT inside a setState updater —
  // React invokes updaters twice under StrictMode, which would double-fire the
  // POST / storage write.
  //
  // "Ignore" is durable server-side (this version never re-raises); "dismiss"
  // only clears it for this session.
  const ignoreUpdate = useCallback(() => {
    if (update) {
      ignoredRef.current.add(update.latestVersion);
      api.ignoreUpdateVersion(update.latestVersion).catch(() => null);
    }
    setUpdate(null);
  }, [update]);

  const dismissUpdate = useCallback(() => setUpdate(null), []);

  // Acting on the advisory (navigating to the update page) clears it for this
  // session only — the install IS still out of sync until update.sh runs, so it
  // must come back on the next load rather than being marked handled.
  const clearOutOfSync = useCallback(() => setOutOfSync(null), []);

  const dismissOutOfSync = useCallback(() => {
    if (outOfSync) safeWriteStorage(OUT_OF_SYNC_DISMISS_KEY, outOfSync.commit);
    setOutOfSync(null);
  }, [outOfSync]);

  return { update, outOfSync, ignoreUpdate, dismissUpdate, clearOutOfSync, dismissOutOfSync };
}

export const __internal = { OUT_OF_SYNC_DISMISS_KEY };
