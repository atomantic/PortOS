import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import * as api from '../services/api';

const TOAST_ID = 'portos-update-available';

/**
 * Global hook that checks for PortOS updates and shows a persistent toast
 * when a new version is available. Runs in Layout alongside useErrorNotifications.
 */
export function useUpdateChecker() {
  const navigate = useNavigate();

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
                  navigate(`/apps/${api.PORTOS_APP_ID}/update`);
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

    // Check status on mount
    api.getUpdateStatus().then(status => {
      if (status.updateAvailable && status.latestRelease) {
        showUpdateToast({
          currentVersion: status.currentVersion,
          latestVersion: status.latestRelease.version
        });
      }
    }).catch(() => {});

    // Listen for real-time update available events
    socket.on('portos:update:available', showUpdateToast);

    return () => {
      socket.off('portos:update:available', showUpdateToast);
    };
  }, [navigate]);
}
