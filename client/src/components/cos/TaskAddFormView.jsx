import { Plus, Image, X, ChevronDown, ChevronRight, Sparkles, Loader2, Paperclip, FileText, Zap, Bookmark, Ticket, GitBranch, GitPullRequest, Wand2 } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import AppContextPicker from '../AppContextPicker';
import FilePickerButton from '../ui/FilePickerButton';
import ReviewerPicker from './ReviewerPicker';
import InstancePicker from './InstancePicker';
import { ATTACHMENT_ACCEPT } from '../../utils/fileUpload';
import { formatBytes } from '../../utils/formatters';
import {
  effortAwareModelOptions,
  generationControlsFor,
  isOpencodeLocalProvider,
  providerModeSelectionPolicy,
} from '../../utils/providers';
import { PR_COMPLETION_OPTIONS, prCompletionOption } from './constants';
import { clickableProps, onActivateKeyDown } from '../../lib/a11yKeyboard';
import { slashdoLabel } from '../../lib/slashdoCatalog';

const ORCHESTRATION_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const ORCHESTRATION_ROLES_META = [
  { key: 'architect', label: 'Architect', hint: 'Planning & spec authoring' },
  { key: 'implementer', label: 'Implementer', hint: 'Spec execution' },
  { key: 'reviewer', label: 'Reviewer', hint: 'Spec verification' },
];
const AGENT_HARNESS_POLICY = providerModeSelectionPolicy('agent-harness');

