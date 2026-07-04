import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import * as api from '../services/api';

const TOAST_ID = 'portos-update-available';
const OUT_OF_SYNC_TOAST_ID = 'portos-install-out-of-sync';

/**
 * Global hook that checks for PortOS updates and shows a persistent toast
 * when a new version is available, plus a distinct toast when the install is
 * out of sync (a bare `git pull` without ./update.sh — issue #1779). Runs in
 * Layout alongside useErrorNotifications.
 */
export function useUpdateChecker() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const showUpdateToast = (data) => {
      toast(
        (t) => (
          <div className="flex flex-col gap-2">
            <span className="text-sm">
              Update available: <strong>v{data.currentVersion}</strong> → <strong>v{data.latestVersion}</strong>
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  toast.dismiss(t.id);
                  navigateRef.current(`/apps/${api.PORTOS_APP_ID}/update`);
                }}
                className="px-2 py-1 bg-port-accent text-white text-xs rounded hover:bg-port-accent/80"
              >
                Update
              </button>
              <button
                onClick={() => {
                  api.ignoreUpdateVersion(data.latestVersion).catch(() => null);
                  toast.dismiss(t.id);
                }}
                className="px-2 py-1 bg-gray-600 text-white text-xs rounded hover:bg-gray-500"
              >
                Ignore
              </button>
            </div>
          </div>
        ),
        {
          id: TOAST_ID,
          duration: Infinity,
          icon: '🔄'
        }
      );
    };

    const showOutOfSyncToast = () => {
      toast(
        (t) => (
          <div className="flex flex-col gap-2">
            <span className="text-sm">
              Install out of sync — you pulled new code but haven’t reconciled it.
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  toast.dismiss(t.id);
                  navigateRef.current(`/apps/${api.PORTOS_APP_ID}/update`);
                }}
                className="px-2 py-1 bg-port-warning text-black text-xs rounded hover:bg-port-warning/80"
              >
                Reconcile
              </button>
              <button
                onClick={() => toast.dismiss(t.id)}
                className="px-2 py-1 bg-gray-600 text-white text-xs rounded hover:bg-gray-500"
              >
                Dismiss
              </button>
            </div>
          </div>
        ),
        {
          id: OUT_OF_SYNC_TOAST_ID,
          duration: Infinity,
          icon: '⚠️'
        }
      );
    };

    // Check status on mount
    api.getUpdateStatus().then(status => {
      if (status.updateAvailable && status.latestRelease) {
        showUpdateToast({
          currentVersion: status.currentVersion,
          latestVersion: status.latestRelease.version
        });
      }
      // Distinct from the release toast — a half-updated install needs a
      // reconcile (run update.sh), not a version bump.
      if (status.installState?.outOfSync) {
        showOutOfSyncToast();
      }
    }).catch(() => {});

    // Listen for real-time update available events
    socket.on('portos:update:available', showUpdateToast);

    return () => {
      socket.off('portos:update:available', showUpdateToast);
    };
  }, []);
}
