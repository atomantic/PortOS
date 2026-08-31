import { useEffect, useState } from 'react';
import { Loader2, MessageSquareText, Sparkles } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import { FormField } from '../ui/FormField.jsx';
import toast from '../ui/Toast';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import useFableLoomAiRun from '../../hooks/useFableLoomAiRun';
import useProviderModels from '../../hooks/useProviderModels';
import { feedbackLoomEpisode } from '../../services/api';
import { effectiveModelFor, effortAwareModelOptions } from '../../utils/providers';
import { fieldClass, labelClass } from './fieldStyles';
import LoomAiRunStatus from './LoomAiRunStatus';

/**
 * Conversational editor for one episode. The route selection is deliberately
 * per submission rather than persisted on the loom: feedback is an explicit
 * one-off author action, and the provider/model/effort can change for the next
 * instruction without changing how readers play the story.
 */
export default function LoomEpisodeFeedback({
  open,
  loom,
  episode,
  onLoomUpdate,
  onFeedbackStarted,
  disabled = false,
  onRunningChange,
}) {
  const [feedback, setFeedback] = useState('');
  const [route, setRoute] = useState({ providerId: '', model: '', effort: '' });
  const { run: aiRun, begin: beginAiRun, fail: failAiRun } = useFableLoomAiRun();
  const { providers, loading: providersLoading } = useProviderModels({
    allowDefault: true,
    silent: true,
    withEffort: true,
    enabled: open,
  });
  const selectedProvider = providers.find((provider) => provider.id === route.providerId);
  const selectedModel = effectiveModelFor(selectedProvider, route.model);

  useEffect(() => {
    setFeedback('');
    setRoute({ providerId: '', model: '', effort: '' });
  }, [episode.id]);

  const [runFeedback, submitting] = useAsyncAction(async () => {
    const operationId = beginAiRun();
    onFeedbackStarted?.();
    const result = await feedbackLoomEpisode(loom.id, episode.id, {
      feedback: feedback.trim(),
      operationId,
      ...(route.providerId ? { providerId: route.providerId } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(route.effort ? { effort: route.effort } : {}),
    }, { silent: true }).catch((error) => {
      failAiRun(error.message);
      throw error;
    });
    onLoomUpdate(result.loom);
    setFeedback('');
    toast.success(result.changedScenes
      ? `Episode updated — ${result.changedScenes} scene${result.changedScenes === 1 ? '' : 's'} changed`
      : 'Episode updated');
  }, { errorMessage: 'Episode feedback failed' });

  useEffect(() => {
    onRunningChange?.(submitting);
  }, [onRunningChange, submitting]);

  return (
    <section className="border-t border-port-border pt-4 space-y-3">
      <h4 className="text-sm font-semibold flex items-center gap-1.5">
        <MessageSquareText size={14} className="text-port-accent" /> AI feedback
      </h4>
      <p className="text-xs text-port-text-muted">
        Tell the editor what to change in plain language. It can revise the title,
        synopsis, existing scene text, and path labels without adding or removing
        scene records.
      </p>
      <FormField
        label="What should change?"
        labelClassName={labelClass}
        hint="For example: Make the opening more tense, and give the hopeful ending a clearer cost."
      >
        <textarea
          rows={5}
          className={fieldClass}
          placeholder="Describe the rewrite or update you want…"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          disabled={disabled || submitting}
        />
      </FormField>
      <ProviderModelSelector
        providers={providers}
        selectedProviderId={route.providerId}
        selectedModel={route.model}
        availableModels={effortAwareModelOptions(selectedProvider, route.model)}
        onProviderChange={(providerId) => setRoute({ providerId, model: '', effort: '' })}
        onModelChange={(model) => setRoute((current) => ({ ...current, model }))}
        effort={route.effort}
        onEffortChange={(effort) => setRoute((current) => ({ ...current, effort }))}
        label="AI route"
        layout="stacked"
        disabled={disabled || submitting || providersLoading}
        modelDisabled={disabled || submitting || providersLoading}
        emptyProviderOption="Default (feedback stage or active provider)"
        emptyModelOption="Default model"
        alwaysShowModel={!!route.providerId}
      />
      {selectedProvider && (
        <p className="text-xs text-port-text-muted">
          This edit will use {selectedProvider.name}
          {selectedModel ? ` (${selectedModel})` : ''}.
        </p>
      )}
      <button
        type="button"
        onClick={runFeedback}
        disabled={disabled || submitting || !feedback.trim()}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-60"
      >
        {submitting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
        {submitting ? 'Updating episode…' : 'Apply AI feedback'}
      </button>
      <LoomAiRunStatus run={aiRun} />
    </section>
  );
}