function TaskSubmitButton({ form, variant = 'full' }) {
  const { state, handleAddTask } = form;
  const disabled = state.isSubmitting || state.isEnhancing;
  const isQueue = variant === 'queue';
  const isCompact = variant === 'compact';
  const label = isQueue
    ? state.isSubmitting
      ? 'Adding...'
      : state.planOnly
        ? 'Plan & File Issue'
        : state.enhancePrompt
          ? 'Enhance & Add task'
          : 'Add task'
    : isCompact
      ? state.isSubmitting
        ? state.planOnly ? 'Planning...' : 'Adding...'
        : state.planOnly ? 'Plan & File' : 'Add'
      : state.isSubmitting || state.isEnhancing
        ? state.planOnly ? 'Enhancing plan...' : 'Enhancing...'
        : state.planOnly
          ? state.enhancePrompt ? 'Enhance & Plan' : 'Plan & File Issue'
          : state.enhancePrompt
            ? 'Enhance & Add'
            : 'Add';

  return (
    <button
      type="button"
      onClick={handleAddTask}
      disabled={disabled}
      className={isQueue
        ? 'min-h-[44px] flex items-center gap-1 px-3 py-2 text-sm bg-port-accent/20 text-port-accent rounded-lg disabled:opacity-50'
        : isCompact
          ? 'flex shrink-0 items-center gap-1 whitespace-nowrap px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 min-h-[44px]'
          : 'flex items-center gap-1 px-3 py-2 text-sm bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px]'}
    >
      {disabled ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
      {label}
    </button>
  );
}

function TaskTemplates({ form }) {
  const { state, quickTemplatesEnabled, applyTemplate, deleteTemplate, setField } = form;
  if (!quickTemplatesEnabled || state.templates.length === 0) return null;
  return (
    <div className="mb-4">
      <button
        onClick={() => setField('showTemplates', !state.showTemplates)}
        className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors mb-2"
        aria-expanded={state.showTemplates}
      >
        {state.showTemplates ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Zap size={14} className="text-yellow-500" />
        Quick Templates
        <span className="text-xs text-gray-600">({state.templates.length})</span>
      </button>
      {state.showTemplates && (
        <div className="flex flex-wrap gap-2">
          {state.templates.map((template) => (
            <div
              key={template.id}
              onClick={() => applyTemplate(template)}
              {...clickableProps(() => applyTemplate(template))}
              onKeyDown={onActivateKeyDown(() => applyTemplate(template))}
              className="group relative flex items-center gap-1 px-3 py-1.5 bg-port-card border border-port-border rounded-lg text-sm text-gray-300 hover:text-white hover:border-port-accent/50 transition-colors cursor-pointer"
              title={template.slashdoCommand ? `${slashdoLabel(template.slashdoCommand)} — ${template.context || template.description}` : template.description}
            >
              <span>{template.icon || '📝'}</span>
              <span className="max-w-[120px] truncate">{template.name}</span>
              {template.slashdoCommand && <span className="hidden @sm:inline text-xs text-port-accent/80 font-mono">{slashdoLabel(template.slashdoCommand)}</span>}
              {template.useCount > 0 && <span className="text-xs text-gray-600">({template.useCount})</span>}
              {!template.isBuiltin && (
                <button
                  onClick={(event) => deleteTemplate(template.id, event)}
                  className="flex md:hidden md:group-hover:flex absolute -top-3 -right-3 w-11 h-11 items-center justify-center"
                  aria-label="Delete template"
                >
                  <span className="flex w-4 h-4 bg-port-error rounded-full items-center justify-center">
                    <X size={10} />
                  </span>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskUploadControls({ form }) {
  const { state, handleFileSelect, handleAttachmentSelect } = form;
  return (
    <div className="flex items-center gap-2 shrink-0 flex-wrap">
      <FilePickerButton
        accept="image/*"
        multiple
        onChange={handleFileSelect}
        ariaLabel="Attach screenshots"
        className="flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 hover:text-white text-sm transition-colors min-h-[44px]"
      >
        <Image size={16} aria-hidden="true" />
        Screenshot
      </FilePickerButton>
      <FilePickerButton
        accept={ATTACHMENT_ACCEPT}
        multiple
        onChange={handleAttachmentSelect}
        ariaLabel="Attach files"
        className="flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 hover:text-white text-sm transition-colors min-h-[44px]"
      >
        <Paperclip size={16} aria-hidden="true" />
        Attach
      </FilePickerButton>
      {state.screenshots.length > 0 && <span className="text-xs text-gray-500">{state.screenshots.length} screenshot{state.screenshots.length > 1 ? 's' : ''}</span>}
      {state.attachments.length > 0 && <span className="text-xs text-gray-500">{state.attachments.length} file{state.attachments.length > 1 ? 's' : ''}</span>}
    </div>
  );
}

function TaskUploadPreviews({ form }) {
  const { state, removeScreenshot, removeAttachment } = form;
  if (state.screenshots.length === 0 && state.attachments.length === 0) return null;
  return (
    <div className="space-y-2">
      {state.screenshots.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {state.screenshots.map((screenshot) => (
            <div key={screenshot.id} className="relative group">
              <img src={screenshot.preview} alt={screenshot.filename} className="w-20 h-20 object-cover rounded-lg border border-port-border" />
              <button
                type="button"
                onClick={() => removeScreenshot(screenshot.id)}
                className="absolute -top-2 -right-2 w-5 h-5 bg-port-error rounded-full flex items-center justify-center md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 md:focus-visible:opacity-100 transition-opacity"
                aria-label={`Remove screenshot ${screenshot.filename}`}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      {state.attachments.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {state.attachments.map((attachment) => (
            <div key={attachment.id} className="flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 hover:text-white text-sm transition-colors min-h-[44px]">
              {attachment.isImage && attachment.preview ? (
                <img src={attachment.preview} alt={attachment.originalName} className="w-8 h-8 object-cover rounded" />
              ) : (
                <FileText size={20} className="text-gray-500" aria-hidden="true" />
              )}
              <div className="flex flex-col">
                <span className="text-xs text-white truncate max-w-[120px]" title={attachment.originalName}>{attachment.originalName}</span>
                <span className="text-xs text-gray-500">{formatBytes(attachment.size)}</span>
              </div>
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center ml-1 p-0.5 text-gray-500 hover:text-port-error transition-colors"
                aria-label={`Remove attachment ${attachment.originalName}`}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskTypeFields({ form, compact, queueFirst }) {
  const {
    state,
    setTaskField,
    setField,
    selectedProvider,
    enabledProviders,
    apiOnlyProviders,
    availableModels,
    modelOptions,
    selectedModelOrSole,
    modelSourceNote,
    providerModelNote,
    isFederated,
    assignableInstances,
    handleAppChange,
    handleProviderChange,
    handleSelectOrchestrationProfile,
    updateOrchestrationRoleField,
  } = form;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-port-border/40">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-400">
          <span>Execution:</span>
          <button
            type="button"
            onClick={() => setField('orchestrationMode', 'direct')}
            className={`px-2.5 py-1 rounded text-xs transition-colors ${state.orchestrationMode === 'direct' ? 'bg-port-accent text-white font-medium' : 'bg-port-border/40 text-gray-400 hover:text-white'}`}
          >
            Direct
          </button>
          <button
            type="button"
            onClick={() => setField('orchestrationMode', 'orchestrated')}
            className={`px-2.5 py-1 rounded text-xs transition-colors ${state.orchestrationMode === 'orchestrated' ? 'bg-port-accent text-white font-medium' : 'bg-port-border/40 text-gray-400 hover:text-white'}`}
          >
            Orchestrated
          </button>
        </div>
        {state.orchestrationMode === 'orchestrated' && (
          <div className="flex items-center gap-2">
            <label htmlFor="orchestration-profile-select" className="text-xs text-gray-400">Profile:</label>
            <select
              id="orchestration-profile-select"
              value={state.selectedProfileId}
              onChange={(event) => handleSelectOrchestrationProfile(event.target.value)}
              className="px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white"
            >
              <option value="">Custom Profile</option>
              {state.orchestrationProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {state.orchestrationMode === 'orchestrated' ? (
        <div className="space-y-3 bg-port-bg/40 border border-port-border/60 rounded-xl p-3">
          <div className="grid grid-cols-1 gap-2.5">
            {ORCHESTRATION_ROLES_META.map(({ key, label, hint }) => {
              const roleData = state.orchestrationProfile[key] || {};
              const roleProvider = enabledProviders.find((provider) => provider.id === roleData.provider);
              const models = roleProvider ? effortAwareModelOptions(roleProvider, roleData.model) : [];
              return (
                <div key={key} className="flex flex-col @lg:flex-row @lg:items-center gap-2 text-xs">
                  <div className="@lg:w-28 flex-shrink-0">
                    <span className="font-medium text-white">{label}</span>
                    <span className="block text-[10px] text-gray-400 truncate">{hint}</span>
                  </div>
                  <div className="flex-1 min-w-0 grid grid-cols-1 @lg:grid-cols-3 gap-2">
                    <ProviderModelSelector
                      compact
                      label={`${label} provider`}
                      providers={enabledProviders}
                      selectedProviderId={roleData.provider || ''}
                      onProviderChange={(id) => updateOrchestrationRoleField(key, 'provider', id)}
                      emptyProviderOption="Auto / Default"
                    />
                    <select
                      aria-label={`${label} model`}
                      value={roleData.model || (models.length === 1 ? models[0] : '')}
                      disabled={!roleProvider || models.length === 0}
                      onChange={(event) => updateOrchestrationRoleField(key, 'model', event.target.value)}
                      className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs disabled:opacity-50"
                    >
                      {models.length !== 1 && <option value="">Default Model</option>}
                      {models.map((model) => <option key={model} value={model}>{model.replace('claude-', '').replace(/-\d+$/, '')}</option>)}
                    </select>
                    <select
                      aria-label={`${label} effort`}
                      value={roleData.effort || ''}
                      onChange={(event) => updateOrchestrationRoleField(key, 'effort', event.target.value)}
                      className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs"
                    >
                      <option value="">Default Effort</option>
                      {ORCHESTRATION_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <ProviderModelSelector
            compact
            id="task-provider"
            label="AI provider"
            modelLabel="AI model"
            providers={enabledProviders}
            selectedProviderId={state.newTask.provider}
            selectedModel={selectedModelOrSole}
            availableModels={modelOptions}
            onProviderChange={handleProviderChange}
            onModelChange={(model) => setTaskField('model', model)}
            effort={state.newTask.effort}
            onEffortChange={(effort) => setTaskField('effort', effort)}
            emptyProviderOption="Auto (default)"
            emptyModelOption={availableModels.length === 1 ? undefined : 'Select model...'}
            loading={!form.providersLoaded}
            selectionPolicy={AGENT_HARNESS_POLICY}
            highlightToolUse
          />
          {availableModels.length > 0
            ? modelSourceNote && <p className="text-xs text-gray-400">{modelSourceNote}</p>
            : selectedProvider && <p className="text-xs text-gray-400">{providerModelNote}</p>}
        </div>
      )}

      {isOpencodeLocalProvider(selectedProvider) && (
        <div className="grid grid-cols-1 @md:grid-cols-2 gap-3">
          {generationControlsFor(selectedProvider)?.thinking && (
            <div>
              <label htmlFor="task-thinking" className="sr-only">Thinking</label>
              <select
                id="task-thinking"
                value={state.newTask.thinking}
                onChange={(event) => setTaskField('thinking', event.target.value)}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
              >
                <option value="">Provider thinking default</option>
                <option value="true">Thinking on</option>
                <option value="false">Thinking off</option>
              </select>
            </div>
          )}
          <div>
            <label htmlFor="task-temperature" className="sr-only">Temperature</label>
            <input
              id="task-temperature"
              type="number"
              min="0"
              max="2"
              step="0.05"
              placeholder="Provider temperature default"
              value={state.newTask.temperature}
              onChange={(event) => setTaskField('temperature', event.target.value)}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
            />
          </div>
        </div>
      )}

      {apiOnlyProviders && (
        <div className="px-3 py-2 bg-port-warning/10 border border-port-warning/40 rounded-lg text-xs text-port-warning">
          Your enabled providers are HTTP API providers with no file-writing harness, so they can&apos;t run agent tasks. Enable <span className="font-semibold">Claude Ollama</span> for Ollama, <span className="font-semibold">OpenCode llama TUI</span> for llama.cpp / DFlash, or <span className="font-semibold">OpenCode MTPLX</span> for a separately running MTPLX server, on the AI Providers page to run file-writing tasks on a local model.
        </div>
      )}

      {compact && (
        <div className="space-y-2">
          <TaskUploadControls form={form} />
          <TaskUploadPreviews form={form} />
        </div>
      )}

      {!compact && !queueFirst && (
        <AppContextPicker
          apps={form.apps}
          value={state.newTask.app}
          onChange={handleAppChange}
          label="Target application"
          placeholder="PortOS (default)"
          showRepoPath
        />
      )}
      {isFederated && (
        <InstancePicker
          id="task-target-instance"
          value={state.targetInstanceId}
          onChange={(value) => setField('targetInstanceId', value)}
          instances={assignableInstances}
        />
      )}
    </>
  );
}

function TaskCompletionFields({ form }) {
  const {
    state,
    setField,
    selectedApp,
    appHasJira,
    planOnlyTrackerStatus,
    planOnlySupported,
    issueTargets,
    reviewerModelOptions,
    handlePlanOnlyChange,
  } = form;
  const reviewDefaults = state.reviewDefaults;
  const reviewOverrides = state.reviewOverrides;
  const reviewerCliInstalled = state.reviewerCliInstalled;
  const providerReviewUnsupported = state.providerReviewUnsupported;
  const reviewers = reviewOverrides.reviewers ?? reviewDefaults.reviewers;
  return (
    <>
      <div className="grid grid-cols-1 @sm:flex @sm:items-center gap-x-4 gap-y-1 @sm:flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer select-none py-1">
          <input
            type="checkbox"
            checked={state.enhancePrompt}
            onChange={(event) => setField('enhancePrompt', event.target.checked)}
            className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
          />
          <span className="flex items-center gap-1.5 text-sm text-gray-400">
            <Sparkles size={14} className="text-yellow-500" />
            Enhance
          </span>
        </label>
        {planOnlyTrackerStatus !== 'unsupported' && (
          <label htmlFor="task-plan-only" className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap py-1">
            <input
              id="task-plan-only"
              type="checkbox"
              checked={state.planOnly}
              disabled={!planOnlySupported}
              onChange={(event) => handlePlanOnlyChange(event.target.checked)}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0 disabled:opacity-40"
            />
            <span className="flex items-center gap-1.5 text-sm text-gray-400" title="Read the codebase and file a GitHub or GitLab issue without implementing the task.">
              <FileText size={14} className="text-port-accent" />
              Plan &amp; file issue
            </span>
          </label>
        )}
        {planOnlyTrackerStatus === 'pending' && <p className="basis-full text-xs text-gray-500">Checking the app&apos;s work tracker before enabling issue planning.</p>}
        {planOnlyTrackerStatus === 'unsupported' && <p className="basis-full text-xs text-gray-500">Plan &amp; file issue is available for GitHub or GitLab issue trackers.</p>}
        {state.planOnly && (
          <div className="basis-full space-y-2">
            <p className="text-xs text-gray-500">Read-only planning: file the issue without code changes, a worktree, PR, simplify pass, or review.</p>
            {issueTargets.appId === (selectedApp?.id || form.selectedAppId) && issueTargets.value?.canChoose && (
              <div className="max-w-md">
                <label htmlFor="task-issue-target" className="mb-1 block text-xs text-gray-400">File issue on</label>
                <select
                  id="task-issue-target"
                  value={state.issueTarget}
                  onChange={(event) => setField('issueTarget', event.target.value)}
                  className="w-full rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white"
                >
                  <option value="upstream">Upstream · {issueTargets.value.upstream?.fullName}</option>
                  <option value="origin">Origin fork · {issueTargets.value.origin?.fullName}</option>
                </select>
                <p className="mt-1 text-xs text-gray-500">Upstream is the default so project work is not stranded on a personal fork.</p>
              </div>
            )}
          </div>
        )}
        {!state.planOnly && (
          <>
            <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap py-1">
              <input
                type="checkbox"
                checked={state.useWorktree}
                onChange={(event) => {
                  setField('useWorktree', event.target.checked);
                  setField('openPR', event.target.checked);
                }}
                className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
              />
              <span className="flex items-center gap-1.5 text-sm text-gray-400" title="Work in an isolated git worktree on a feature branch. If unchecked, commits directly to the default branch.">
                <GitBranch size={14} className="text-emerald-400" />
                Worktree
              </span>
            </label>
            {!state.useWorktree && (
              <label htmlFor="task-when-done" className="flex flex-wrap items-center gap-2 py-1 basis-full @sm:basis-auto">
                <span className="text-sm text-gray-400">When done</span>
                <select id="task-when-done" value={state.whenDone} onChange={(event) => setField('whenDone', event.target.value)} className="w-full @sm:w-auto @sm:min-w-52 rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-white focus:border-port-accent focus:outline-hidden">
                  <option value="leave-uncommitted">Leave code uncommitted</option>
                  <option value="commit-push">Commit and push to default branch</option>
                </select>
              </label>
            )}
            <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap py-1">
              <input
                type="checkbox"
                checked={state.openPR}
                disabled={!state.useWorktree}
                onChange={(event) => setField('openPR', event.target.checked)}
                className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0 disabled:opacity-40"
              />
              <span className={`flex items-center gap-1.5 text-sm ${state.useWorktree ? 'text-gray-400' : 'text-gray-600'}`} title="Open a pull request to the default branch. If unchecked with worktree enabled, auto-merges on completion.">
                <GitPullRequest size={14} className={state.useWorktree ? 'text-port-accent' : 'text-gray-600'} />
                Open PR
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap py-1">
              <input
                type="checkbox"
                checked={state.simplify}
                onChange={(event) => setField('simplify', event.target.checked)}
                className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
              />
              <span className="flex items-center gap-1.5 text-sm text-gray-400">
                <Wand2 size={14} className="text-port-accent-2" />
                Simplify
              </span>
            </label>
            {state.openPR && (
              <label htmlFor="task-pr-completion" className="flex flex-wrap items-center gap-2 py-1 basis-full @sm:basis-auto">
                <span className="text-sm text-gray-400">After opening PR</span>
                <select
                  id="task-pr-completion"
                  value={state.prCompletion}
                  title={prCompletionOption(state.prCompletion)?.description}
                  onChange={(event) => setField('prCompletion', event.target.value)}
                  className="w-full @sm:w-auto @sm:min-w-44 rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-white focus:border-port-accent focus:outline-hidden"
                >
                  {PR_COMPLETION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            )}
            {state.openPR && state.prCompletion === 'review-then-merge' && (
              <div className="basis-full mt-1">
                <ReviewerPicker
                  reviewers={reviewers}
                  usernames={reviewOverrides.usernames ?? reviewDefaults.usernames}
                  optionalReviewers={reviewOverrides.optionalReviewers ?? reviewDefaults.optionalReviewers}
                  reviewerMaxRounds={reviewOverrides.reviewerMaxRounds ?? reviewDefaults.reviewerMaxRounds}
                  reviewerModels={reviewOverrides.reviewerModels ?? reviewDefaults.reviewerModels}
                  reviewerEfforts={reviewOverrides.reviewerEfforts ?? reviewDefaults.reviewerEfforts}
                  modelOptions={reviewerModelOptions}
                  installed={reviewerCliInstalled}
                  providerReviewUnsupported={providerReviewUnsupported}
                  stopMode={reviewOverrides.stopMode ?? reviewDefaults.stopMode}
                  reviewerApplies={reviewOverrides.reviewerApplies ?? reviewDefaults.reviewerApplies}
                  defaults={reviewDefaults}
                  onChange={(patch) => setField('reviewOverrides', patch)}
                />
              </div>
            )}
            {appHasJira && (
              <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap py-1">
                <input
                  type="checkbox"
                  checked={state.createJiraTicket}
                  onChange={(event) => setField('createJiraTicket', event.target.checked)}
                  className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
                />
                <span className="flex items-center gap-1.5 text-sm text-gray-400">
                  <Ticket size={14} className="text-gray-400" />
                  JIRA ticket
                </span>
              </label>
            )}
          </>
        )}
      </div>
    </>
  );
}

function TaskTemplateFields({ form, compact }) {
  const { state, quickTemplatesEnabled, setField, saveAsTemplate } = form;
  return (
    <>
      {quickTemplatesEnabled && state.showTemplateSave && (
        <div className="flex flex-wrap gap-2 items-center">
          <input
            type="text"
            value={state.templateNameInput}
            onChange={(event) => setField('templateNameInput', event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && saveAsTemplate()}
            placeholder="Template name..."
            aria-label="Template name"
            className="flex-1 px-3 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px] autoFocus"
          />
          <button onClick={saveAsTemplate} type="button" className="px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm min-h-[44px]">Save</button>
          <button onClick={() => { setField('showTemplateSave', false); setField('templateNameInput', ''); }} type="button" className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-gray-400 rounded-lg text-sm min-h-[44px]">Cancel</button>
        </div>
      )}
      {!compact && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 mr-auto">
            <label htmlFor="add-position" className="text-sm text-gray-400">Queue:</label>
            <button id="add-position" type="button" onClick={() => setField('addToTop', !state.addToTop)} className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm transition-colors min-h-[44px] ${state.addToTop ? 'bg-port-accent/20 text-port-accent border border-port-accent/50' : 'bg-port-bg text-gray-400 border border-port-border'}`} aria-pressed={state.addToTop}>
              {state.addToTop ? 'Top' : 'Bottom'}
            </button>
          </div>
          {quickTemplatesEnabled && (
            <button onClick={saveAsTemplate} type="button" className="flex items-center gap-1 px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-gray-400 hover:text-white rounded-lg text-sm transition-colors min-h-[44px]" title="Save current form as a reusable template">
              <Bookmark size={14} aria-hidden="true" />
              <span className="@max-sm:sr-only">Save Template</span>
            </button>
          )}
          <TaskSubmitButton form={form} />
        </div>
      )}
    </>
  );
}

function TaskFormFields({ form, section = 'all', compact = false, queueFirst = false }) {
  return (
    <>
      {(section === 'all' || section === 'execution') && <TaskTypeFields form={form} compact={compact} queueFirst={queueFirst} />}
      {(section === 'all' || section === 'completion') && <TaskCompletionFields form={form} />}
      {(section === 'all' || section === 'templates') && <TaskTemplateFields form={form} compact={compact} />}
    </>
  );
}

export default function TaskAddFormView({ form, compact = false, queueFirst = false }) {
  const { state, setTaskField, setField, selectedApp, selectedProvider, isFederated, assignableInstances, handleAppChange, handleDescriptionKeyDown } = form;
  const reviewers = state.reviewOverrides.reviewers ?? state.reviewDefaults.reviewers;
  const usernames = state.reviewOverrides.usernames ?? state.reviewDefaults.usernames;
  const completion = state.planOnly ? 'Plan and file issue'
    : state.useWorktree ? (state.openPR ? prCompletionOption(state.prCompletion)?.label : 'Auto-merge on completion')
      : state.whenDone === 'commit-push' ? 'Commit and push to default branch' : 'Leave code uncommitted';

  if (queueFirst) {
    return (
      <section className="@container bg-port-card border border-port-border rounded-lg p-3 mb-3 space-y-2" aria-label="Add new task">
        <label htmlFor="task-description" className="sr-only">Task description (required)</label>
        <AutoSizeTextarea
          id="task-description"
          ref={form.descriptionRef}
          placeholder="What needs doing?"
          value={state.newTask.description}
          onChange={(event) => setTaskField('description', event.target.value)}
          onKeyDown={handleDescriptionKeyDown}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-base min-h-[44px]"
          aria-required="true"
        />
        {!compact && (
          <AppContextPicker
            apps={form.apps}
            value={state.newTask.app}
            onChange={handleAppChange}
            label="Target application"
            placeholder="PortOS (default)"
            showRepoPath
          />
        )}
        <p className="text-xs text-gray-400 break-words" aria-label="Task execution summary">
          {selectedApp?.name || 'PortOS'} · {state.orchestrationMode === 'orchestrated'
            ? `Orchestrated: ${ORCHESTRATION_ROLES_META.map(({ key, label }) => `${label} ${state.orchestrationProfile[key].provider || 'default'}/${state.orchestrationProfile[key].model || 'default'}`).join(' · ')}`
            : [selectedProvider?.name || state.newTask.provider || 'Default provider', form.selectedModelOrSole || 'default model', state.newTask.effort].filter(Boolean).join(' / ')}
          {' · '}{state.planOnly ? 'Read-only planning' : state.useWorktree ? 'Worktree' : 'Direct checkout'}
          {' · '}{completion}
          {!state.planOnly && state.openPR && state.prCompletion === 'review-then-merge' && ` · Review: ${[...reviewers, ...usernames.map((name) => '@' + name)].join(', ') || 'None'}`}
          {isFederated && ` · Instance: ${assignableInstances.find((instance) => instance.id === state.targetInstanceId)?.name || state.targetInstanceId || 'Any'}`}
          {state.planOnly && ` · Issue: ${state.issueTarget}`}
          {state.createJiraTicket && !state.planOnly && ' · JIRA ticket'}
          {state.enhancePrompt && ' · Enhance prompt'}
          {state.addToTop && ' · Queue at top'}
        </p>
        <TaskTemplates form={form} />
        <TaskUploadControls form={form} />
        <TaskUploadPreviews form={form} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" onClick={() => setField('configurationOpen', !state.configurationOpen)} aria-expanded={state.configurationOpen} aria-controls="task-configuration" className="min-h-[44px] px-3 py-2 text-sm text-port-accent border border-port-border rounded-lg">
            Task configuration
          </button>
          <TaskSubmitButton form={form} variant="queue" />
        </div>
        {state.configurationOpen && (
          <div id="task-configuration" role="region" aria-label="Task configuration" className="space-y-3">
            <TaskFormFields form={form} queueFirst />
          </div>
        )}
      </section>
    );
  }

  if (compact) {
    return (
      <div className="@container space-y-3">
        <div className="flex flex-col @xl:flex-row gap-2">
          <label htmlFor="compact-task-desc" className="sr-only">Task description (required)</label>
          <AutoSizeTextarea
            id="compact-task-desc"
            ref={form.descriptionRef}
            placeholder="Task description *"
            value={state.newTask.description}
            onChange={(event) => setTaskField('description', event.target.value)}
            onKeyDown={handleDescriptionKeyDown}
            className="w-full @xl:flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
            aria-required="true"
          />
          <div className="flex gap-2">
            <div className="flex-1 min-w-0 @xl:w-40 @xl:flex-none">
              <AppContextPicker
                apps={form.apps}
                value={state.newTask.app}
                onChange={handleAppChange}
                label=""
                placeholder="PortOS"
                ariaLabel="Select app context"
                showRepoPath={false}
                selectClassName="w-full px-2 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
              />
            </div>
            <TaskSubmitButton form={form} variant="compact" />
          </div>
        </div>
        <button type="button" onClick={() => setField('expanded', !state.expanded)} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors" aria-expanded={state.expanded}>
          {state.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {state.expanded ? 'Fewer options' : 'More options'}
        </button>
        {state.expanded && <div className="space-y-2 pt-1"><TaskFormFields form={form} compact /></div>}
      </div>
    );
  }

  return (
    <div className="@container bg-port-card border border-port-accent/50 rounded-lg p-4 mb-4" role="form" aria-label="Add new task">
      <TaskTemplates form={form} />
      <div className="space-y-2">
        <div className="flex flex-col @sm:flex-row gap-2 items-start">
          <div className="flex-1 min-w-0 w-full">
            <label htmlFor="task-description" className="sr-only">Task description (required)</label>
            <AutoSizeTextarea
              id="task-description"
              ref={form.descriptionRef}
              placeholder="Task description *"
              value={state.newTask.description}
              onChange={(event) => setTaskField('description', event.target.value)}
              onKeyDown={handleDescriptionKeyDown}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
              aria-required="true"
            />
          </div>
          <TaskUploadControls form={form} />
        </div>
        <TaskUploadPreviews form={form} />
        <TaskFormFields form={form} />
      </div>
    </div>
  );
}
