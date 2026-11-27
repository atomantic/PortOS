import { Link } from 'react-router';
import { primaryButton, secondaryButton, titleCase } from './worldDrawerFields';

const statusTone = (status) => {
  if (status === 'complete') return 'border-port-success/40 bg-port-success/10 text-port-success';
  if (status === 'failed') return 'border-port-error/40 bg-port-error/10 text-port-error';
  return 'border-port-accent/40 bg-port-accent/10 text-port-accent';
};

export default function WorldUpdatesPanel({
  design,
  reconciliation,
  projectionActionBlocked,
  projectionStatus,
  dirty,
  busy,
  onProject,
  onRefreshAssets,
  resetArmed,
  setResetArmed,
  onReset,
}) {
  return (
    <div className="space-y-4">
      <section className={`rounded-xl border p-4 ${statusTone(reconciliation.status)}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em]">Reconciliation {reconciliation.status || 'pending'}</p>
            <h3 className="mt-1 text-base font-semibold text-white">{reconciliation.checkpoint || 'Waiting for first projection'}</h3>
          </div>
          <span className="rounded-full border border-current/30 px-2 py-1 text-xs">
            V{design.lastAppliedVersion ?? '—'} → V{design.pendingVersion ?? design.selectedVersion}
          </span>
        </div>
        {reconciliation.error && <p role="alert" className="mt-3 text-sm text-port-error">{reconciliation.error}</p>}
        {reconciliation.errorContext?.missing?.length > 0 && (
          <p role="alert" className="mt-2 text-xs text-port-error">Unresolved slots: {reconciliation.errorContext.missing.join(', ')}</p>
        )}
        {reconciliation.errorContext?.remediation === '/apps' && (
          <Link className="mt-2 inline-block text-xs text-white underline" to="/apps">Update Eidoverse from Managed Apps</Link>
        )}
        {reconciliation.retiredOwnerCleanup?.failedCount > 0 && (
          <p className="mt-2 text-xs text-port-warning" role="status">
            PortOS could not retire {reconciliation.retiredOwnerCleanup.failedCount} previous owner role(s), so this world continued.
            {reconciliation.retiredOwnerCleanup.retryingCount > 0
              ? ` ${reconciliation.retiredOwnerCleanup.retryingCount} will retry on the next projection.`
              : ''}
            {reconciliation.retiredOwnerCleanup.droppedCount > 0
              ? ` ${reconciliation.retiredOwnerCleanup.droppedCount} reached the retry limit; review prior worlds manually if those roles matter.`
              : ''}
          </p>
        )}
        {reconciliation.operationCount > 0 && (
          <div className="mt-3" role="progressbar" aria-label="World reconciliation progress" aria-valuemin="0" aria-valuemax={reconciliation.operationCount} aria-valuenow={reconciliation.appliedOperations || 0}>
            <div className="flex justify-between text-[11px] text-current/80">
              <span>{titleCase(reconciliation.checkpoint)}</span>
              <span>{Math.min(reconciliation.appliedOperations || 0, reconciliation.operationCount)}/{reconciliation.operationCount}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/25">
              <div
                className="h-full rounded-full bg-current transition-[width]"
                style={{ width: `${Math.min(100, ((reconciliation.appliedOperations || 0) / reconciliation.operationCount) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </section>

      {design.migrationReport && (
        <section className="rounded-xl border border-port-border bg-port-bg p-4">
          <h3 className="font-medium text-white">Migration report</h3>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-gray-500">Status</dt><dd className="mt-1 text-gray-200">{design.migrationReport.status}</dd></div>
            <div><dt className="text-xs text-gray-500">Preserved overrides</dt><dd className="mt-1 text-gray-200">{design.migrationReport.preservedOverrides?.length || 0}</dd></div>
            <div><dt className="text-xs text-gray-500">From design</dt><dd className="mt-1 text-gray-200">V{design.migrationReport.fromDesignVersion || 1}</dd></div>
            <div><dt className="text-xs text-gray-500">To design</dt><dd className="mt-1 text-gray-200">V{design.migrationReport.toDesignVersion || 2}</dd></div>
          </dl>
          {design.migrationReport.preservedOverrides?.length > 0 && (
            <ul className="mt-3 space-y-1 rounded-lg border border-port-border bg-port-card p-3 text-xs text-gray-300">
              {design.migrationReport.preservedOverrides.map((path) => <li key={path}>{path}</li>)}
            </ul>
          )}
          {design.migrationReport.adoptedDefaultChanges?.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-lg border border-port-border">
              {design.migrationReport.adoptedDefaultChanges.map((change) => (
                <div key={change.area} className="grid gap-1 border-b border-port-border px-3 py-2 text-xs last:border-b-0 sm:grid-cols-[7rem_1fr]">
                  <span className="font-medium text-white">{change.area}</span>
                  <span className="text-gray-400">{change.from} → {change.to}</span>
                </div>
              ))}
            </div>
          )}
          {Object.keys(design.migrationReport.unsupportedOverrides || {}).length > 0 && (
            <p className="mt-3 text-xs leading-5 text-port-warning">
              Retained for manual review: {Object.keys(design.migrationReport.unsupportedOverrides).join(', ')}
            </p>
          )}
          {design.migrationReport.removedMachineDerivedIdentity && (
            <p className="mt-3 text-xs leading-5 text-gray-400">
              The old automatic machine-name identity was retired in favor of a private generated name. Explicitly configured names are never changed.
            </p>
          )}
        </section>
      )}

      {reconciliation.runtimeVersion && (
        <section className="rounded-xl border border-port-border bg-port-bg p-4">
          <h3 className="font-medium text-white">Runtime compatibility</h3>
          <p className="mt-2 text-xs text-gray-400">Protocol preflight passed on build {reconciliation.runtimeVersion.sha}.</p>
          <p className="mt-1 text-[11px] text-gray-500">{reconciliation.runtimeVersion.commitTime}</p>
        </section>
      )}

      <section className="rounded-xl border border-port-border bg-port-bg p-4">
        <h3 className="font-medium text-white">Apply and recover</h3>
        <p className="mt-1 text-sm leading-6 text-gray-400">Preflight every asset, build V2 under PortOS-managed IDs, then retire only stale managed entities. A failure remains pending and retryable.</p>
        {dirty && (
          <p className="mt-2 text-sm text-port-warning" role="status">
            Save your world changes before applying an update or refreshing asset matches.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={primaryButton} disabled={projectionActionBlocked} onClick={onProject}>
            {projectionStatus === 'running' ? 'Applying update…' : 'Apply world update'}
          </button>
          <button type="button" className={secondaryButton} disabled={projectionActionBlocked} onClick={onRefreshAssets}>
            Refresh asset matches
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-port-error/30 bg-port-error/5 p-4">
        <h3 className="font-medium text-white">Reset PortOS world design</h3>
        <p className="mt-1 text-sm leading-6 text-gray-400">Clears install-local overrides and the asset lock. Eidoverse model bytes and non-PortOS world entities are untouched.</p>
        {!resetArmed ? (
          <button type="button" className={`${secondaryButton} mt-4`} disabled={busy} onClick={() => setResetArmed(true)}>Reset all settings…</button>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="inline-flex min-h-[40px] items-center rounded-lg bg-port-error px-3 py-2 text-sm font-semibold text-white" disabled={busy} onClick={() => { setResetArmed(false); onReset('all'); }}>
              Confirm reset
            </button>
            <button type="button" className={secondaryButton} onClick={() => setResetArmed(false)}>Cancel</button>
          </div>
        )}
      </section>
    </div>
  );
}
