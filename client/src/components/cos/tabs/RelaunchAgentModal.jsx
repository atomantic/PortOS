import { useMemo, useState } from 'react';
import { RefreshCw, Loader2, X } from 'lucide-react';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import Modal from '../../ui/Modal';
import AppContextPicker from '../../AppContextPicker';
import ProviderModelSelector from '../../ProviderModelSelector';
import { FormField } from '../../ui/FormField';
import CollapsibleText from '../../ui/CollapsibleText';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { effortAwareModelOptions, seedModelEffort } from '../../../utils/providers';
import { agentResumeMessage } from '../../../lib/agentResumeOutcome';

// What each relaunch outcome actually did. The server reuses `resumeAgent`'s
// modes (agentManagement.js): only `requeued` and `new-task` put work back on the
// queue — `already-active` and `superseded` deliberately queue NOTHING, so those
// carry no `running` wording and an unmapped mode falls through to the plain
// fallback rather than a message claiming the task was relaunched. See
// `agentResumeMessage` for the queued-vs-running contract.
const RELAUNCH_MESSAGES = {
  requeued: {
    queued: 'Relaunched — the task is queued again on its preserved worktree',
    running: 'Relaunched — the task is running again on its preserved worktree',
  },
  'new-task': {
    queued: 'Relaunched — a replacement task is queued',
    running: 'Relaunched — a replacement task is running',
  },
  'already-active': { queued: 'Its task is already queued or running — nothing new was created' },
  superseded: { queued: 'A later agent now holds this task paused — that pause was left intact' },
};

/**
 * Move a RUNNING agent's task onto a different provider/model/effort.
 *
 * The case this exists for: a run that is alive but going nowhere because its CLI
 * is parked on a provider usage limit. The server pauses the agent (worktree
 * preserved) and requeues its OWN task with these overrides — so the dialog only
 * edits what the next run should use, not what the task is.
 *
 * It owns the call and the outcome message rather than handing a payload back,
 * because it is mounted from two places (the agent card and the in-progress task
 * card) and the server's mode enum should have exactly one client reader.
 */
export default function RelaunchAgentModal({ agent, providers, providersLoaded = true, apps, onDone, onClose }) {
  const currentProvider = agent?.metadata?.providerId || agent?.metadata?.provider || '';
  const taskDescription = agent?.metadata?.taskDescription || agent?.taskId || 'Current task';

  const [formData, setFormData] = useState(() => {
    // Seeded from the stalled run so the dialog opens on what it was using —
    // and, for a pre-split Antigravity id, on the two halves the selects list.
    const seeded = seedModelEffort(
      providers?.find(p => p.id === currentProvider),
      agent?.metadata?.model,
      agent?.metadata?.effort,
    );
    return {
      provider: currentProvider,
      model: seeded.model,
      effort: seeded.effort,
      app: agent?.metadata?.taskApp || agent?.metadata?.app || '',
      note: ''
    };
  });

  const selectedProvider = useMemo(
    () => providers?.find(p => p.id === formData.provider),
    [providers, formData.provider]
  );
  const availableModels = useMemo(
    () => effortAwareModelOptions(selectedProvider, formData.model),
    [selectedProvider, formData.model]
  );

  const [submit, submitting] = useAsyncAction(async () => {
    // Blank means "keep what the stalled run had" (AGENTS.md's absent-vs-empty
    // rule) — the server treats a falsy override as unchanged.
    const result = await api.relaunchCosAgent(agent.id, {
      provider: formData.provider || undefined,
      model: formData.model || undefined,
      effort: formData.effort || undefined,
      app: formData.app || undefined,
      context: formData.note.trim() || undefined
    }, { silent: true });
    toast.success(agentResumeMessage(result, RELAUNCH_MESSAGES, 'Relaunched'));
    onDone?.(result);
    onClose();
    return result;
  }, { errorMessage: 'Failed to relaunch agent' });

  return (
    <Modal
      open
      onClose={onClose}
      closeOnBackdrop={false}
      size="lg"
      align="none"
      backdropClassName="bg-black/50"
      panelClassName="bg-port-card border border-port-border rounded-xl p-6"
      ariaLabelledBy="relaunch-agent-title"
    >
      <div className="flex items-center justify-between mb-4">
        <h2 id="relaunch-agent-title" className="text-xl font-bold text-white">
          Relaunch on a different model
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close relaunch agent modal"
          className="text-gray-500 hover:text-white transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <div className="mb-4 p-3 bg-port-bg border border-port-border rounded-lg">
        <div className="text-sm text-gray-400 mb-1">Current task</div>
        {/* A task description is the agent's whole prompt — routinely hundreds of
            lines. Rendered in full it pushes the provider/model selects and the
            Relaunch button off a phone screen, so it opens clamped. Expanding
            swaps in a height-capped scroll box rather than unclamping in place:
            the point of the dialog is the controls below it, and an expanded
            prompt must not bury them again. */}
        <CollapsibleText
          id={`relaunch-task-${agent?.id || 'current'}`}
          text={taskDescription}
          lines={3}
          className="text-white"
          expandedContent={taskDescription}
          expandedClassName="max-h-48 overflow-y-auto whitespace-pre-wrap"
        />
        <div className="text-sm text-gray-400 mt-2">
          This stops the running agent and restarts the same task on the worktree it leaves
          behind — no second agent, and nothing to clean up afterward. It starts right away
          when an agent slot is free, and stays queued until one is otherwise.
        </div>
      </div>

      <form
        onSubmit={e => { e.preventDefault(); submit(); }}
        className="space-y-4"
      >
        <FormField label="Target App">
          <AppContextPicker
            apps={apps}
            value={formData.app}
            onChange={app => setFormData(d => ({ ...d, app }))}
            showRepoPath={false}
            ariaLabel="Target app"
          />
        </FormField>

        <ProviderModelSelector
          providers={providers || []}
          selectedProviderId={formData.provider}
          selectedModel={formData.model}
          availableModels={availableModels}
          onProviderChange={provider => setFormData(d => ({ ...d, provider, model: '', effort: '' }))}
          onModelChange={model => setFormData(d => ({ ...d, model }))}
          effort={formData.effort}
          onEffortChange={effort => setFormData(d => ({ ...d, effort }))}
          emptyProviderOption="Auto (default)"
          emptyModelOption="Default model"
          alwaysShowModel
          highlightToolUse
          loading={!providersLoaded}
        />

        <FormField label="Additional Instructions (optional)">
          <textarea
            value={formData.note}
            onChange={e => setFormData(d => ({ ...d, note: e.target.value }))}
            placeholder="Anything the relaunched run should know..."
            rows={3}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden resize-none"
          />
        </FormField>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center gap-2 px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {submitting ? 'Relaunching...' : 'Relaunch Agent'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
