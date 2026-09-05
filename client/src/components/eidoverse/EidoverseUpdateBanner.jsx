import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import Banner from '../ui/Banner';
import AppOperationBanner from '../apps/AppOperationBanner';
import { useAppOperation } from '../../hooks/useAppOperation';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';
import {
  describeRepositorySourcesBehind,
  primaryRepositorySource,
  repositoryForkNeedsSync,
} from '../../lib/managedAppSources';
import { getAppRepositorySources } from '../../services/api';

// Keyed by app id so a reinstall — which mints a new managed-app record —
// drops a dismissal that was about the old checkout.
const dismissKey = (appId) => `portos:eidoverse:updateDismissedRevision:${appId}`;

const WRAPPER_CLS = 'shrink-0 px-3 pt-2 print:hidden';

/**
 * Which upstream state the advisory was raised for. Dismissing silences THIS
 * revision — the same shape `useUpdateChecker` uses for the PortOS out-of-sync
 * banner — so a later Eidoverse release raises it again rather than being
 * swallowed by an old dismissal.
 */
const revisionSignature = (sources = []) => sources
  .map((source) => `${source.id}@${source.origin?.head || 'unknown'}+${source.forkVsUpstream?.behind || 0}`)
  .join('|');

/**
 * Out-of-date advisory for the Eidoverse checkouts, shown on the Eidoverse page.
 *
 * The managed app's Git tab already reports the full Worlds/Video topology, but
 * a user living in the world never goes there — so the freshness check runs
 * when they open Eidoverse, and the update is one click from here. It reuses
 * the same `repository-sources` read and the same managed-update dispatch as
 * that tab, so there is one definition of "behind" and one update path.
 *
 * The check is deliberately scoped to this page rather than added to the global
 * `UpdateBanners`: it costs a `git fetch` on two checkouts plus GitHub fork
 * metadata, which is not something every screen should pay for. The server
 * skips the fetch for refs it refreshed inside its freshness window
 * (`inspectCheckout` in `server/services/managedAppRepositories.js`), so a
 * StrictMode double-mount or a quick navigate-away-and-back is free.
 */
export default function EidoverseUpdateBanner({ appId, appName = 'Eidoverse Worlds', onUpdated }) {
  const [status, setStatus] = useState(null);
  const [dismissedRevision, setDismissedRevision] = useState(() => safeReadStorage(dismissKey(appId)));

  const check = useCallback(() => {
    if (!appId) return;
    // A failed check reports nothing: an unreachable remote means "unknown",
    // and nagging about an update PortOS could not confirm is worse than
    // staying quiet until the next visit.
    getAppRepositorySources(appId, { silent: true }).then(setStatus, () => setStatus(null));
  }, [appId]);

  useEffect(() => {
    check();
  }, [check]);

  const handleOperationComplete = useCallback(() => {
    check();
    onUpdated?.();
  }, [check, onUpdated]);

  const {
    steps,
    isOperating,
    error: operationError,
    completed,
    startUpdate,
  } = useAppOperation({ appId, onComplete: handleOperationComplete });

  if (isOperating || operationError || completed) {
    return (
      <div className={WRAPPER_CLS}>
        <AppOperationBanner
          appName={appName}
          type="update"
          steps={steps}
          error={operationError}
          completed={completed}
          completedMessage="Eidoverse restarted with the new code."
        />
      </div>
    );
  }

  if (!status?.updateAvailable) return null;
  const sources = status.sources || [];
  const revision = revisionSignature(sources);
  if (dismissedRevision === revision) return null;

  const behind = describeRepositorySourcesBehind(sources);
  const syncFork = repositoryForkNeedsSync(primaryRepositorySource(sources));

  const dismiss = () => {
    safeWriteStorage(dismissKey(appId), revision);
    setDismissedRevision(revision);
  };

  return (
    <div className={WRAPPER_CLS}>
      <Banner
        tone="info"
        icon={RefreshCw}
        role="status"
        actions={
          <div className="flex gap-2">
            {/* A short visible label keeps both actions on one row at 360px;
                the accessible name still says what is being updated. */}
            <button
              type="button"
              aria-label={`Update ${appName}`}
              onClick={() => startUpdate(appId, appName, { syncFork })}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded bg-port-accent px-2 py-2 text-xs text-white hover:bg-port-accent/80 lg:min-h-0 lg:py-1"
            >
              <Download size={13} aria-hidden="true" />
              Update
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="min-h-[44px] rounded bg-gray-600 px-2 py-2 text-xs text-white hover:bg-gray-500 lg:min-h-0 lg:py-1"
            >
              Dismiss
            </button>
          </div>
        }
      >
        Eidoverse update available — {behind.length ? `${behind.join('; ')}.` : 'new commits are waiting upstream.'}{' '}
        Updating pulls the Worlds and Video checkouts and restarts Eidoverse.{' '}
        <Link to={`/apps/${appId}/git`} className="underline">Repository details</Link>
      </Banner>
    </div>
  );
}
