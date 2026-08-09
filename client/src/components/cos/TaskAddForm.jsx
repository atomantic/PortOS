import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Plus, Image, X, ChevronDown, ChevronRight, Sparkles, Loader2, Paperclip, FileText, Zap, Bookmark, Ticket, GitBranch, GitPullRequest, Wand2 } from 'lucide-react';
import toast from '../ui/Toast';
import AppContextPicker from '../AppContextPicker';
import * as api from '../../services/api';
import { processScreenshotUploads, processAttachmentUploads } from '../../services/apiMedia';
import { ATTACHMENT_ACCEPT } from '../../utils/fileUpload';
import FilePickerButton from '../ui/FilePickerButton';
import { formatBytes } from '../../utils/formatters';
import { effectiveModelFor, effortAwareModelOptions, effortSurvivingModel, isTuiProvider, isCliProvider, isProcessProvider, isCodexProvider, seedModelEffort } from '../../utils/providers';
import { DEFAULT_PR_COMPLETION, DEFAULT_REVIEWERS, DEFAULT_REVIEW_STOP_MODE, PR_COMPLETION_OPTIONS, prCompletionOption } from './constants';
import { clickableProps } from '../../lib/a11yKeyboard';
import { slashdoLabel } from '../../lib/slashdoCatalog';
import ReviewerPicker from './ReviewerPicker';
import EffortSelect from './EffortSelect';
import useReviewerModelOptions from '../../hooks/useReviewerModelOptions';
import { reviewerModelsFromDefaults, reviewerEffortsFromDefaults } from '../../lib/reviewerModels';

