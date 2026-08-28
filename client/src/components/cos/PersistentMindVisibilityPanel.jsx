import { CheckCircle2, CircleAlert, CircleHelp, ExternalLink, RefreshCw, Settings2 } from 'lucide-react';
import { Link } from 'react-router';
import { formatDateTime } from '../../utils/formatters.js';

const readinessLabel = (readiness) => {
  if (readiness === 'ready') return 'Ready';
  if (readiness === 'degraded') return 'Degraded';
  if (readiness === 'blocked') return 'Blocked';
  return 'Unknown';
};

const readinessClass = (readiness) => {
  if (readiness === 'ready') return 'text-port-success';
  if (readiness === 'degraded') return 'text-port-warning';
  if (readiness === 'blocked') return 'text-port-error';
  return 'text-port-text-muted';
};

const ReadinessIcon = ({ readiness }) => {
  if (readiness === 'ready') return <CheckCircle2 size={15} aria-hidden="true" />;
  if (readiness === 'unknown') return <CircleHelp size={15} aria-hidden="true" />;
  return <CircleAlert size={15} aria-hidden="true" />;
};

const REPAIR_ACTIONS = Object.freeze({
  dependencies: { label: 'Open app settings', href: (appId) => `/apps/${encodeURIComponent(appId)}/overview?edit=1&appTab=general` },
  engines: { label: 'Open app settings', href: (appId) => `/apps/${encodeURIComponent(appId)}/overview?edit=1&appTab=general` },
  submodules: { label: 'Manage submodules', href: (appId) => `/apps/${encodeURIComponent(appId)}/submodules` },
  forge: { label: 'Open app Git settings', href: (appId) => `/apps/${encodeURIComponent(appId)}/git` },
  reviewers: { label: 'Manage reviewers', href: () => '/settings/code-reviewers' },
  preflight: { label: 'Open app settings', href: (appId) => `/apps/${encodeURIComponent(appId)}/overview?edit=1&appTab=general` },
});

const blockingWarnings = (preflight) => (Array.isArray(preflight?.warnings) ? preflight.warnings : [])
  .filter((warning) => warning?.severity !== 'advisory' && REPAIR_ACTIONS[warning?.check]);

const checkLabel = (preflight, check) => {
  const hasWorkspace = Array.isArray(preflight.workspaces) && preflight.workspaces.length > 0;
  if (check === 'dependencies') return hasWorkspace && !preflight.workspaces.some((workspace) => workspace.dependencies?.status !== 'installed') ? 'Dependencies available' : 'Dependencies need attention';
  if (check === 'engines') return hasWorkspace && !preflight.workspaces.some((workspace) => ['incompatible', 'unknown'].includes(workspace.engines?.node?.status) || ['incompatible', 'unknown'].includes(workspace.engines?.packageManager?.status)) ? 'Engines compatible' : 'Engine compatibility needs attention';
  if (check === 'submodules') return preflight.submodules?.status === 'initialized' || preflight.submodules?.status === 'not-configured' ? 'Submodules ready' : 'Submodules need attention';
  if (check === 'forge') return preflight.forge?.status === 'ready' ? 'Forge access available' : 'Forge access needs attention';
  if (check === 'reviewers') return preflight.reviewers?.required?.status === 'ready' ? 'Required reviewers available' : 'Reviewer availability needs attention';
  return null;
};

