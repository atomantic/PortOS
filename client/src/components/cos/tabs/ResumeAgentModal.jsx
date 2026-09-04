import { useState, useRef } from 'react';
import { X, CheckCircle, AlertCircle, RotateCcw, Image, Loader2 } from 'lucide-react';
import { processScreenshotUploads } from '../../../services/apiMedia';
import toast from '../../ui/Toast';
import Modal from '../../ui/Modal';
import FilePickerButton from '../../ui/FilePickerButton';
import { FormField } from '../../ui/FormField';
import EffortSelect from '../EffortSelect';
import { effectiveModelFor, effortAwareModelOptions, effortSurvivingModel, seedModelEffort } from '../../../utils/providers';

export default function ResumeAgentModal({ agent, taskType = 'user', providers, providersLoaded = true, apps, onSubmit, onClose }) {
  // A paused agent resumes IN PLACE: its own task is requeued on the worktree its
  // run left behind. Everything else (a completed/failed run, whose task is long
  // settled) can only be continued by queueing a new task.
  const isPaused = agent.status === 'paused';
  const taskDescription = agent.metadata?.taskDescription || agent.taskId || 'Resume previous task';
  const outputSummary = agent.output?.length > 0
    ? agent.output.slice(-20).map(o => o.line).join('\n')
    : '';
  const resultInfo = agent.result
    ? (agent.result.success ? 'Previous run: Completed successfully' : `Previous run: Failed - ${agent.result.error || 'Unknown error'}`)
    : '';
  const pauseInfo = isPaused
    ? `Previous run: Paused${agent.metadata?.pauseReason ? ` - ${agent.metadata.pauseReason}` : ''}`
    : '';
  const resumeWorkspace = agent.metadata?.resumeWorkspacePath || agent.metadata?.workspacePath;
  const worktreeInfo = [
    resumeWorkspace ? `Resume Workspace: ${resumeWorkspace}` : '',
    agent.metadata?.worktreeBranch ? `Worktree Branch: ${agent.metadata.worktreeBranch}` : '',
    agent.metadata?.isWorktree ? 'The previous worktree and any uncommitted changes were intentionally preserved. Continue from that workspace instead of starting over.' : ''
  ].filter(Boolean).join('\n');

  const initialContext = [
    '## Previous Agent Context',
    `Agent ID: ${agent.id}`,
    `Original Task: ${taskDescription}`,
    pauseInfo || resultInfo,
    worktreeInfo ? `\n## Preserved Workspace\n${worktreeInfo}` : '',
    outputSummary ? `\n## Last Output:\n\`\`\`\n${outputSummary}\n\`\`\`` : ''
  ].filter(Boolean).join('\n');

  const [formData, setFormData] = useState(() => {
    const provider = agent.metadata?.providerId || agent.metadata?.provider || '';
    // The agent being resumed may have run on a pre-split Antigravity id
    // (`gemini-3.6-flash-high`), which the Model select no longer lists. Seed the
    // two controls from its halves so the resumed run keeps the same tier.
    const seeded = seedModelEffort(
      providers?.find(p => p.id === provider),
      agent.metadata?.model,
      agent.metadata?.effort,
    );
    return {
      refinedInstructions: '',
      provider,
      model: seeded.model,
      effort: seeded.effort,
      app: agent.metadata?.taskApp || agent.metadata?.app || ''
    };
  });
  const [screenshots, setScreenshots] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleFileSelect = async (e) => {
    await processScreenshotUploads(e.target.files, {
      onSuccess: (fileInfo) => setScreenshots(prev => [...prev, fileInfo]),
      onError: (msg) => toast.error(msg)
    });
  };

  const removeScreenshot = (id) => {
    setScreenshots(prev => prev.filter(s => s.id !== id));
  };

  // The modal carries its own Thinking Effort select and submits it, so
  // Antigravity lists BASE models with the tier picked separately.
  const selectedProvider = providers?.find(p => p.id === formData.provider);
  const availableModels = effortAwareModelOptions(selectedProvider, formData.model);

  const submittingRef = useRef(false);
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);

    const fullContext = formData.refinedInstructions.trim()
      ? `## Additional Instructions\n${formData.refinedInstructions}\n\n${initialContext}`
      : initialContext;

    await onSubmit({
      description: `[Resume] ${taskDescription}`,
      context: fullContext,
      model: formData.model,
      provider: formData.provider,
      effort: formData.effort,
      app: formData.app,
      type: taskType,
      screenshots: screenshots.length > 0 ? screenshots.map(s => s.path) : undefined
    }).then(() => {
      onClose();
    }).catch(err => {
      toast.error(err?.message || 'Failed to resume agent');
      submittingRef.current = false;
      setIsSubmitting(false);
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      // Resume modal historically had neither backdrop dismiss nor Esc; an
      // accidental dismiss would lose user-typed refined instructions.
      closeOnBackdrop={false}
      closeOnEsc={false}
      size="lg"
      // Pre-refactor overlay had no padding — `fixed inset-0 ... flex
      // items-center justify-center` with no `p-*`. Preserve that so the
      // panel still reaches viewport edges on small screens. `align='none'`
      // applies the same flex centring without the default `p-4`.
      align="none"
      backdropClassName="bg-black/50"
      panelClassName="bg-port-card border border-port-border rounded-xl p-6"
      ariaLabelledBy="resume-agent-title"
    >
      <div className="flex items-center justify-between mb-4">
          <h2 id="resume-agent-title" className="text-xl font-bold text-white">
            Resume {taskType === 'internal' ? 'System ' : ''}Agent Task
          </h2>
          <button
            onClick={onClose}
            aria-label="Close resume agent modal"
            className="text-gray-500 hover:text-white transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        {/* Previous Task Info */}
        <div className="mb-4 p-3 bg-port-bg border border-port-border rounded-lg">
          <div className="text-sm text-gray-400 mb-1">
            {isPaused ? 'Paused Task (will be resumed in place)' : 'Original Task'}
          </div>
          <div className="text-white">{taskDescription}</div>
          {isPaused && (
            <div className="text-sm text-gray-400 mt-2">
              This requeues the same task on the worktree the paused run left behind — no second agent, and nothing to clean up afterward.
            </div>
          )}
          {agent.result && (
            <div className={`text-sm mt-2 flex items-center gap-2 ${agent.result.success ? 'text-port-success' : 'text-port-error'}`}>
              {agent.result.success ? (
                <><CheckCircle size={14} /> Completed successfully</>
              ) : (
                <><AlertCircle size={14} /> {agent.result.error || 'Failed'}</>
              )}
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Refined Instructions */}
          <FormField label="Additional Instructions (optional)">
            <textarea
              value={formData.refinedInstructions}
              onChange={e => setFormData({ ...formData, refinedInstructions: e.target.value })}
              placeholder="Provide refined or additional instructions for the resumed task..."
              rows={4}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden resize-none"
              autoFocus
            />
          </FormField>

          {/* Screenshot Upload */}
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <FilePickerButton
                accept="image/*"
                multiple
                onChange={handleFileSelect}
                ariaLabel="Add screenshots"
                className="flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 hover:text-white text-sm transition-colors"
              >
                <Image size={16} aria-hidden="true" />
                Add Screenshot
              </FilePickerButton>
              {screenshots.length > 0 && (
                <span className="text-xs text-gray-500">{screenshots.length} screenshot{screenshots.length > 1 ? 's' : ''}</span>
              )}
            </div>
            {screenshots.length > 0 && (
              <div className="flex gap-2 flex-wrap mt-2">
                {screenshots.map(s => (
                  <div key={s.id} className="relative group">
                    <img
                      src={s.preview}
                      alt={s.filename}
                      className="w-20 h-20 object-cover rounded-lg border border-port-border"
                    />
                    <button
                      type="button"
                      onClick={() => removeScreenshot(s.id)}
                      className="absolute -top-2 -right-2 w-5 h-5 bg-port-error rounded-full flex items-center justify-center md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 md:focus-visible:opacity-100 transition-opacity"
                      aria-label={`Remove screenshot ${s.filename}`}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* App Selection */}
          <FormField label="Target App">
            <select
              value={formData.app}
              onChange={e => setFormData({ ...formData, app: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
            >
              <option value="">PortOS (default)</option>
              {apps?.map(app => (
                <option key={app.id} value={app.id}>{app.name}</option>
              ))}
            </select>
          </FormField>

          {/* Provider, Model and Thinking Effort */}
          <div className="flex flex-col sm:flex-row gap-3">
            <FormField label="Provider" className="flex-1">
              <select
                value={formData.provider}
                onChange={e => setFormData({ ...formData, provider: e.target.value, model: '', effort: '' })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                disabled={!providersLoaded}
              >
                {/* Mid-fetch, `providers` is empty — say so instead of rendering a
                    picker whose only option looks like a broken control. */}
                {providersLoaded
                  ? <option value="">Auto (default)</option>
                  : <option value="">Loading providers…</option>}
                {providersLoaded && providers?.filter(p => p.enabled).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Model" className="flex-1">
              <select
                value={formData.model}
                onChange={e => setFormData(d => ({
                  ...d,
                  model: e.target.value,
                  // A model with no effort tiers hides the select beside it — clear
                  // the value with it instead of resuming on a level the UI dropped.
                  effort: effortSurvivingModel(selectedProvider, e.target.value, d.effort),
                }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                disabled={!providersLoaded || !formData.provider}
              >
                <option value="">{!providersLoaded ? 'Loading providers…' : formData.provider ? 'Select model...' : 'Select provider first'}</option>
                {availableModels.map(m => (
                  <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                ))}
              </select>
            </FormField>
            <EffortSelect
              provider={selectedProvider}
              model={effectiveModelFor(selectedProvider, formData.model)}
              value={formData.effort}
              onChange={effort => setFormData(d => ({ ...d, effort }))}
              label="Thinking Effort"
              fieldClassName="flex-1"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
            />
          </div>

          {/* Context Preview (collapsed) */}
          <details className="text-sm">
            <summary className="text-gray-400 cursor-pointer hover:text-white transition-colors">
              View context to be included
            </summary>
            <pre className="mt-2 p-3 bg-port-bg border border-port-border rounded-lg text-gray-400 text-xs overflow-auto max-h-48 whitespace-pre-wrap break-all">
              {initialContext}
            </pre>
          </details>

          {/* Actions */}
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
              disabled={isSubmitting}
              className="flex items-center gap-2 px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              {isSubmitting ? 'Queuing...' : (isPaused ? 'Resume Agent' : 'Queue Resume Task')}
            </button>
          </div>
        </form>
    </Modal>
  );
}
