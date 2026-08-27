import { useState } from 'react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ToggleSwitch from '../ToggleSwitch';
import { useInstanceFeatures, publishInstanceFeatures } from '../../hooks/useInstanceFeatures.js';
import { updateInstanceFeature } from '../../services/api';

// How the current value was decided, so a user who never touched the toggle can
// see that the install picked it up from a configured integration rather than
// guessing why a section is missing from the sidebar.
const sourceHint = (feature) => {
  if (feature.source !== 'auto') return null;
  return feature.enabled
    ? `Detected automatically — this install has ${feature.label} configured.`
    : `Detected automatically — no ${feature.label} instance is configured yet.`;
};

export function InstanceFeaturesTab() {
  const { features, error, reload } = useInstanceFeatures();
  const [savingId, setSavingId] = useState(null);

  // The toggle is announced on the shared INSTANCE_FEATURES_CHANGED channel, so
  // the sidebar, the ⌘K palette, and the dashboard widgets that already listen
  // all follow it — no reload, and no second broadcast path to keep in step.
  const handleToggle = async (feature) => {
    if (!feature?.id || savingId) return;
    const enabled = !feature.enabled;
    setSavingId(feature.id);

    const result = await updateInstanceFeature(feature.id, enabled, { silent: true }).catch((err) => {
      toast.error(err.message || `Could not update ${feature.label}`);
      return null;
    });

    if (result) publishInstanceFeatures(result.features, { featureId: feature.id, enabled });
    setSavingId(null);
  };

  if (error) {
    return (
      <div className="space-y-3 max-w-3xl">
        <p className="text-sm text-port-error">{error.message || 'Failed to load instance features'}</p>
        <button
          type="button"
          onClick={reload}
          className="inline-flex items-center justify-center min-h-[44px] px-3 text-sm bg-port-border hover:bg-port-border/70 text-white rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (features === null) return <BrailleSpinner text="Loading instance features" />;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-white">Instance features</h2>
        <p className="text-sm text-gray-400 mt-1">
          Choose which optional PortOS features this install actively uses. A disabled feature drops out of the sidebar and the ⌘K palette, and stops contributing passive metrics, reminders, and proactive prompts — its pages stay reachable by direct link.
        </p>
      </div>

      <div className="space-y-3">
        {features.map((feature) => {
          const hint = sourceHint(feature);
          return (
            <div
              key={feature.id}
              className="flex items-start justify-between gap-4 bg-port-card border border-port-border rounded-lg p-4"
            >
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white">{feature.label}</h3>
                <p className="text-sm text-gray-400 mt-1">{feature.description}</p>
                <p className={`text-xs mt-2 ${feature.enabled ? 'text-port-success' : 'text-gray-500'}`}>
                  {feature.enabled ? 'Active on this instance' : 'Not used on this instance'}
                </p>
                {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
              </div>
              <ToggleSwitch
                enabled={feature.enabled}
                onChange={() => handleToggle(feature)}
                disabled={savingId !== null}
                ariaLabel={`${feature.enabled ? 'Disable' : 'Enable'} ${feature.label} on this instance`}
                className="mt-1"
              />
            </div>
          );
        })}
        {features.length === 0 && (
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-sm text-gray-400">
            No optional features are registered for this version of PortOS.
          </div>
        )}
      </div>
    </div>
  );
}

export default InstanceFeaturesTab;
