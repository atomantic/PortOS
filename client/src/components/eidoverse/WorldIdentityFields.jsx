import { Link } from 'react-router';
import { fieldClass } from './worldDrawerFields';

export default function WorldIdentityFields({
  worldState,
  design,
  recipeDraft,
  reconciliation,
  frameConnection,
  appId,
  labelVisibility,
  onLabelVisibilityChange,
  worldName,
  setWorldName,
  humanName,
  setHumanName,
  cosId,
  markDirty,
  projectedIndicatorCount,
  projectedIndicatorLimit,
}) {
  const labelSupport = frameConnection?.status === 'ready'
    ? frameConnection.capabilities.objectLabels
    : reconciliation.runtimeVersion?.capabilities?.objectLabels === 1;
  const labelSupportChecked = frameConnection?.status !== 'checking'
    || Boolean(reconciliation.runtimeVersion);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-port-accent/25 bg-port-accent/5 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-port-accent">World Design V{design.selectedVersion || recipeDraft?.version}</p>
        <h3 className="mt-1 text-lg font-semibold text-white">{design.name || recipeDraft?.name}</h3>
        <p className="mt-2 text-sm leading-6 text-gray-400">
          A walkable commons of a grassy arrival park, inward-facing halls, and workspaces for PortOS apps, agents, goals, memory, data, peers, and activity.
        </p>
      </div>
      <section className="rounded-xl border border-port-border bg-port-bg p-4">
        <h3 className="font-medium text-white">Object labels</h3>
        {labelSupportChecked && !labelSupport && (
          <p className="mt-2 text-sm text-port-warning" role="status">
            This renderer does not report object-label support. Update Eidoverse Worlds, then reload this page.
            {' '}<Link className="underline" to={appId ? `/apps/${appId}/overview` : '/apps'}>Manage renderer updates</Link>.
            {' '}Your design, aliases, and asset choices stay saved. The object legend below remains available.
          </p>
        )}
        {labelSupport && (frameConnection?.status === 'unsupported' || (frameConnection?.status === 'ready'
          && (!frameConnection.capabilities.portosNavigation || !frameConnection.capabilities.labelPreferences))) && (
          <p className="mt-2 text-sm text-port-warning" role="status">
            Reload or update the renderer to enable label controls and Open in PortOS.
          </p>
        )}
        <label className="mt-3 block text-sm text-gray-300" htmlFor="eidoverse-label-visibility">
          Floating labels
          <select id="eidoverse-label-visibility" className={fieldClass} value={labelVisibility}
            onChange={(event) => onLabelVisibilityChange(event.target.value)}>
            <option value="nearby">Nearby — respect each object's label mode</option>
            <option value="all-nearby">All nearby — label objects within 60 metres</option>
            <option value="off">Off — hide floating labels</option>
          </select>
        </label>
        <p className="mt-2 text-xs text-gray-400">Labels appear above objects in the world. Click or tap a label to learn what it represents. Off at the start of each visit. Use Labels in the toolbar when you want to inspect objects; turning labels off keeps already-open details available.</p>
        {!frameConnection?.capabilities?.labelPreferences && (
          <p className="mt-1 text-xs text-gray-400">The preference will apply when a compatible renderer connects.</p>
        )}
      </section>
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
      <p className="text-xs leading-5 text-gray-400">
        In the embedded world, <code>/name &lt;new name&gt;</code> stages this field. Save and project leaves the current session and re-enters under the new name.
      </p>
      <label className="block text-sm text-gray-300" htmlFor="eidoverse-cos-name">
        CoS / Persistent Mind name
        <input
          id="eidoverse-cos-name"
          className={fieldClass}
          value={cosId}
          readOnly
          maxLength={64}
          placeholder="portos-cos"
          pattern="[A-Za-z0-9_-]+"
          required
        />
      </label>
      <p className="text-xs leading-5 text-gray-400">
        Follows the Persistent Mind’s chosen name automatically. Presence reconnects under that name on its next world action. Until it chooses a name, the existing join id is kept.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-port-border bg-port-bg p-3">
          <p className="text-xs text-gray-500">World</p>
          <p className="mt-1 truncate text-sm text-white">{worldState?.world}</p>
        </div>
        <div className="rounded-lg border border-port-border bg-port-bg p-3">
          <p className="text-xs text-gray-500">CoS presence</p>
          <p className="mt-1 truncate text-sm text-white">{worldState?.cos?.id || cosId || 'portos-cos'}</p>
          <p className="mt-1 text-[10px] leading-4 text-gray-500">{worldState?.presence?.connected ? 'Connected' : 'Ready to reconnect'}</p>
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
}
