import { CheckCircle2, CircleAlert, CircleHelp, ExternalLink, RefreshCw, Settings2 } from 'lucide-react';
import { Link } from 'react-router';
import { formatDateTime } from '../../utils/formatters.js';

const readinessLabel = (readiness) => {
  if (readiness === 'ready') return 'Ready';
  if (readiness === 'degraded') return 'Needs attention';
  if (readiness === 'blocked') return 'Needs attention';
  return 'Not verified';
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
  dependencies: { guidance: 'Install dependencies in the affected workspace using its documented setup command, then recheck. A CoS agent can do this as part of its task.' },
  engines: { guidance: 'Use a Node.js and package-manager version satisfying the requirements below. These versions describe the PortOS process environment; an agent shell may use a different runtime. Restart PortOS after changing its runtime, then recheck.' },
  submodules: { label: 'Manage submodules', href: (appId) => `/apps/${encodeURIComponent(appId)}/submodules` },
  forge: { label: 'Open app Git settings', href: (appId) => `/apps/${encodeURIComponent(appId)}/git` },
  reviewers: { label: 'Manage reviewers', href: () => '/models/code-reviewers' },
  preflight: { label: 'Open app settings', href: (appId) => `/apps/${encodeURIComponent(appId)}/overview?edit=1&appTab=general` },
});

const blockingWarnings = (preflight) => (Array.isArray(preflight?.warnings) ? preflight.warnings : [])
  .filter((warning) => warning?.severity !== 'advisory' && REPAIR_ACTIONS[warning?.check]);

const checkLabel = (preflight, check) => {
  const hasWorkspace = Array.isArray(preflight.workspaces) && preflight.workspaces.length > 0;
  const nonNode = preflight.workspaceDiscovery === 'ready' && preflight.workspaces?.length === 1 && preflight.workspaces[0].id === 'root' && preflight.workspaces[0].manifest === 'missing';
  if (nonNode && check === 'dependencies') return 'Node dependencies not applicable';
  if (nonNode && check === 'engines') return 'Node engines not applicable';
  if (check === 'dependencies') return hasWorkspace && !preflight.workspaces.some((workspace) => workspace.dependencies?.status !== 'installed') ? 'Dependencies available' : 'Dependencies need attention';
  if (check === 'engines') return hasWorkspace && !preflight.workspaces.some((workspace) => ['incompatible', 'unknown'].includes(workspace.engines?.node?.status) || ['incompatible', 'unknown'].includes(workspace.engines?.packageManager?.status)) ? 'Engines compatible' : 'Engine compatibility needs attention';
  if (check === 'submodules') return preflight.submodules?.status === 'initialized' || preflight.submodules?.status === 'not-configured' ? 'Submodules ready' : 'Submodules need attention';
  if (check === 'forge') return preflight.forge?.status === 'not-configured' ? 'No forge configured' : preflight.forge?.status === 'ready' ? 'Forge access available' : 'Forge access needs attention';
  if (check === 'reviewers') return ['ready', 'not-configured'].includes(preflight.reviewers?.required?.status) ? preflight.reviewers?.required?.status === 'not-configured' ? 'No required reviewers' : 'Required reviewers available' : 'Reviewer availability needs attention';
  return null;
};

