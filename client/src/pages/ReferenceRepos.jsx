import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GitBranch, ExternalLink } from 'lucide-react';
import * as api from '../services/api';
import { PORTOS_APP_ID } from '../services/apiCore';
import ReferenceReposPanel from '../components/apps/ReferenceReposPanel';

/**
 * Global summary of every reference repo configured across every app.
 *
 * This page is intentionally a *summary* — to add, edit, or delete a ref
 * the user clicks through to the per-app References tab. That keeps the
 * "which app does this ref belong to" decision visible at edit time.
 *
 * What you CAN do here: see status across all refs at a glance, run a
 * "Check now" per ref, mark-as-reviewed, and click into the app for
 * full management.
 */
export default function ReferenceRepos() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  // Distinguish "fetch failed" from "no apps configured" — without this
  // the empty-state message ("No apps have reference repos configured")
  // shows up on every transient server hiccup, which is misleading and
  // sends users hunting for a configuration mistake that doesn't exist.
  const [fetchError, setFetchError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all = await api.getApps().catch((e) => ({ __error: e?.message || 'Failed to load apps' }));
      if (cancelled) return;
      if (all && all.__error) {
        setFetchError(all.__error);
        setLoading(false);
        return;
      }
      const withRefs = (all || []).filter((a) => Array.isArray(a.referenceRepos) && a.referenceRepos.length > 0);
      withRefs.sort((a, b) => {
        if (a.id === PORTOS_APP_ID) return -1;
        if (b.id === PORTOS_APP_ID) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
      setApps(withRefs);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div className="p-6 text-gray-400">Loading reference repos…</div>;
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <GitBranch size={22} /> Reference Repos
        </h1>
        <p className="text-sm text-gray-400 mt-1">
          Upstream repos each app watches for clean-room reimplementation. The <code className="text-port-accent">reference-watch</code> task in CoS scans them on a schedule and writes <code>REFERENCE_REVIEW.md</code> proposals describing features and fixes worth re-building in our own code. We track upstream commits — we don't copy upstream code. Add/remove from each app's References tab.
        </p>
      </div>

      {fetchError ? (
        <div className="bg-port-error/10 border border-port-error/40 rounded-lg p-4 text-port-error text-sm">
          Failed to load apps: {fetchError}. Refresh to retry.
        </div>
      ) : apps.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center text-gray-400">
          <p className="mb-2">No apps have reference repos configured yet.</p>
          <p className="text-sm text-gray-500">
            Open any app from <Link to="/apps" className="text-port-accent hover:underline">Apps</Link> and use its <span className="text-white">References</span> tab to add one.
          </p>
        </div>
      ) : (
        apps.map((app) => (
          <div key={app.id} className="bg-port-bg border border-port-border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-baseline gap-2">
                <h2 className="text-lg font-semibold text-white">{app.name}</h2>
                <span className="text-xs text-gray-500">{app.referenceRepos.length} ref{app.referenceRepos.length === 1 ? '' : 's'}</span>
              </div>
              <Link
                to={`/apps/${app.id}/references`}
                className="text-xs text-port-accent hover:underline inline-flex items-center gap-1"
              >
                Manage <ExternalLink size={12} />
              </Link>
            </div>
            <ReferenceReposPanel appId={app.id} appName={app.name} compact initialRefs={app.referenceRepos} />
          </div>
        ))
      )}
    </div>
  );
}