export default function PersistentMindVisibilityPanel({ visibility, error, loading, onRefresh }) {
  const workspaces = Array.isArray(visibility?.workspaces) ? visibility.workspaces : [];
  const readiness = visibility?.readiness || 'unknown';
  const warnings = workspaces.flatMap((workspace) => workspace.preflight?.warnings || []);
  const uniqueWarnings = warnings.filter((warning, index, values) => values.findIndex((candidate) => candidate.code === warning.code) === index);

  return (
    <section aria-label="Persistent mind environment visibility" className="rounded border border-port-border bg-port-card p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-port-accent">Environment visibility</h3>
          <p className="mt-1 text-xs text-port-text-muted">Read-only workspace facts used before the mind queues delegated work.</p>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex items-center justify-center gap-1.5 rounded border border-port-border px-2.5 py-1.5 text-xs font-medium text-port-text hover:bg-port-border/20 disabled:cursor-not-allowed disabled:opacity-60">
          <RefreshCw size={13} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className={`inline-flex items-center gap-1.5 font-semibold ${readinessClass(readiness)}`}>
          <ReadinessIcon readiness={readiness} />
          {readinessLabel(readiness)}
        </span>
        <span className="text-port-text-muted">
          Captured {visibility?.capturedAt ? formatDateTime(visibility.capturedAt) : '—'} · {visibility?.freshness?.state || 'unknown'} snapshot
        </span>
        {visibility?.truncated && <span className="text-port-warning">Some checks were bounded before completion.</span>}
      </div>

      {readiness === 'blocked' && (
        <div role="alert" className="mt-3 flex flex-col gap-2 rounded border border-port-error/40 bg-port-error/10 p-3 text-xs text-port-text sm:flex-row sm:items-center sm:justify-between">
          <p><span className="font-semibold text-port-error">Delegated work is blocked.</span> Repair a required check below, or change the mind&apos;s managed-app permissions.</p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link to="/cos/tools" className="inline-flex items-center gap-1 rounded border border-port-accent px-2.5 py-1.5 font-medium text-port-accent hover:bg-port-accent/10">
              <Settings2 size={13} aria-hidden="true" /> Manage permissions
            </Link>
            <Link to="/apps" className="inline-flex items-center gap-1 rounded border border-port-border px-2.5 py-1.5 font-medium text-port-text-muted hover:border-port-accent hover:text-port-accent">
              Managed apps <ExternalLink size={13} aria-hidden="true" />
            </Link>
          </div>
        </div>
      )}

      {workspaces.length > 0 ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {workspaces.map((workspace) => {
            const workspaceReadiness = workspace.readiness || 'unknown';
            const preflight = workspace.preflight || {};
            const repairs = blockingWarnings(preflight);
            return (
              <article key={workspace.appId || workspace.appName} className="rounded border border-port-border/80 p-3" aria-label={`${workspace.appName || 'Workspace'} preflight`}>
                <div className="flex items-center justify-between gap-2">
                  <h4 className="min-w-0 truncate text-sm font-medium text-port-text">{workspace.appName || 'Workspace'}</h4>
                  <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${readinessClass(workspaceReadiness)}`}>
                    <ReadinessIcon readiness={workspaceReadiness} />
                    {readinessLabel(workspaceReadiness)}
                  </span>
                </div>
                <div className="mt-2 grid gap-1 text-xs text-port-text-muted sm:grid-cols-2">
                  {['dependencies', 'engines', 'submodules', 'forge', 'reviewers'].map((check) => (
                    <span key={check}>{checkLabel(preflight, check)}</span>
                  ))}
                </div>
                {(workspaceReadiness === 'blocked' || workspaceReadiness === 'unknown') && (
                  <div className="mt-2 rounded border border-port-warning/30 bg-port-warning/10 p-2 text-xs text-port-warning">
                    <p>{workspaceReadiness === 'blocked' ? 'A required workspace check must be repaired before this task can run.' : 'A workspace probe could not complete. Refresh or repair the unavailable check before requiring it.'}</p>
                    {repairs.length > 0 && (
                      <ul className="mt-2 space-y-1.5">
                        {repairs.map((warning) => {
                          const action = REPAIR_ACTIONS[warning.check];
                          return (
                            <li key={warning.code} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                              <span>{warning.message}</span>
                              <Link to={action.href(workspace.appId)} className="inline-flex shrink-0 items-center gap-1 font-medium text-port-accent hover:underline">
                                {action.label} <ExternalLink size={12} aria-hidden="true" />
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 text-xs text-port-text-muted">No configured workspaces were available to inspect.</p>
      )}

      {(uniqueWarnings.length > 0 || error) && (
        <div className="mt-3 border-t border-port-border pt-3 text-xs text-port-warning">
          {error && <p>Visibility refresh delayed: {error}. The last successful snapshot remains in use.</p>}
          {uniqueWarnings.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {uniqueWarnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