export default function PersistentMindVisibilityPanel({ visibility, error, loading, onRefresh, onPrepareRepair }) {
  const workspaces = Array.isArray(visibility?.workspaces) ? visibility.workspaces : [];
  const readiness = visibility?.readiness || 'unknown';

  return (
    <section aria-label="Persistent mind environment visibility" className="rounded border border-port-border bg-port-card p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-port-accent">Environment visibility</h3>
          <p className="mt-1 text-xs text-port-text-muted">Workspace diagnostics. CoS agents can prepare dependencies and repair setup; only checks explicitly required by a task prevent it from queueing.</p>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex items-center justify-center gap-1.5 rounded border border-port-border px-2.5 py-1.5 text-xs font-medium text-port-text hover:bg-port-border/20 disabled:cursor-not-allowed disabled:opacity-60">
          <RefreshCw size={13} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
          {loading ? 'Checking…' : 'Recheck workspaces'}
        </button>
      </div>

      <div role="status" aria-live="polite" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className={`inline-flex items-center gap-1.5 font-semibold ${readinessClass(readiness)}`}>
          <ReadinessIcon readiness={readiness} />
          {readinessLabel(readiness)}
        </span>
        <span className="text-port-text-muted">
          Captured {visibility?.capturedAt ? formatDateTime(visibility.capturedAt) : '—'} · {visibility?.freshness?.state || 'unknown'} snapshot
        </span>
        {visibility?.truncated && <span className="text-port-warning">Some checks were bounded before completion.</span>}
      </div>

      {visibility?.orientation && (
        <section aria-label="Mind orientation" className="mt-3 space-y-3 rounded border border-port-border p-3 text-xs text-port-text-muted">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-semibold text-port-text">Current abilities and context</h4>
            <Link to="/cos/mind?panel=tools" className="text-port-accent hover:underline">Configure mind tools</Link>
          </div>
          <p>Eidoverse: <strong className="text-port-text">{visibility.orientation.eidoverse?.status || 'unknown'}</strong> · World building {visibility.orientation.eidoverse?.canBuild ? 'enabled' : 'off'} · Presence {visibility.orientation.eidoverse?.connected ? 'connected' : 'not connected'}</p>
          <div className="flex flex-wrap gap-3">
            <Link to="/eidoverse" className="text-port-accent hover:underline">Open Eidoverse</Link>
            <Link to="/settings/features" className="text-port-accent hover:underline">Feature setup</Link>
            <Link to="/cos/mind?panel=settings" className="text-port-accent hover:underline">Change thinking model</Link>
            <Link to="/cos/mind?panel=memories" className="text-port-accent hover:underline">Add durable context</Link>
          </div>
          <p>{visibility.orientation.modelPolicy?.continuity} Model changes are user controlled and apply to the next wake. Task model permissions govern delegated agents separately.</p>
          <details>
            <summary className="cursor-pointer font-medium text-port-text">Release context · {visibility.orientation.release?.version || 'unknown version'}</summary>
            <p className="mt-2">Included in each turn. Release notes describe shipped changes; enabled tools and runtime status determine what the mind can do now.</p>
            {visibility.orientation.release?.status !== 'available' && <p className="mt-2">Release notes unavailable.</p>}
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {(visibility.orientation.release?.highlights || []).map((line, index) => <li key={index}>{line}</li>)}
            </ul>
            {visibility.orientation.release?.truncated && <p className="mt-2">Showing a bounded selection of release notes.</p>}
          </details>
        </section>
      )}

      {readiness === 'blocked' && (
        <div role="alert" className="mt-3 flex flex-col gap-2 rounded border border-port-error/40 bg-port-error/10 p-3 text-xs text-port-text sm:flex-row sm:items-center sm:justify-between">
          <p><span className="font-semibold text-port-error">Some workspace checks need attention.</span> This does not block all delegated work. Review each app below; a repair task can run without requiring the check it is fixing.</p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link to="/cos/mind?panel=tools" className="inline-flex items-center gap-1 rounded border border-port-accent px-2.5 py-1.5 font-medium text-port-accent hover:bg-port-accent/10">
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
                {(repairs.length > 0 || workspaceReadiness === 'blocked' || workspaceReadiness === 'unknown') && (
                  <div className="mt-2 rounded border border-port-warning/30 bg-port-warning/10 p-2 text-xs text-port-warning">
                    <p>{preflight.repository?.reachable === false ? 'The repository is unavailable. Check its configured location in app settings.' : 'These checks only block tasks that explicitly require them before queueing. Rechecking reads current state; it does not repair setup.'}</p>
                    {preflight.repository?.reachable === false && <Link to={`/apps/${encodeURIComponent(workspace.appId)}/overview?edit=1&appTab=general`} className="mt-2 inline-block text-port-accent hover:underline">Configure repository</Link>}
                    {(preflight.workspaces || []).map((item) => (
                      <div key={item.id} className="mt-2 text-port-text">
                        <strong>{item.id}</strong>
                        <span className="text-port-text-muted"> · Dependencies: {item.dependencies?.status || 'unknown'}</span>
                        {[['Node.js', item.engines?.node], [item.engines?.packageManager?.name, item.engines?.packageManager]].filter(([, engine]) => engine?.required).map(([name, engine]) => (
                          <p key={name}>{name}: requires <code>{engine.required}</code> · detected <code>{engine.actual || 'not verified'}</code> ({engine.status})</p>
                        ))}
                      </div>
                    ))}
                    {onPrepareRepair && <button type="button" onClick={() => onPrepareRepair(workspace)} className="mt-3 rounded border border-port-accent px-3 py-2 font-medium text-port-accent hover:bg-port-accent/10">Draft repair request</button>}
                    {repairs.length > 0 && (
                      <ul className="mt-2 space-y-1.5">
                        {repairs.map((warning) => {
                          const action = REPAIR_ACTIONS[warning.check];
                          return (
                            <li key={warning.code} className="flex flex-col gap-1">
                              <span>{warning.message}</span>
                              {action.guidance && <p className="text-port-text-muted">{action.guidance}</p>}
                              {action.href && <Link to={action.href(workspace.appId)} className="inline-flex shrink-0 items-center gap-1 font-medium text-port-accent hover:underline">
                                {action.label} <ExternalLink size={12} aria-hidden="true" />
                              </Link>}
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

      {error && (
        <div className="mt-3 border-t border-port-border pt-3 text-xs text-port-warning">
          <p>Visibility refresh delayed: {error}. The last successful snapshot remains in use.</p>
        </div>
      )}
    </section>
  );
}
