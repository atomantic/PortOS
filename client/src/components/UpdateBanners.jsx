import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router';
import Banner from './ui/Banner';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { useUpdateChecker } from '../hooks/useUpdateChecker';
import * as api from '../services/api';

// A non-transient advisory must never occlude the current screen's primary
// action (#3786), so these render in normal document flow above <main> and
// push the page down instead of floating over a bottom-anchored composer.
export default function UpdateBanners() {
  const navigate = useNavigate();
  const {
    update, outOfSync, ignoreUpdate, dismissUpdate, clearOutOfSync, dismissOutOfSync
  } = useUpdateChecker();

  const hasAdvisory = Boolean(update || outOfSync);
  const { data: processing } = useAutoRefetch(() => api.getActiveProcessing({ silent: true }), 3000, {
    enabled: hasAdvisory,
  });
  // Keep advisories pending until activity is known and jobs have drained.
  // Hiding must not dismiss them: they become actionable again when idle.
  const jobsActive = processing?.agents?.active > 0
    || processing?.jobs?.length > 0
    || processing?.extras?.imageTo3d?.length > 0;
  if (!hasAdvisory || !processing || jobsActive) return null;

  const goToUpdate = () => navigate(`/apps/${api.PORTOS_APP_ID}/update`);

  return (
    <div className="shrink-0 px-3 pt-2 flex flex-col gap-2 print:hidden">
      {outOfSync ? (
        <Banner
          tone="warning"
          icon={AlertTriangle}
          align="center"
          role="status"
          actions={
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { clearOutOfSync(); goToUpdate(); }}
                className="min-h-[44px] px-2 py-2 bg-port-warning text-black text-xs rounded hover:bg-port-warning/80 lg:min-h-0 lg:py-1"
              >
                Reconcile
              </button>
              <button
                type="button"
                onClick={dismissOutOfSync}
                className="min-h-[44px] px-2 py-2 bg-gray-600 text-white text-xs rounded hover:bg-gray-500 lg:min-h-0 lg:py-1"
              >
                Dismiss
              </button>
            </div>
          }
        >
          Install out of sync — you pulled new code but haven’t reconciled it.
        </Banner>
      ) : null}
      {update ? (
        <Banner
          tone="info"
          icon={RefreshCw}
          align="center"
          role="status"
          actions={
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { dismissUpdate(); goToUpdate(); }}
                className="min-h-[44px] px-2 py-2 bg-port-accent text-white text-xs rounded hover:bg-port-accent/80 lg:min-h-0 lg:py-1"
              >
                Update
              </button>
              <button
                type="button"
                onClick={ignoreUpdate}
                className="min-h-[44px] px-2 py-2 bg-gray-600 text-white text-xs rounded hover:bg-gray-500 lg:min-h-0 lg:py-1"
              >
                Ignore
              </button>
            </div>
          }
        >
          Update available: <strong>v{update.currentVersion}</strong> → <strong>v{update.latestVersion}</strong>
        </Banner>
      ) : null}
    </div>
  );
}
