import { sortByLabel } from '../../lib/sortByLabel.js';
import { IMAGE_GEN_MODE, IMAGE_RUNTIME_READINESS, falImageModelGroups, imageGenReadiness } from '../../lib/imageGenBackends';
import { isSelfServeRuntimeRemedy } from './RuntimeRemedyModals';
import ModelDownloadBadge, { deriveSizeEstimate } from '../media/ModelDownloadBadge';
import { FormField } from '../ui/FormField';
import ListLoadError from '../ui/ListLoadError';

function CloudModelOptions({ models, editing = false }) {
  const option = (model) => {
    const id = typeof model === 'string' ? model : model.id;
    const label = typeof model === 'string' ? model : (model.label || model.id);
    return <option key={id} value={id}>{label}</option>;
  };
  const featured = models.filter((model) => typeof model !== 'string' && model.featured);
  if (!featured.length) return models.map(option);
  if (editing) {
    return falImageModelGroups(models.filter((model) => typeof model !== 'string'), { editing: true })
      .map((group) => <optgroup key={group.label} label={group.label}>{group.models.map(option)}</optgroup>);
  }
  const rest = models.filter((model) => typeof model === 'string' || !model.featured);
  return (
    <>
      <optgroup label="Featured">{featured.map(option)}</optgroup>
      <optgroup label="All image models">{rest.map(option)}</optgroup>
    </>
  );
}

export default function ImageGenModelSection({
  mode, models, modelsState, modelsError, onRetryModels, modelId, onModelChange,
  showModel, currentModel, disabled, inputCls,
  modelStatus, onModelDownload, onModelDownloadCancel, runtimeStatus, onRuntimeRemedy,
  cloudModels, cloudModel, onCloudModelChange, cloudModelLabel, cloudModelDefaultLabel, cloudModelEditing,
}) {
  const isLocal = mode === IMAGE_GEN_MODE.LOCAL;
  const showCloudModel = !!onCloudModelChange && cloudModels.length > 0;
  // Only a verdict for THIS model counts: the page re-probes on every model
  // change, and a stale answer for the previous pick must not relabel this one.
  const runtimeIssue = runtimeStatus && runtimeStatus.modelId === modelId
    && imageGenReadiness(runtimeStatus) === IMAGE_RUNTIME_READINESS.UNAVAILABLE
    ? runtimeStatus.reason || 'The local runtime failed its check.' : null;
  const runtimeRepair = runtimeIssue && onRuntimeRemedy && isSelfServeRuntimeRemedy(runtimeStatus.remedy?.kind)
    ? runtimeStatus.remedy : null;

  return (
    <>
      {showModel && isLocal && modelsState === 'error' && (
        <ListLoadError className="col-span-full" what="the local model catalog" error={modelsError} onRetry={onRetryModels} />
      )}
      {showModel && isLocal && modelsState === 'ready' && models.length === 0 && (
        <p role="status" className="col-span-full text-xs text-port-warning">
          No local image models are compatible with this machine.
        </p>
      )}
      {showModel && isLocal && models.length > 0 && (
        <FormField label="Model" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            value={modelId || ''}
            onChange={(e) => onModelChange?.(e.target.value)}
            disabled={disabled}
            className={inputCls}
          >
            {sortByLabel(models).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {currentModel?.runner === 'flux3' && (
            <p className="mt-2 text-xs text-gray-400">
              {currentModel.disclosure} <a href={currentModel.licenseUrl} target="_blank" rel="noopener noreferrer" className="text-port-accent underline">Read the FLUX Kommunity License</a>
            </p>
          )}
          {onModelDownload && modelStatus && (
            <ModelDownloadBadge
              status={modelStatus}
              onDownload={() => onModelDownload(modelId)}
              onCancel={onModelDownloadCancel}
              estimateLabel={deriveSizeEstimate(currentModel?.name)}
              runtimeIssue={runtimeIssue}
              onRepairRuntime={runtimeRepair ? () => onRuntimeRemedy(runtimeRepair.kind) : undefined}
              repairLabel={runtimeRepair?.label}
            />
          )}
        </FormField>
      )}

      {/* The cloud CLI's own model, overridable per queue item. Blank = inherit
          the Settings default, so clearing the select never pins an empty id —
          the server treats a blank `cloudModel` as "use the saved value". */}
      {showCloudModel && (
        <FormField label={cloudModelLabel} labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            value={cloudModel}
            onChange={(e) => onCloudModelChange(e.target.value)}
            disabled={disabled}
            className={inputCls}
          >
            <option value="">
              {cloudModelDefaultLabel ? `Settings default (${cloudModelDefaultLabel})` : 'Settings default'}
            </option>
            <CloudModelOptions models={cloudModels} editing={cloudModelEditing} />
          </select>
        </FormField>
      )}
    </>
  );
}