export default function TaskAddForm({ providers, apps, onTaskAdded, compact = false, defaultExpanded = false, defaultApp = '' }) {
  const [newTask, setNewTask] = useState({ description: '', model: '', provider: '', effort: '', app: defaultApp });
  const [addToTop, setAddToTop] = useState(false);
  const [enhancePrompt, setEnhancePrompt] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [openPR, setOpenPR] = useState(false);
  const [simplify, setSimplify] = useState(true);
  // Hidden run-shape state, never a user-facing toggle: the slashdo catalog's
  // deliverable posture (#3636/#3651). `undefined` = the form pins no opinion,
  // so the server keeps its own default. Only a slashdo-backed template sets it.
  const [worktreeChangesExpected, setWorktreeChangesExpected] = useState(undefined);
  const [prCompletion, setPrCompletion] = useState(DEFAULT_PR_COMPLETION);
  const [reviewers, setReviewers] = useState(DEFAULT_REVIEWERS);
  const [reviewUsernames, setReviewUsernames] = useState([]);
  const [optionalReviewers, setOptionalReviewers] = useState([]);
  const [reviewerMaxRounds, setReviewerMaxRounds] = useState({});
  const [reviewerModels, setReviewerModels] = useState({});
  const [reviewerEfforts, setReviewerEfforts] = useState({});
  const [reviewStopMode, setReviewStopMode] = useState(DEFAULT_REVIEW_STOP_MODE);
  const [reviewerApplies, setReviewerApplies] = useState(false);
  const [reviewerCliInstalled, setReviewerCliInstalled] = useState({});
  const [createJiraTicket, setCreateJiraTicket] = useState(false);
  const [screenshots, setScreenshots] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  // Compact-mode-only "More options" toggle. Callers that render in a
  // tall container (the dashboard Quick Task widget) pass defaultExpanded
  // so the card paints as a complete capture form on first render.
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [templateNameInput, setTemplateNameInput] = useState('');
  const [showTemplateSave, setShowTemplateSave] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Bare slashdo command a quick-template pinned (`plan-task`), never a rendered
  // `/do:x` string — see server/lib/slashdoInvocation.js for why.
  const [slashdoCommand, setSlashdoCommand] = useState('');
  // Resolved model lists for the reviewer table's Model column. Owned here (not by
  // ReviewerPicker) so the picker stays fetch-free — see its `modelOptions` prop.
  const reviewerModelOptions = useReviewerModelOptions();
  const submittingRef = useRef(false);
  const descriptionRef = useRef(null);
  // Set by applyTemplate only when a template changes BOTH the app and the
  // run-shape toggles, so the app-defaults effect skips the single run that
  // change triggers. See that effect for why.
  const templateAppChangeRef = useRef(false);

  // Fetch templates
  useEffect(() => {
    api.getCosPopularTemplates(8)
      .then(data => setTemplates(data.templates || []))
      .catch(() => setTemplates([]));
  }, []);

  // Seed reviewer state from the global Code Review Defaults (AI Providers →
  // Code Review Defaults panel). One-shot on mount: if the user later toggles
  // the picker, their per-task choice wins over the global seed. Silent so a
  // missing settings file doesn't toast on every task form mount.
  useEffect(() => {
    let cancelled = false;
    api.getCodeReviewDefaults({ silent: true })
      .then((d) => {
        if (cancelled || !d) return;
        if (Array.isArray(d.reviewers) && d.reviewers.length) setReviewers(d.reviewers);
        if (Array.isArray(d.usernames)) setReviewUsernames(d.usernames);
        if (Array.isArray(d.optionalReviewers)) setOptionalReviewers(d.optionalReviewers);
        if (d.reviewerMaxRounds && typeof d.reviewerMaxRounds === 'object' && !Array.isArray(d.reviewerMaxRounds)) setReviewerMaxRounds(d.reviewerMaxRounds);
        // The defaults persist per-reviewer models as scalars; the picker takes the
        // token-keyed map (see client/src/lib/reviewerModels.js).
        setReviewerModels(reviewerModelsFromDefaults(d));
        setReviewerEfforts(reviewerEffortsFromDefaults(d));
        if (d.stopMode) setReviewStopMode(d.stopMode);
        if (d.reviewerApplies === true) setReviewerApplies(true);
        if (d.installed && typeof d.installed === 'object' && !Array.isArray(d.installed)) setReviewerCliInstalled(d.installed);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Memoize enabled providers for the dropdown — restricted to CODING providers
  // (CLI/TUI agents with a file-writing harness). HTTP `api` providers (raw
  // Ollama / LM Studio / nvidia-kimi) return plain text and can't write files, so
  // they're not valid task runners; a user who only has those should use the
  // "Claude Ollama" sample (a `claude` CLI/TUI pointed at Ollama) instead.
  const enabledProviders = useMemo(() =>
    providers?.filter(p => p.enabled && isProcessProvider(p)) || [],
    [providers]
  );

  // True when the user has enabled providers but ALL of them are HTTP `api`
  // providers (Ollama / LM Studio / kimi) — none can run file-writing tasks.
  // Surface the harness-boundary advisory so they aren't left with an empty
  // dropdown and no explanation.
  const apiOnlyProviders = useMemo(() => {
    const enabled = providers?.filter(p => p.enabled) || [];
    return enabled.length > 0 && enabledProviders.length === 0;
  }, [providers, enabledProviders]);

  // If the pinned provider isn't a valid coding option (e.g. a saved template
  // pinned an `api` provider that's now filtered out of the dropdown), reset to
  // "Auto" so the visible select and the submitted value can't diverge.
  useEffect(() => {
    if (newTask.provider && !enabledProviders.some(p => p.id === newTask.provider)) {
      setNewTask(t => ({ ...t, provider: '', model: '', effort: '' }));
    }
  }, [enabledProviders, newTask.provider]);

  // Check if selected app has JIRA configured
  const selectedApp = useMemo(() =>
    apps?.find(a => a.id === newTask.app),
    [apps, newTask.app]
  );
  const appHasJira = selectedApp?.jira?.enabled;

  // Gate on a content signature of the selected app's defaults (not the
  // `apps` array reference) so periodic re-fetches in the parent don't
  // stomp manual checkbox toggles between renders.
  const appDefaultsSig = useMemo(() => selectedApp
    ? `${selectedApp.id}|${!!selectedApp.defaultOpenPR}|${selectedApp.defaultPrCompletion || DEFAULT_PR_COMPLETION}|${!!selectedApp.defaultUseWorktree}|${!!selectedApp.jira?.enabled}`
    : `none:${newTask.app || ''}`,
    [selectedApp, newTask.app]
  );
  useEffect(() => {
    // A template that pins BOTH an app and a `settings` block would otherwise
    // lose: applyTemplate sets the toggles synchronously, then the app change it
    // also made re-fires this effect and stomps them with the app's defaults.
    // The template's explicit choice is the more specific one, so skip exactly
    // the one run its own app change triggered.
    if (templateAppChangeRef.current) {
      templateAppChangeRef.current = false;
      return;
    }
    const defaultOpenPR = !!selectedApp?.defaultOpenPR;
    const defaultUseWorktree = !!selectedApp?.defaultUseWorktree || defaultOpenPR;
    setCreateJiraTicket(!!selectedApp?.jira?.enabled);
    setUseWorktree(defaultUseWorktree);
    setOpenPR(defaultOpenPR);
    setPrCompletion(selectedApp?.defaultPrCompletion || DEFAULT_PR_COMPLETION);
  }, [appDefaultsSig]);

  // Get models for selected provider. The form carries its own Thinking Effort
  // select and submits it, so Antigravity lists BASE models (`gemini-3.6-flash`)
  // with the tier picked separately — a legacy suffixed id saved in a template
  // stays selectable as its own option.
  const selectedProvider = providers?.find(p => p.id === newTask.provider);
  const availableModels = effortAwareModelOptions(selectedProvider, newTask.model);
  const providerModelNote = (() => {
    if (!selectedProvider) return '';
    if (isTuiProvider(selectedProvider)) return `${selectedProvider.name} runs in an attachable terminal UI session.`;
    if (isCodexProvider(selectedProvider)) return 'Codex uses the model configured in ~/.codex/config.toml.';
    if (isCliProvider(selectedProvider)) return `${selectedProvider.name} uses its CLI configured default model.`;
    return 'No models are configured. PortOS will use the provider default.';
  })();

  // Apply template to form. A slashdo-backed template also pins the workflow
  // (`slashdoCommand`) and applies its implied run-shape `settings`.
  //
  // `settings` keys are tri-state: a key ABSENT leaves the current toggle
  // untouched, `false` turns it off. Collapsing absent to false would make a
  // plain user template silently clear toggles it never meant to touch.
  const applyTemplate = useCallback(async (template) => {
    // A template saved before Antigravity split model from effort pins the
    // suffixed id (`gemini-3.6-flash-high`). Seed the two controls from its two
    // halves so the pin lands on a base model + its tier rather than an option
    // the Model select no longer offers.
    const seeded = seedModelEffort(
      providers?.find(p => p.id === template.provider),
      template.model,
      template.effort,
    );
    setNewTask(t => ({
      ...t,
      description: template.description,
      // A template that pins no app must not clear the one the user already
      // chose — and the built-ins pin none. Same absent-vs-empty rule as
      // `settings` below. Provider/model/effort move as a unit: pinning a
      // provider without a model would otherwise strand a model from a
      // different provider in the form.
      ...(template.app ? { app: template.app } : {}),
      ...(template.provider
        ? { provider: template.provider, model: seeded.model, effort: seeded.effort }
        : {})
    }));
    setSlashdoCommand(template.slashdoCommand || '');
    // Hidden posture, so it follows `slashdoCommand` (set unconditionally above)
    // rather than the tri-state rule the three visible toggles use: with no UI
    // control to reveal or correct it, a posture left over from a previous
    // template would silently ride along on the next one the user picks.
    setWorktreeChangesExpected(template.settings?.worktreeChangesExpected);
    const settings = template.settings;
    if (settings && typeof settings === 'object') {
      // Only when the template also moves the app — otherwise the effect never
      // fires and a stale flag would swallow the user's next app change.
      if (template.app && template.app !== newTask.app) templateAppChangeRef.current = true;
      if (settings.useWorktree !== undefined) setUseWorktree(settings.useWorktree);
      if (settings.openPR !== undefined) setOpenPR(settings.openPR);
      if (settings.simplify !== undefined) setSimplify(settings.simplify);
    }
    descriptionRef.current?.focus();
    await api.applyCosTaskTemplate(template.id).catch(() => {});
    toast.success(`Template applied: ${template.name}`);
  }, [newTask.app, providers]);

  // Save current form as template (inline input instead of window.prompt)
  const saveAsTemplate = useCallback(async () => {
    if (!newTask.description.trim()) {
      toast.error('Enter a task description first');
      return;
    }

    if (!showTemplateSave) {
      setTemplateNameInput(newTask.description.substring(0, 40));
      setShowTemplateSave(true);
      return;
    }

    if (!templateNameInput.trim()) {
      toast.error('Template name is required');
      return;
    }

    const result = await api.createCosTaskTemplate({
      name: templateNameInput.trim(),
      description: newTask.description,
      provider: newTask.provider,
      model: newTask.model,
      effort: newTask.effort,
      app: newTask.app
    }, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });

    if (result?.success) {
      toast.success('Template saved');
      setShowTemplateSave(false);
      setTemplateNameInput('');
      api.getCosPopularTemplates(8)
        .then(data => setTemplates(data.templates || []))
        .catch(err => console.warn('refresh templates:', err?.message ?? String(err)));
    }
  }, [newTask, templateNameInput, showTemplateSave]);

  // Delete a user template
  const deleteTemplate = useCallback(async (templateId, e) => {
    e.stopPropagation();
    const result = await api.deleteCosTaskTemplate(templateId, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success('Template deleted');
      setTemplates(prev => prev.filter(t => t.id !== templateId));
    }
  }, []);

  // Screenshot handling
  const handleFileSelect = async (e) => {
    await processScreenshotUploads(e.target.files, {
      onSuccess: (fileInfo) => setScreenshots(prev => [...prev, fileInfo]),
      onError: (msg) => toast.error(msg)
    });
  };

  const removeScreenshot = (id) => {
    setScreenshots(prev => prev.filter(s => s.id !== id));
  };

  // Attachment handling
  const handleAttachmentSelect = async (e) => {
    await processAttachmentUploads(e.target.files, {
      onSuccess: (fileInfo) => setAttachments(prev => [...prev, fileInfo]),
      onError: (msg) => toast.error(msg)
    });
  };

  const removeAttachment = (id) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const handleAddTask = async () => {
    if (submittingRef.current) return;
    if (!newTask.description.trim()) {
      toast.error('Description is required');
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);

    let finalDescription = newTask.description;

    if (enhancePrompt) {
      setIsEnhancing(true);
      const enhanceResult = await api.enhanceCosTaskPrompt({
        description: newTask.description
      }).catch(err => {
        toast('Enhancement failed, using original description', { icon: '\u26a0\ufe0f' });
        console.warn(`⚠️ Task enhancement failed: ${err.message}`);
        return null;
      });

      if (enhanceResult?.enhancedDescription?.trim()) {
        finalDescription = enhanceResult.enhancedDescription;
        toast.success('Prompt enhanced');
      } else if (enhanceResult) {
        toast('Enhancement returned empty result, using original', { icon: '\u26a0\ufe0f' });
      }

      setIsEnhancing(false);
    }

    const result = await api.addCosTask({
      description: finalDescription,
      model: newTask.model || undefined,
      provider: newTask.provider || undefined,
      effort: newTask.effort || undefined,
      app: newTask.app || undefined,
      slashdoCommand: slashdoCommand || undefined,
      createJiraTicket,
      useWorktree,
      openPR: useWorktree && openPR,
      simplify,
      // Omitted entirely when no template pinned a posture — sending `undefined`
      // would be indistinguishable from a deliberate `false` on the wire.
      ...(worktreeChangesExpected !== undefined ? { worktreeChangesExpected } : {}),
      prCompletion: useWorktree && openPR ? prCompletion : undefined,
      // One gate for every per-reviewer field: they only apply when this task
      // opens a PR that PortOS reviews before merging.
      ...(openPR && prCompletion === 'review-then-merge' ? {
        reviewers,
        usernames: reviewUsernames,
        optionalReviewers,
        reviewerMaxRounds,
        reviewerModels,
        reviewerEfforts,
        reviewStopMode,
        reviewerApplies,
      } : {}),
      screenshots: screenshots.length > 0 ? screenshots.map(s => s.path) : undefined,
      attachments: attachments.length > 0 ? attachments.map(a => ({
        filename: a.filename,
        originalName: a.originalName,
        path: a.path,
        size: a.size,
        mimeType: a.mimeType
      })) : undefined,
      position: addToTop ? 'top' : 'bottom'
    }, { silent: true }).catch(err => {
      toast.error(err.message || 'Failed to add task');
      return null;
    });

    submittingRef.current = false;
    setIsSubmitting(false);
    setIsEnhancing(false);

    if (!result) return;

    // Only clear form inputs after successful submission
    setNewTask(t => ({ ...t, description: '' }));
    setSlashdoCommand('');
    // The posture belongs to the workflow the cleared template pinned, so it
    // must not survive into the next, template-less task.
    setWorktreeChangesExpected(undefined);
    setScreenshots([]);
    setAttachments([]);

    toast.success('Task added');
    onTaskAdded?.();
  };

  // Compact mode: single row with description + app + add, expandable
  if (compact) {
    return (
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <label htmlFor="compact-task-desc" className="sr-only">Task description (required)</label>
          <input
            id="compact-task-desc"
            type="text"
            placeholder="Task description *"
            value={newTask.description}
            onChange={e => setNewTask(t => ({ ...t, description: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && !isSubmitting && handleAddTask()}
            className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
            aria-required="true"
          />
          <div className="flex gap-2">
            <div className="flex-1 sm:w-40 sm:flex-none">
              <AppContextPicker
                apps={apps}
                value={newTask.app}
                onChange={(appId) => setNewTask(t => ({ ...t, app: appId }))}
                label=""
                placeholder="PortOS"
                ariaLabel="Select app context"
                showRepoPath={false}
                selectClassName="w-full px-2 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
              />
            </div>
            <button
              onClick={handleAddTask}
              disabled={isSubmitting || isEnhancing}
              className="flex items-center gap-1 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 min-h-[44px]"
            >
              {(isSubmitting || isEnhancing) ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {isSubmitting ? 'Adding...' : 'Add'}
            </button>
          </div>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? 'Fewer options' : 'More options'}
        </button>
        {expanded && (
          <div className="space-y-2 pt-1">
            {renderFullFormFields()}
          </div>
        )}
      </div>
    );
  }

  // Full mode: identical to original TasksTab form
  return (
    <div className="bg-port-card border border-port-accent/50 rounded-lg p-4 mb-4" role="form" aria-label="Add new task">
      {/* Quick Templates */}
      {templates.length > 0 && (
        <div className="mb-4">
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors mb-2"
            aria-expanded={showTemplates}
          >
            {showTemplates ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Zap size={14} className="text-yellow-500" />
            Quick Templates
            <span className="text-xs text-gray-600">({templates.length})</span>
          </button>
          {showTemplates && (
            <div className="flex flex-wrap gap-2">
              {templates.map(template => (
                <div
                  key={template.id}
                  onClick={() => applyTemplate(template)}
                  {...clickableProps(() => applyTemplate(template))}
                  className="group relative flex items-center gap-1.5 px-3 py-1.5 bg-port-card border border-port-border rounded-lg text-sm text-gray-300 hover:text-white hover:border-port-accent/50 transition-colors cursor-pointer"
                  title={template.slashdoCommand ? `${slashdoLabel(template.slashdoCommand)} \u2014 ${template.context || template.description}` : template.description}
                >
                  <span>{template.icon || '\ud83d\udcdd'}</span>
                  <span className="max-w-[120px] truncate">{template.name}</span>
                  {/* The Claude-Code form of the command, as a recognizable label.
                      The actual invocation is resolved server-side per provider. */}
                  {template.slashdoCommand && (
                    <span className="hidden sm:inline text-xs text-port-accent/80 font-mono">{slashdoLabel(template.slashdoCommand)}</span>
                  )}
                  {template.useCount > 0 && (
                    <span className="text-xs text-gray-600">({template.useCount})</span>
                  )}
                  {!template.isBuiltin && (
                    <button
                      onClick={(e) => deleteTemplate(template.id, e)}
                      className="flex md:hidden md:group-hover:flex absolute -top-[18px] -right-[18px] w-11 h-11 items-center justify-center"
                      aria-label="Delete template"
                    >
                      <span className="flex items-center justify-center w-4 h-4 bg-port-error rounded-full">
                        <X size={10} />
                      </span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <div>
          <label htmlFor="task-description" className="sr-only">Task description (required)</label>
          <input
            id="task-description"
            ref={descriptionRef}
            type="text"
            placeholder="Task description *"
            value={newTask.description}
            onChange={e => setNewTask(t => ({ ...t, description: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !isSubmitting) { e.preventDefault(); handleAddTask(); } }}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
            aria-required="true"
          />
        </div>
        {renderFullFormFields()}
      </div>
    </div>
  );

  function renderFullFormFields() {
    return (
      <>
        {!compact && (
          <AppContextPicker
            apps={apps}
            value={newTask.app}
            onChange={(appId) => setNewTask(t => ({ ...t, app: appId }))}
            label="Target application"
            placeholder="PortOS (default)"
            showRepoPath
          />
        )}
        <div className="grid grid-cols-1 sm:flex sm:items-center gap-x-4 gap-y-1 sm:flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer select-none py-1">
            <input
              type="checkbox"
              checked={enhancePrompt}
              onChange={(e) => setEnhancePrompt(e.target.checked)}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
            />
            <span className="flex items-center gap-1.5 text-sm text-gray-400">
              <Sparkles size={14} className="text-yellow-500" />
              Enhance
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap py-1">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => {
                // Enabling a worktree defaults "Open PR" on (safer than an
                // unreviewed auto-merge to the default branch); the user can
                // still uncheck it. Disabling forces it off (openPR is
                // meaningless without a worktree).
                setUseWorktree(e.target.checked);
                setOpenPR(e.target.checked);
              }}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
            />
            <span className="flex items-center gap-1.5 text-sm text-gray-400" title="Work in an isolated git worktree on a feature branch. If unchecked, commits directly to the default branch.">
              <GitBranch size={14} className="text-emerald-400" />
              Worktree
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap py-1">
            <input
              type="checkbox"
              checked={openPR}
              disabled={!useWorktree}
              onChange={(e) => setOpenPR(e.target.checked)}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0 disabled:opacity-40"
            />
            <span className={`flex items-center gap-1.5 text-sm ${useWorktree ? 'text-gray-400' : 'text-gray-600'}`} title="Open a pull request to the default branch. If unchecked with worktree enabled, auto-merges on completion.">
              <GitPullRequest size={14} className={useWorktree ? 'text-port-accent' : 'text-gray-600'} />
              Open PR
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap py-1">
            <input
              type="checkbox"
              checked={simplify}
              onChange={(e) => setSimplify(e.target.checked)}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
            />
            <span className="flex items-center gap-1.5 text-sm text-gray-400">
              <Wand2 size={14} className="text-port-accent-2" />
              Simplify
            </span>
          </label>
          {openPR && (
            <label htmlFor="task-pr-completion" className="flex items-center gap-2 py-1 basis-full sm:basis-auto">
              <span className="text-sm text-gray-400">After opening PR</span>
              <select
                id="task-pr-completion"
                value={prCompletion}
                title={prCompletionOption(prCompletion)?.description}
                onChange={(e) => setPrCompletion(e.target.value)}
                className="min-w-44 rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-white focus:border-port-accent focus:outline-hidden"
              >
                {PR_COMPLETION_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          )}
          {openPR && prCompletion === 'review-then-merge' && (
            <div className="basis-full mt-1">
              <ReviewerPicker
                reviewers={reviewers}
                usernames={reviewUsernames}
                optionalReviewers={optionalReviewers}
                reviewerMaxRounds={reviewerMaxRounds}
                reviewerModels={reviewerModels}
                reviewerEfforts={reviewerEfforts}
                modelOptions={reviewerModelOptions}
                installed={reviewerCliInstalled}
                stopMode={reviewStopMode}
                reviewerApplies={reviewerApplies}
                onChange={({ reviewers: r, usernames: u, optionalReviewers: o, reviewerMaxRounds: m, reviewerModels: rm, reviewerEfforts: re, stopMode, reviewerApplies: ra }) => {
                  setReviewers(r);
                  setReviewUsernames(u);
                  setOptionalReviewers(o);
                  setReviewerMaxRounds(m);
                  setReviewerModels(rm);
                  setReviewerEfforts(re);
                  setReviewStopMode(stopMode);
                  setReviewerApplies(ra);
                }}
              />
            </div>
          )}
          {appHasJira && (
            <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap py-1">
              <input
                type="checkbox"
                checked={createJiraTicket}
                onChange={(e) => setCreateJiraTicket(e.target.checked)}
                className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
              />
              <span className="flex items-center gap-1.5 text-sm text-gray-400">
                <Ticket size={14} className="text-port-accent" />
                JIRA ticket
              </span>
            </label>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="sm:w-40">
            <label htmlFor="task-provider" className="sr-only">AI provider</label>
            <select
              id="task-provider"
              value={newTask.provider}
              onChange={e => setNewTask(t => ({ ...t, provider: e.target.value, model: '', effort: '' }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
            >
              <option value="">Auto (default)</option>
              {enabledProviders.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          {availableModels.length > 0 ? (
            <div className="flex-1">
              <label htmlFor="task-model" className="sr-only">AI model</label>
              <select
                id="task-model"
                value={newTask.model}
                onChange={e => setNewTask(t => ({
                  ...t,
                  model: e.target.value,
                  // A model with no effort tiers hides the select below — clear the
                  // value with it rather than submitting a level the UI stopped showing.
                  effort: effortSurvivingModel(selectedProvider, e.target.value, t.effort),
                }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
              >
                <option value="">Select model...</option>
                {availableModels.map(m => (
                  <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                ))}
              </select>
            </div>
          ) : selectedProvider ? (
            <div className="flex-1 px-3 py-2 min-h-[44px] bg-port-bg border border-port-border rounded-lg text-xs text-gray-400 flex items-center">
              {providerModelNote}
            </div>
          ) : null}
          <EffortSelect
            provider={selectedProvider}
            model={effectiveModelFor(selectedProvider, newTask.model)}
            value={newTask.effort}
            onChange={effort => setNewTask(t => ({ ...t, effort }))}
            className="sm:w-40 w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
          />
        </div>
        {apiOnlyProviders && (
          <div className="px-3 py-2 bg-port-warning/10 border border-port-warning/40 rounded-lg text-xs text-port-warning">
            Your enabled providers (Ollama / LM Studio) are HTTP API providers with no file-writing harness, so they can't run agent tasks. Enable the <span className="font-semibold">Claude Ollama</span> provider (a <code>claude</code> CLI/TUI pointed at your local model) on the AI Providers page to run file-writing tasks on a local model.
          </div>
        )}
        {/* Screenshot and Attachment Upload */}
        <div className="flex items-center gap-3 flex-wrap">
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
          {screenshots.length > 0 && (
            <span className="text-xs text-gray-500">{screenshots.length} screenshot{screenshots.length > 1 ? 's' : ''}</span>
          )}
          {attachments.length > 0 && (
            <span className="text-xs text-gray-500">{attachments.length} file{attachments.length > 1 ? 's' : ''}</span>
          )}
        </div>
        {/* Screenshot Previews */}
        {screenshots.length > 0 && (
          <div className="flex gap-2 flex-wrap">
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
        {/* Attachment Previews */}
        {attachments.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {attachments.map(a => (
              <div key={a.id} className="relative group flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border rounded-lg">
                {a.isImage && a.preview ? (
                  <img
                    src={a.preview}
                    alt={a.originalName}
                    className="w-8 h-8 object-cover rounded"
                  />
                ) : (
                  <FileText size={20} className="text-gray-400" aria-hidden="true" />
                )}
                <div className="flex flex-col">
                  <span className="text-xs text-white truncate max-w-[120px]" title={a.originalName}>
                    {a.originalName}
                  </span>
                  <span className="text-xs text-gray-500">{formatBytes(a.size)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  className="ml-1 p-0.5 text-gray-500 hover:text-port-error transition-colors"
                  aria-label={`Remove attachment ${a.originalName}`}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Template Save Inline Input */}
        {showTemplateSave && (
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={templateNameInput}
              onChange={e => setTemplateNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveAsTemplate()}
              placeholder="Template name..."
              className="flex-1 px-3 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
              autoFocus
            />
            <button
              onClick={saveAsTemplate}
              className="px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors min-h-[44px]"
            >
              Save
            </button>
            <button
              onClick={() => { setShowTemplateSave(false); setTemplateNameInput(''); }}
              className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-gray-400 rounded-lg text-sm transition-colors min-h-[44px]"
            >
              Cancel
            </button>
          </div>
        )}
        {!compact && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 mr-auto">
              <label htmlFor="add-position" className="text-sm text-gray-400">Queue:</label>
              <button
                id="add-position"
                type="button"
                onClick={() => setAddToTop(!addToTop)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors min-h-[44px] ${
                  addToTop
                    ? 'bg-port-accent/20 text-port-accent border border-port-accent/50'
                    : 'bg-port-bg text-gray-400 border border-port-border'
                }`}
                aria-pressed={addToTop}
              >
                {addToTop ? 'Top' : 'Bottom'}
              </button>
            </div>
            <button
              onClick={saveAsTemplate}
              type="button"
              className="flex items-center gap-1 px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-gray-400 hover:text-white rounded-lg text-sm transition-colors min-h-[44px]"
              title="Save current form as a reusable template"
            >
              <Bookmark size={14} aria-hidden="true" />
              <span className="hidden sm:inline">Save Template</span>
            </button>
            <button
              onClick={handleAddTask}
              disabled={isSubmitting || isEnhancing}
              className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px]"
            >
              {(isSubmitting || isEnhancing) ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  {isSubmitting ? 'Adding...' : 'Enhancing...'}
                </>
              ) : (
                <>
                  <Plus size={14} aria-hidden="true" />
                  {enhancePrompt ? 'Enhance & Add' : 'Add'}
                </>
              )}
            </button>
          </div>
        )}
      </>
    );
  }
}
