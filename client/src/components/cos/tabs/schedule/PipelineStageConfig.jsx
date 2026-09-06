import { useMemo } from 'react';
import { Link } from 'react-router';
import {
  effortAwareModelOptions,
  effortSurvivingModel,
  enforcesPublicReviewPosture,
  localBackendForProvider,
  publicReviewSelectionPolicy,
  selectableProviders,
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

// Which providers on THIS install the stage's picker actually offers. The
// posture half is server-published (`publicReviewPostures`, derived from the
// vendor rows — no vendor names on the client); the rest is the picker's own
// visibility rule, reused so the notes below can never name a provider the
// dropdown hides (switched off, hardware-incompatible). The eligible set is
// not re-listed in the copy — the dropdown already IS that list.
const eligibleProvidersFor = (providers, policy) =>
  selectableProviders(providers, { allowed: policy.provider });

const providerNames = (providers) => providers.map((p) => p.name || p.id).join(', ');

// Constant now that the eligible set is left to the dropdown.
const NO_TOOL_STAGE_NOTE = "A local model must additionally report no tool-calling capability; a cloud model is held tool-free by the provider's own enforced flags. Leave the provider unset to use the first eligible one.";

// Every enabled CLI/TUI provider can run the actions stage; the note says which
// of them the server additionally wraps in the vendor's own OS sandbox, so a
// choice that relies on the disposable worktree alone is a visible one.
const actionsStageNote = (eligibleProviders) => {
  const isSandboxed = (p) => enforcesPublicReviewPosture(p, PUBLIC_REVIEW_ACTIONS_POSTURE);
  const sandboxed = eligibleProviders.filter(isSandboxed);
  const worktreeOnly = eligibleProviders.filter((p) => !isSandboxed(p));
  const isolation = worktreeOnly.length === 0
    ? ['Every selectable provider runs headless inside its vendor\'s maintained OS sandbox.']
    : [
      sandboxed.length > 0 && `OS-sandboxed by the vendor's own recipe: ${providerNames(sandboxed)}.`,
      `Headless with standard permissions, isolated by the disposable worktree only: ${providerNames(worktreeOnly)}.`,
    ].filter(Boolean);
  return [
    'Sandboxed stage.',
    ...isolation,
    'PortOS passes the selected provider, model, and thinking effort through, with no forge credential or configuration overlays; the deterministic coordinator owns comments, issue filing, CI triggers, and merges.',
  ].join(' ');
};

export default function PipelineStageConfig({ taskType, config, providers, providersLoaded = true, onUpdate, updating, setUpdating }) {
  const stages = pipelineStages(config);
  const needsSecurityModelPolicy = taskType === 'pr-reviewer';
  // Every public-review stage — not just the tool-free gate — resolves a local
  // provider's models from the daemon, so the fetch follows the postures rather
  // than the task type.
  const hasPublicReviewStage = stages.some((stage) => stagePublicReviewPosture(stage));
  const { ollama, lmstudio, capabilitiesByBackend, loading: localModelsLoading } = useLocalModels({
    enabled: needsSecurityModelPolicy || hasPublicReviewStage,
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
                When enabled, a tool-free reviewer analyzes screened PR content and returns a structured static review. The deterministic GitHub coordinator validates any resulting actions. Contributor code is never executed. This stage is nested here, not a separate scheduled task.
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
          // PR roles reassert the server's no-tool contract even for legacy
          // profiles or position-only stages. Other pipelines keep their profile.
          const posture = isSecurityStage ? null : stagePublicReviewPosture(role ? { ...stage, role } : stage);
          const isNoToolStage = posture === PUBLIC_REVIEW_NO_TOOL_POSTURE;
          const isActionsStage = Boolean(posture) && !isNoToolStage;
          const eligibleProviders = posture ? eligibleProvidersFor(providers, selectionPolicies[posture]) : null;
          const localBackend = localBackendForProvider(stageProvider);
          const localModelIds = localBackend === 'ollama' ? ollama : localBackend === 'lmstudio' ? lmstudio : [];
          // Both PR analysis stages require the local daemon's capability report.
          // Cached models cannot establish no-tool eligibility when it is offline.
          // Generic sandboxed-action stages retain their catalog fallback.
          const localStageModels = localModelIds.map(id => ({
            id,
            name: id,
            capabilities: capabilitiesByBackend?.[localBackend]?.[id],
          }));
          const stageModels = posture && localBackend && (isNoToolStage || localStageModels.length > 0)
            ? localStageModels
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
                  <span className="text-[10px] px-1 py-0.5 bg-port-accent/15 text-port-accent rounded">{role === 'actions' ? 'tool-free review' : 'tool-free gate'}</span>
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
                  <p className="font-medium text-port-accent">Deterministic hidden-content screen</p>
                  <p className="mt-1">Server-side checks on each external PR&apos;s complete title, description, and diff for content a human reviewer would miss — invisible or direction-control Unicode, comments GitHub never renders that address a model — and for obvious model-directed harm: instruction overrides, decode-and-follow or download-and-run instructions, credential exfiltration, and attempts to steer the review verdict. No model, tools, repository checkout, or GitHub credentials are involved.</p>
                  <p className="mt-1 text-gray-500">
                    The pinned Llama Prompt Guard 2 classifier is required by default. Install and configure it on{' '}
                    <Link to="/models/llms/abuse" className="underline hover:text-port-accent">Models → LLMs → Abuse Guard</Link>.
                  </p>
                </div>
              )}
              {!isSecurityStage && (
                <ProviderModelSelector
                  loading={!providersLoaded}
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
                    : `${role === 'actions' ? 'Tool-free review. Returns a structured static review for server-validated actions; it cannot run contributor code or tests.' : role === 'eligibility' ? 'Tool-free stage. Returns only a binary allowlist; rejected content never reaches the final review.' : 'Tool-free stage.'} ${NO_TOOL_STAGE_NOTE}`}
                </p>
              )}
              {isActionsStage && eligibleProviders?.length > 0 && (
                <p className="text-xs text-gray-500 mt-2">
                  {/* On a local provider this stage's model list comes from the
                      daemon too, so say so while it loads rather than leaving an
                      empty dropdown with a note that reads as if it were ready. */}
                  {localBackend && localModelsLoading
                    ? 'Loading installed local models…'
                    : actionsStageNote(eligibleProviders)}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 mt-2">
        {needsSecurityModelPolicy
          ? 'Stage 1 screens complete public content with a managed classifier; only cleared content reaches the tool-free Eligibility Gate, and only eligible PRs reach the optional tool-free final review. The server validates resulting GitHub actions. Stages are nested, not independently scheduled.'
          : 'Each stage runs as a separate agent inside this pipeline; stages are not scheduled independently.'}
        {' Configure a different provider, model, and thinking effort per stage.'}
      </p>
    </div>
  );
}
