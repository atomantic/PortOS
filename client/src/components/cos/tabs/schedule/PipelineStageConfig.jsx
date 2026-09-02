import { useMemo } from 'react';
import { Link } from 'react-router';
import {
  effortAwareModelOptions,
  effortSurvivingModel,
  localBackendForProvider,
  publicReviewSelectionPolicy,
  supportsPublicReviewPosture,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
  PUBLIC_REVIEW_NO_TOOL_POSTURE,
} from '../../../../utils/providers';
import useLocalModels from '../../../../hooks/useLocalModels';
import ProviderModelSelector from '../../../ProviderModelSelector';
import ToggleSwitch from '../../../ToggleSwitch';
import {
  pipelineStages,
  prReviewerStageRole,
  stagePublicReviewPosture,
  togglePrReviewerActions,
} from './scheduleConstants';

// Which providers on THIS install can enforce a posture. The server publishes
// `publicReviewPostures` per provider, derived from the vendor rows, so the
// picker never carries its own list of vendor names — an install with only
// grok, only codex, or only a local Claude wrapper each get a correct list.
const eligibleProvidersFor = (providers, posture) =>
  (providers || []).filter((provider) => supportsPublicReviewPosture(provider, posture));

export default function PipelineStageConfig({ taskType, config, providers, onUpdate, updating, setUpdating }) {
  const stages = pipelineStages(config);
  const needsSecurityModelPolicy = taskType === 'pr-reviewer';
  const { ollama, lmstudio, capabilitiesByBackend, loading: localModelsLoading } = useLocalModels({
    enabled: needsSecurityModelPolicy,
  });
  // One policy per posture. The provider half is server-derived; the model half
  // adds the authoritative no-tool capability check only for a local runtime,
  // which is the only place PortOS can probe it.
  const selectionPolicies = useMemo(() => ({
    [PUBLIC_REVIEW_NO_TOOL_POSTURE]: publicReviewSelectionPolicy(PUBLIC_REVIEW_NO_TOOL_POSTURE, capabilitiesByBackend),
    [PUBLIC_REVIEW_ACTIONS_POSTURE]: publicReviewSelectionPolicy(PUBLIC_REVIEW_ACTIONS_POSTURE, capabilitiesByBackend),
  }), [capabilitiesByBackend]);

  const hasActionsStage = stages.some((stage) => prReviewerStageRole(stage) === 'actions');

  const handlePrReviewerActionsToggle = async (enabled) => {
    setUpdating(true);
    const updatedMeta = {
      ...config.taskMetadata,
      pipeline: {
        ...config.taskMetadata.pipeline,
        stages: togglePrReviewerActions(stages, enabled),
      },
    };
    await onUpdate(taskType, { taskMetadata: updatedMeta }).catch(() => {});
    setUpdating(false);
  };

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
      {needsSecurityModelPolicy && (
        <div className="rounded-lg border border-port-accent-2/30 bg-port-bg/60 px-3 py-3 mb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-white">Run final code review and actions</p>
              <p className="text-xs text-gray-400 mt-1">
                When enabled, a sandbox-capable reviewer applies only the screened patch, runs local tests, and returns a structured review for the deterministic GitHub coordinator. It is nested here, not a separate scheduled task.
              </p>
            </div>
            <ToggleSwitch
              enabled={hasActionsStage}
              onChange={() => handlePrReviewerActionsToggle(!hasActionsStage)}
              disabled={updating}
              ariaLabel="Enable final code review and actions"
              size="sm"
            />
          </div>
          {!hasActionsStage && (
            <p className="text-xs text-port-warning mt-2">
              Disabled runs stop after the tool-free eligibility gate; no PR comments, issue filing, CI triggers, or merge actions occur.
            </p>
          )}
        </div>
      )}
      <div className="space-y-3">
        {stages.map((stage, i) => {
          const stageProvider = providers?.find(p => p.id === stage.providerId);
          const role = needsSecurityModelPolicy
            ? (prReviewerStageRole(stage) || (i === 0 ? 'security' : i === 1 ? 'eligibility' : 'actions'))
            : null;
          const isSecurityStage = role === 'security';
          // The posture is read off the stage's own execution profile, so a
          // custom pipeline that reuses one of these profiles gets the same
          // gating without being a pr-reviewer stage.
          const posture = isSecurityStage ? null : stagePublicReviewPosture(stage);
          const isNoToolStage = posture === PUBLIC_REVIEW_NO_TOOL_POSTURE;
          const isActionsStage = Boolean(posture) && !isNoToolStage;
          const eligibleProviders = posture ? eligibleProvidersFor(providers, posture) : null;
          const localBackend = localBackendForProvider(stageProvider);
          const localModelIds = localBackend === 'ollama' ? ollama : localBackend === 'lmstudio' ? lmstudio : [];
          // A LOCAL provider's installed-model list is the source of truth (its
          // stored catalog is stale, and only an installed model has a probeable
          // capability report). Every other provider uses its own catalog, so a
          // cloud CLI stage can pick any model that provider offers.
          const stageModels = isNoToolStage && localBackend
            ? localModelIds.map(id => ({
              id,
              name: id,
              capabilities: capabilitiesByBackend?.[localBackend]?.[id],
            }))
            : effortAwareModelOptions(stageProvider, stage.model);
          const selectionPolicy = posture ? selectionPolicies[posture] : undefined;
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
                {isNoToolStage && (
                  <span className="text-[10px] px-1 py-0.5 bg-port-accent/15 text-port-accent rounded">tool-free gate</span>
                )}
                {isActionsStage && (
                  <span className="text-[10px] px-1 py-0.5 bg-port-accent-2/15 text-port-accent-2 rounded">sandboxed actions</span>
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
                  <p className="mt-1 text-gray-500">
                    Install or check readiness from{' '}
                    <Link to="/models/llms/abuse" className="underline hover:text-port-accent">Models → LLMs → Abuse Guard</Link>.
                  </p>
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
                  emptyProviderOption={posture
                    ? 'First eligible provider on this install'
                    : 'Default (task-level)'}
                  emptyModelOption={posture ? 'Use provider default model' : 'Default (task-level)'}
                  alwaysShowModel
                  selectionPolicy={selectionPolicy}
                  disabled={updating}
                />
              )}
              {posture && eligibleProviders?.length === 0 && (
                <p className="text-xs text-port-warning mt-2">
                  No enabled AI provider on this install can enforce the{' '}
                  {isActionsStage ? 'sandboxed-actions' : 'tool-free'} posture, so this stage will not run.
                  Enable a supported CLI provider in{' '}
                  <Link to="/ai" className="underline hover:text-port-accent">Settings → Providers</Link>.
                </p>
              )}
              {isNoToolStage && eligibleProviders?.length > 0 && (
                <p className="text-xs text-gray-500 mt-2">
                  {localModelsLoading
                    ? 'Loading installed local model capability reports…'
                    : `Tool-free stage. Eligible on this install: ${eligibleProviders.map((p) => p.name || p.id).join(', ')}. A local model must additionally report no tool-calling capability; a cloud model is held tool-free by the provider's own enforced flags. Leave the provider unset to use the first eligible one. It returns only a binary allowlist; the final stage never receives rejected content.`}
                </p>
              )}
              {isActionsStage && eligibleProviders?.length > 0 && (
                <p className="text-xs text-gray-500 mt-2">
                  {`Sandboxed stage. Eligible on this install: ${eligibleProviders.map((p) => p.name || p.id).join(', ')}. PortOS passes the selected provider, model, and thinking effort through that provider's maintained sandbox recipe, with no forge credential or configuration overlays; the deterministic coordinator owns comments, issue filing, CI triggers, and merges.`}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 mt-2">
        {needsSecurityModelPolicy
          ? 'Stage 1 screens complete public content with a managed classifier; only cleared content reaches the tool-free Eligibility Gate, and only eligible PRs reach the optional sandboxed final review. Stages are nested, not independently scheduled.'
          : 'Each stage runs as a separate agent inside this pipeline; stages are not scheduled independently.'}
        {' Configure a different provider, model, and thinking effort per stage.'}
      </p>
    </div>
  );
}
