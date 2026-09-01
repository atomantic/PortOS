import { useState } from 'react';
import { Compass, Database, Palette, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import Drawer from '../Drawer';
import useDrawerTab from '../../hooks/useDrawerTab';
import { formatBytes } from '../../utils/formatters';

const TABS = [
  { id: 'experience', label: 'Experience', icon: Compass },
  { id: 'districts', label: 'Districts & Data', icon: Database },
  { id: 'appearance', label: 'Appearance & Assets', icon: Palette },
  { id: 'updates', label: 'Updates & Advanced', icon: RefreshCw },
];
const TAB_IDS = TABS.map(({ id }) => id);
const SOURCE_ROUTES = {
  apps: '/apps', agents: '/cos/agents', tasks: '/cos/tasks', features: '/settings/features',
  peers: '/instances', health: '/cos/health', productivity: '/cos/productivity',
  activity: '/cos/productivity', goals: '/goals/list', memory: '/brain/memory',
  storage: '/settings/database', jira: '/goals/list', operations: '/cos/health',
};

const fieldClass = 'mt-1 min-h-[42px] w-full rounded-lg border border-port-border bg-port-bg px-3 text-sm text-white focus:border-port-accent focus:outline-none';
const secondaryButton = 'inline-flex min-h-[40px] items-center justify-center rounded-lg border border-port-border px-3 py-2 text-sm text-gray-200 transition-colors hover:border-port-accent hover:text-white disabled:cursor-wait disabled:opacity-50';
const primaryButton = 'inline-flex min-h-[40px] items-center justify-center rounded-lg bg-port-accent px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50';

const titleCase = (value) => String(value || '')
  .replace(/[-_]/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const statusTone = (status) => {
  if (status === 'complete') return 'border-port-success/40 bg-port-success/10 text-port-success';
  if (status === 'failed') return 'border-port-error/40 bg-port-error/10 text-port-error';
  return 'border-port-accent/40 bg-port-accent/10 text-port-accent';
};

export default function EidoverseWorldDrawer({
  open,
  onClose,
  worldState,
  worldName,
  setWorldName,
  humanName,
  setHumanName,
  recipeDraft,
  assetOverridesDraft,
  mutateRecipe,
  mutateAssetOverride,
  markDirty,
  configStatus,
  projectionStatus,
  dirty,
  onSave,
  onProject,
  onReset,
  onRefreshAssets,
}) {
  const [activeTab, setActiveTab] = useDrawerTab('eidoverseTab', 'experience', TAB_IDS);
  const [resetArmed, setResetArmed] = useState(false);
  const [numericDrafts, setNumericDrafts] = useState({});
  const design = worldState?.design || {};
  const reconciliation = design.reconciliation || {};
  const projectionSummary = worldState?.projection?.lastSummary || {};
  const projectedIndicatorCount = Number.isFinite(projectionSummary.liveEntityCount)
    ? projectionSummary.liveEntityCount
    : null;
  const projectedIndicatorLimit = projectionSummary.maxLiveEntities
    ?? design.maxEntities
    ?? recipeDraft?.maxEntities
    ?? 48;
  const busy = configStatus === 'saving' || projectionStatus === 'running';
  const projectionActionBlocked = busy || dirty;
  const assetRecipes = recipeDraft?.assetRecipe?.slots || {};
  const assetRows = [
    ...Object.entries(assetRecipes).map(([slot, recipe]) => ({ slot, recipe, legacy: false })),
    ...Object.keys(assetOverridesDraft || {})
      .filter((slot) => !Object.hasOwn(assetRecipes, slot))
      .sort()
      .map((slot) => ({ slot, recipe: null, legacy: true })),
  ];
  const numericValue = (key, fallback) => (
    Object.hasOwn(numericDrafts, key) ? numericDrafts[key] : fallback
  );
  const updateNumericDraft = (key, raw, commit) => {
    setNumericDrafts((current) => ({ ...current, [key]: raw }));
    if (raw === '') return;
    const number = Number(raw);
    if (Number.isFinite(number)) commit(number);
  };
  const finishNumericDraft = (key) => {
    setNumericDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const identityFields = (
    <div className="space-y-4">
      <div className="rounded-xl border border-port-accent/25 bg-port-accent/5 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-port-accent">World Design V{design.selectedVersion || recipeDraft?.version}</p>
        <h3 className="mt-1 text-lg font-semibold text-white">{design.name || recipeDraft?.name}</h3>
        <p className="mt-2 text-sm leading-6 text-gray-400">
          A luminous systems garden where PortOS apps, agents, goals, memory, data, peers, and activity each have a legible home.
        </p>
      </div>
      <label className="block text-sm text-gray-300" htmlFor="eidoverse-world-name">
        World name
        <input
          id="eidoverse-world-name"
          className={fieldClass}
          value={worldName}
          onChange={(event) => { markDirty(); setWorldName(event.target.value); }}
          maxLength={64}
          pattern="[A-Za-z0-9_-]+"
          required
        />
      </label>
      <label className="block text-sm text-gray-300" htmlFor="eidoverse-human-name">
        My Eidoverse name
        <input
          id="eidoverse-human-name"
          className={fieldClass}
          value={humanName}
          onChange={(event) => { markDirty(); setHumanName(event.target.value); }}
          maxLength={64}
          placeholder="Leave blank for a private generated name"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-port-border bg-port-bg p-3">
          <p className="text-xs text-gray-500">World</p>
          <p className="mt-1 truncate text-sm text-white">{worldState?.world}</p>
        </div>
        <div className="rounded-lg border border-port-border bg-port-bg p-3">
          <p className="text-xs text-gray-500">CoS presence</p>
          <p className="mt-1 text-sm text-white">{worldState?.presence?.connected ? 'Connected' : 'Ready to reconnect'}</p>
        </div>
        <div className="rounded-lg border border-port-border bg-port-bg p-3">
          <p className="text-xs text-gray-500">PortOS indicators</p>
          <p className="mt-1 text-sm text-white">
            {projectedIndicatorCount === null ? 'Waiting for projection' : `${projectedIndicatorCount} shown`}
          </p>
          <p className="mt-1 text-[10px] leading-4 text-gray-500">
            Up to {projectedIndicatorLimit} can be displayed at once. This is scene capacity, not a health score.
          </p>
        </div>
      </div>
    </div>
  );

  const districtFields = (
    <div className="space-y-3">
      <p className="text-sm leading-6 text-gray-400">
        PortOS projects bounded summary indicators, never raw records. Stable IDs keep each indicator in its district across refreshes.
        {projectedIndicatorCount === null
          ? ' The first projection has not reported a scene count yet.'
          : ` ${projectedIndicatorCount} are shown now; the ${projectedIndicatorLimit}-indicator limit keeps the scene legible.`}
      </p>
      {projectionSummary.truncated && (
        <p className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs leading-5 text-port-warning" role="status">
          The shared world cap omitted {' '}
          {Object.entries(projectionSummary.droppedBySource || {})
            .filter(([, count]) => count > 0)
            .map(([source, count]) => `${count} ${titleCase(source)}`)
            .join(', ')} signal(s). PortOS distributes available space across sources before adding extra signals.
        </p>
      )}
      {(recipeDraft?.districts || []).map((district) => (
        <section key={district.id} className="rounded-xl border border-port-border bg-port-bg p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: district.accent }} aria-hidden="true" />
                <h3 className="font-medium text-white">{district.label}</h3>
              </div>
              <p className="mt-1 text-xs text-gray-500">{district.direction} · {district.landmark}</p>
            </div>
            <button
              type="button"
              className={secondaryButton}
              aria-label={`Reset ${district.label}`}
              disabled={busy}
              onClick={() => onReset('district', district.id)}
            >
              Reset district
            </button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {district.sources.map((source) => (
              <div key={source} className="flex min-h-[58px] items-center gap-3 rounded-lg border border-port-border/70 px-3">
                <input
                  id={`eidoverse-source-${source}`}
                  type="checkbox"
                  checked={recipeDraft.includes?.[source] === true}
                  onChange={(event) => mutateRecipe((current) => ({
                    ...current,
                    includes: { ...current.includes, [source]: event.target.checked },
                  }))}
                />
                <div className="min-w-0 flex-1">
                  <label className="block truncate text-sm text-gray-300" htmlFor={`eidoverse-source-${source}`}>
                    {titleCase(source)}
                  </label>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-gray-500">
                    <span>{projectionSummary.sourceAvailability?.[source] === false
                      ? 'Stale · last good held'
                      : (projectionSummary.sourceCounts?.[source] ?? 'Not projected')}
                    {projectionSummary.droppedBySource?.[source] > 0
                      ? ` · ${projectionSummary.droppedBySource[source]} omitted by cap`
                      : ''}</span>
                    {SOURCE_ROUTES[source] && <Link className="text-port-accent hover:underline" to={SOURCE_ROUTES[source]}>Open in PortOS</Link>}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-500" htmlFor={`eidoverse-limit-${source}`}>
                  Cap
                  <input
                    id={`eidoverse-limit-${source}`}
                    className="h-8 w-16 rounded border border-port-border bg-port-card px-2 text-sm text-white"
                    type="number"
                    min="0"
                    max="48"
                    value={numericValue(`limit.${source}`, recipeDraft.limits?.[source] ?? 0)}
                    disabled={!recipeDraft.includes?.[source]}
                    onChange={(event) => {
                      updateNumericDraft(`limit.${source}`, event.target.value, (number) => mutateRecipe((current) => ({
                        ...current,
                        limits: { ...current.limits, [source]: number },
                      })));
                    }}
                    onBlur={() => finishNumericDraft(`limit.${source}`)}
                  />
                </label>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );

  const appearanceFields = (
    <div className="space-y-5">
      <section className="rounded-xl border border-port-border bg-port-bg p-4">
        <h3 className="font-medium text-white">Dawn atmosphere</h3>
        <p className="mt-1 text-xs leading-5 text-gray-500">Lightweight skymesh, three authored lights, restrained fog, and sparse wind grass.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {[
            ['hours', 'Sun hour', 0, 24, 0.1],
            ['exposure', 'Exposure', 0.3, 1.8, 0.01],
            ['fog', 'Fog', 0, 3, 0.01],
          ].map(([key, label, min, max, step]) => (
            <label key={key} className="text-sm text-gray-300" htmlFor={`eidoverse-sky-${key}`}>
              {label}
              <input
                id={`eidoverse-sky-${key}`}
                className={fieldClass}
                type="number"
                min={min}
                max={max}
                step={step}
                value={numericValue(`sky.${key}`, recipeDraft?.environment?.sky?.[key] ?? '')}
                onChange={(event) => {
                  updateNumericDraft(`sky.${key}`, event.target.value, (number) => mutateRecipe((current) => ({
                    ...current,
                    environment: {
                      ...current.environment,
                      sky: { ...current.environment.sky, [key]: number },
                    },
                  })));
                }}
                onBlur={() => finishNumericDraft(`sky.${key}`)}
              />
            </label>
          ))}
          <label className="text-sm text-gray-300" htmlFor="eidoverse-grass-density">
            Grass density
            <input
              id="eidoverse-grass-density"
              className={fieldClass}
              type="number"
              min="0.1"
              max="2"
              step="0.05"
              value={numericValue('grass.density', recipeDraft?.environment?.grass?.density ?? '')}
              onChange={(event) => {
                updateNumericDraft('grass.density', event.target.value, (number) => mutateRecipe((current) => ({
                  ...current,
                  environment: {
                    ...current.environment,
                    grass: { ...current.environment.grass, density: number },
                  },
                })));
              }}
              onBlur={() => finishNumericDraft('grass.density')}
            />
          </label>
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-medium text-white">Portable asset recipe</h3>
            <p className="mt-1 text-xs text-gray-500">Paths and search terms ship; model bytes stay in Eidoverse.</p>
          </div>
          <button
            type="button"
            className={secondaryButton}
            disabled={projectionActionBlocked}
            title={dirty ? 'Save changes before refreshing asset matches' : undefined}
            onClick={onRefreshAssets}
          >
            Refresh asset matches
          </button>
        </div>
        {dirty && <p className="mt-2 text-xs text-port-warning">Save changes before refreshing asset matches.</p>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {assetRows.map(({ slot, recipe, legacy }) => {
            const resolution = design.assetResolutions?.[slot];
            return (
              <article key={slot} className="min-w-0 rounded-lg border border-port-border bg-port-bg p-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium text-white">{titleCase(slot)}</h4>
                  <span className="rounded-full border border-port-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">
                    {legacy ? 'legacy V1 override' : (resolution?.source || 'pending')}
                  </span>
                </div>
                {legacy ? (
                  <>
                    <p className="mt-2 break-all text-xs leading-5 text-port-accent">{assetOverridesDraft[slot]}</p>
                    <p className="mt-2 text-[11px] leading-4 text-gray-500">
                      Preserved from World Design V1. Clear it to let the semantic V2 asset recipe choose this model.
                    </p>
                    <button
                      type="button"
                      className={secondaryButton + ' mt-3 w-full'}
                      disabled={busy}
                      onClick={() => mutateAssetOverride(slot, '')}
                    >
                      Clear legacy {titleCase(slot)} override
                    </button>
                  </>
                ) : (
                  <>
                <p className="mt-2 break-all text-xs leading-5 text-port-accent">{resolution?.path || 'Will resolve on the next projection'}</p>
                <p className="mt-2 text-[11px] leading-4 text-gray-500">Search: {recipe.fallbackQueries.join(' · ')}</p>
                <p className="text-[11px] text-gray-500">
                  {resolution?.bytes != null ? `${formatBytes(resolution.bytes)} selected · ` : ''}
                  Budget: {Math.round(recipe.maxBytes / 1_000_000)} MB · {recipe.sourcePolicy}
                </p>
                <label className="mt-3 block text-[11px] text-gray-500" htmlFor={`eidoverse-asset-override-${slot}`}>
                  Local override (optional)
                  <input
                    id={`eidoverse-asset-override-${slot}`}
                    className="mt-1 min-h-[36px] w-full rounded border border-port-border bg-port-card px-2 text-xs text-white"
                    value={assetOverridesDraft?.[slot] || ''}
                    onChange={(event) => mutateAssetOverride(slot, event.target.value)}
                    placeholder="eidoverse/... or store/..."
                    pattern="(?:eidoverse|store)[\\/](?!.*\.\.).*"
                  />
                </label>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );

  const updateFields = (
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
        {reconciliation.error && <p className="mt-3 text-sm text-port-error">{reconciliation.error}</p>}
        {reconciliation.errorContext?.missing?.length > 0 && (
          <p className="mt-2 text-xs text-port-error">Unresolved slots: {reconciliation.errorContext.missing.join(', ')}</p>
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

  const panel = activeTab === 'experience'
    ? identityFields
    : activeTab === 'districts'
      ? districtFields
      : activeTab === 'appearance'
        ? appearanceFields
        : updateFields;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="PortOS World Design"
      subtitle={`${design.name || 'Luminous Systems Garden'} · recipe V${design.assetRecipeVersion || 2}`}
      size="lg"
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
        {panel}
        {(activeTab !== 'updates' || dirty) && (
          <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center justify-end gap-3 border-t border-port-border bg-port-card/95 p-4 backdrop-blur">
            {configStatus && configStatus !== 'saving' && (
              <p className={configStatus === 'saved' ? 'mr-auto text-sm text-port-success' : 'mr-auto text-sm text-port-error'} role="status">
                {configStatus === 'saved' ? 'Saved locally and queued for projection.' : configStatus}
              </p>
            )}
            <button type="button" className={secondaryButton} onClick={onClose}>Close</button>
            <button type="submit" className={primaryButton} disabled={busy || !recipeDraft}>
              {configStatus === 'saving' ? 'Saving…' : 'Save and project'}
            </button>
          </div>
        )}
      </form>
    </Drawer>
  );
}
