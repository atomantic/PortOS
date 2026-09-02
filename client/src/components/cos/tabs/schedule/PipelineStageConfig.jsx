import { useMemo } from 'react';
import {
  effortAwareModelOptions,
  effortSurvivingModel,
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
  // Stage 2 uses the same authoritative no-tool model predicate, but its
  // provider is a maintained local Claude wrapper rather than a direct HTTP
  // backend. The server-derived marker is the provider-side capability gate;
  // the shared policy still requires a local installed model with text
  // capability and no `tools` capability.
  const publicReviewSelectionPolicy = useMemo(
    () => toolFreeLocalSelectionPolicy(capabilitiesByBackend, {
      providerPredicate: (provider) => provider?.publicReviewSupported === true,
    }),
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
          const isPublicReviewStage = needsSecurityModelPolicy && i === 1;
          const localBackend = localBackendForProvider(stageProvider);
          const localModelIds = localBackend === 'ollama' ? ollama : localBackend === 'lmstudio' ? lmstudio : [];
          // Keep the richer capability object on each local option so the shared
          // policy does not need a second lookup. The status hook's ids are the
          // installed-model source of truth; a provider's stale catalog is never
          // enough to make a model eligible for a security scan.
          const stageModels = isPublicReviewStage
            ? localModelIds.map(id => ({
              id,
              name: id,
              capabilities: capabilitiesByBackend?.[localBackend]?.[id],
            }))
            : effortAwareModelOptions(stageProvider, stage.model);
          const selectionPolicy = isPublicReviewStage ? publicReviewSelectionPolicy : undefined;
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
              {isSecurityStage && (
                <div className="rounded-lg border border-port-accent/30 bg-port-bg/60 px-3 py-2 text-xs text-gray-300">
                  <p className="font-medium text-port-accent">Managed Llama Prompt Guard 2 86M</p>
                  <p className="mt-1">Fixed, pinned, offline classifier. It scans complete external content before Stage 2 and never appears as a chat model or receives tools, MCP servers, repository files, or GitHub credentials.</p>
                  <p className="mt-1 text-gray-500">Install or check readiness from Models → LLMs → Model Library.</p>
                </div>
              )}
              {!isSecurityStage && (
                <ProviderModelSelector
                  providers={providers || []}
                  selectedProviderId={stageProviderId}
                  selectedModel={stageModel}
                  availableModels={stageModels}
                  onProviderChange={(providerId) => updateStage('providerId', providerId)}
                  onModelChange={(model) => updateStage('model', model)}
                  effort={stageEffort}
                  onEffortChange={(effort) => updateStage('effort', effort)}
                  emptyProviderOption={isPublicReviewStage ? 'Select enforced local review provider (required)' : 'Default (task-level)'}
                  emptyModelOption={isPublicReviewStage ? 'Select installed no-tool model (required)' : 'Default (task-level)'}
                  alwaysShowModel
                  selectionPolicy={selectionPolicy}
                  disabled={updating}
                />
              )}
              {isPublicReviewStage && (
                <p className="text-xs text-gray-500 mt-2">
                  {localModelsLoading
                    ? 'Loading installed local model capability reports…'
                    : 'Stage 2 accepts only the maintained local Claude wrapper and an installed text model whose runtime reports no tool-calling capability. The reviewer is read-only; the deterministic coordinator owns comments, approvals, rebases, and merges.'}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 mt-2">
        {needsSecurityModelPolicy
          ? 'Stage 1 screens complete public content with a managed classifier; only cleared content reaches the read-only Stage 2 reviewer. Stages are nested, not independently scheduled.'
          : 'Each stage runs as a separate agent inside this pipeline; stages are not scheduled independently.'}
        {' Configure different providers per stage (e.g., Codex for review, Claude for implementation).'}
      </p>
    </div>
  );
}
