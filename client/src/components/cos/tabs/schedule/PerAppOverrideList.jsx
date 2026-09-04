import { useState } from 'react';
import { providerModelLabel } from '../../../../utils/providers';
import AppOverrideRow from './AppOverrideRow';

export default function PerAppOverrideList({ taskType, config, apps, providers, providersLoaded = true, onUpdateOverride, onBulkToggleOverride }) {
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const activeApps = apps?.filter(app => !app.archived) || [];
  const appOverrides = config.appOverrides || {};
  // List-invariant, so it's resolved once here rather than per row: what an app
  // that pins nothing of its own actually runs on.
  const inheritedProviderText = config.providerId
    ? providerModelLabel(providers || [], config.providerId, config.model)
    : 'the active provider';

  if (activeApps.length === 0) return null;

  const allEnabled = activeApps.every(app => appOverrides[app.id]?.enabled === true);
  const allDisabled = activeApps.every(app => appOverrides[app.id]?.enabled !== true);

  const handleBulkToggle = async () => {
    setBulkUpdating(true);
    const newEnabled = !allEnabled;
    await onBulkToggleOverride(taskType, newEnabled);
    setBulkUpdating(false);
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-gray-400">Per-App Options</h4>
          <p className="text-xs text-gray-500 mt-0.5">
            Each app&apos;s toggle turns <span className="font-mono text-gray-400">{taskType}</span> on or off for that app —
            an app stays off until you switch it on here, whatever the rest of the row says. The other controls are
            optional: leave one on <em>Inherit</em> and it follows the global defaults.
          </p>
        </div>
        <button
          onClick={handleBulkToggle}
          disabled={bulkUpdating}
          title={`${allEnabled ? 'Stop' : 'Start'} running ${taskType} for every active app`}
          className={`text-xs px-2 py-1 rounded transition-colors shrink-0 ${
            bulkUpdating ? 'opacity-50 cursor-not-allowed' : ''
          } ${
            allEnabled
              ? 'text-port-error hover:bg-port-error/10'
              : allDisabled
                ? 'text-port-success hover:bg-port-success/10'
                : 'text-port-accent hover:bg-port-accent/10'
          }`}
        >
          {allEnabled ? 'Disable for all apps' : 'Enable for all apps'}
        </button>
      </div>
      <div className="border border-port-border rounded-lg divide-y divide-port-border/50">
        {activeApps.map(app => (
          <AppOverrideRow
            key={app.id}
            app={app}
            taskType={taskType}
            globalIntervalType={config.type}
            globalTaskMetadata={config.taskMetadata}
            managedAgentOptions={config.managedAgentOptions}
            fileIssuesCapable={config.fileIssuesCapable}
            defaultFileIssues={config.defaultFileIssues}
            doWorkRequiresWorktree={config.doWorkRequiresWorktree}
            inheritedProviderText={inheritedProviderText}
            providers={providers}
            providersLoaded={providersLoaded}
            override={appOverrides[app.id]}
            onUpdate={onUpdateOverride}
          />
        ))}
      </div>
    </div>
  );
}
