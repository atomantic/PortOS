import { useMemo } from 'react';
import {
  effortAwareModelOptions,
  effortSurvivingModel,
  isToolFreeLocalProvider,
  localBackendForProvider,
  toolFreeLocalSelectionPolicy,
} from '../../../../utils/providers';
import useLocalModels from '../../../../hooks/useLocalModels';
import ProviderModelSelector from '../../../ProviderModelSelector';
import { pipelineStages } from './scheduleConstants';

export default function PipelineStageConfig({ taskType, config, providers, onUpdate, updating, setUpdating }) {
  const stages = pipelineStages(config);
  const needsSecurityModelPolicy = taskType === 'pr-reviewer';
  const { ollama, lmstudio, capabilitiesByBackend, loading: localModelsLoading } = useLocalModels({
    enabled: needsSecurityModelPolicy,
  });
  const securitySelectionPolicy = useMemo(
    () => toolFreeLocalSelectionPolicy(capabilitiesByBackend),
    [capabilitiesByBackend],
  );

  const handleStageUpdate = async (stageIndex, field, value) => {
    setUpdating(true);
    const updatedStages = stages.map((stage, i) => {
      if (i !== stageIndex) return stage;
      const updated = { ...stage };
      if (value === '' || value === null) {
        delete updated[field];
      } else {
        updated[field] = value;
      }
      // When provider changes, clear model + effort (neither may be valid for the
      // new provider — effort levels differ between claude/codex and non-effort
      // providers have none).
      if (field === 'providerId') {
        delete updated.model;
        delete updated.effort;
      }
      // A model with NO effort tiers (Antigravity's ladder is per-model) hides the
      // stage's effort select, so the stored value has to go with it — otherwise the
      // stage keeps a level the run can never use and no UI is left to clear it.
      if (field === 'model' && !effortSurvivingModel(providers?.find(p => p.id === stage.providerId), value, updated.effort)) {
        delete updated.effort;
      }
      return updated;
    });
    const updatedMeta = {
      ...config.taskMetadata,
      pipeline: { ...config.taskMetadata.pipeline, stages: updatedStages }
    };
    await onUpdate(taskType, { taskMetadata: updatedMeta }).catch(() => {});
    setUpdating(false);
  };

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-400 mb-3">Pipeline Stages</h4>
      <div className="space-y-3">
        {stages.map((stage, i) => {
          const stageProvider = providers?.find(p => p.id === stage.providerId);
          const isSecurityStage = needsSecurityModelPolicy && i === 0;
          const localBackend = localBackendForProvider(stageProvider);
          const localModelIds = localBackend === 'ollama' ? ollama : localBackend === 'lmstudio' ? lmstudio : [];
          // Keep the richer capability object on each local option so the shared
          // policy does not need a second lookup. The status hook's ids are the
          // installed-model source of truth; a provider's stale catalog is never
          // enough to make a model eligible for a security scan.
          const stageModels = isSecurityStage && isToolFreeLocalProvider(stageProvider)
            ? localModelIds.map(id => ({
              id,
              name: id,
              capabilities: capabilitiesByBackend?.[localBackend]?.[id],
            }))
            : effortAwareModelOptions(stageProvider, stage.model);
          const selectionPolicy = isSecurityStage ? securitySelectionPolicy : undefined;
          const stageProviderId = stage.providerId || '';
          const stageModel = stage.model || '';
          const stageEffort = stage.effort || '';

          const updateStage = (field, value) => handleStageUpdate(i, field, value || null);
          return (
            <div key={i} className="bg-port-card border border-port-border rounded-lg p-3">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-medium text-port-accent-2">Stage {i + 1}</span>
                {stage.readOnly && (
                  <span className="text-[10px] px-1 py-0.5 bg-gray-600/30 text-gray-400 rounded">read-only</span>
                )}
                <span className="text-sm text-white font-medium">{stage.name}</span>
                {i < stages.length - 1 && (
                  <span className="text-gray-500 ml-auto text-xs">→ Stage {i + 2}</span>
                )}
              </div>
              <ProviderModelSelector
                providers={providers || []}
                selectedProviderId={stageProviderId}
                selectedModel={stageModel}
                availableModels={stageModels}
                onProviderChange={(providerId) => updateStage('providerId', providerId)}
                onModelChange={(model) => updateStage('model', model)}
                effort={stageEffort}
                onEffortChange={(effort) => updateStage('effort', effort)}
                emptyProviderOption={isSecurityStage ? 'Select local provider (required)' : 'Default (task-level)'}
                emptyModelOption={isSecurityStage ? 'Select verified tool-free model (required)' : 'Default (task-level)'}
                alwaysShowModel
                selectionPolicy={selectionPolicy}
                disabled={updating}
              />
              {isSecurityStage && (
                <p className="text-xs text-gray-500 mt-2">
                  {localModelsLoading
                    ? 'Loading local model capability reports…'
                    : 'Security Scan requires an explicit local model whose runtime reports no tool-calling capability. CLI/TUI agents and unknown capability states are not eligible.'}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 mt-2">
        {needsSecurityModelPolicy
          ? 'Security Scan runs as a direct local, tool-free preflight; later stages run as separate agents. Stages are not scheduled independently.'
          : 'Each stage runs as a separate agent inside this pipeline; stages are not scheduled independently.'}
        {' Configure different providers per stage (e.g., Codex for review, Claude for implementation).'}
      </p>
    </div>
  );
}
