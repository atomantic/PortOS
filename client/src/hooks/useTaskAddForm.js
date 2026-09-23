import { useEffect, useMemo, useReducer, useRef } from 'react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import { processScreenshotUploads, processAttachmentUploads } from '../services/apiMedia';
import { isCompositeProviderId } from '../utils/providerRef';
import {
  effortSurvivingModel,
  isCliProvider,
  isCodexSubscriptionProvider,
  isProcessProvider,
  isTuiProvider,
  resolveProviderModelOptions,
  MODEL_SOURCE,
  seedModelEffort,
} from '../utils/providers';
import { reviewerModelsFromDefaults, reviewerEffortsFromDefaults } from '../lib/reviewerModels';
import { PORTOS_APP_ID } from '../lib/appIdentity';
import { safeReadJsonStorage, safeReadStorage, safeRemoveStorage, safeWriteJsonStorage, safeWriteStorage } from '../lib/safeStorage';
import {
  DEFAULT_PR_COMPLETION,
  DEFAULT_REVIEWERS,
  DEFAULT_REVIEW_STOP_MODE,
} from '../components/cos/constants.js';
import useAssignableInstances from './useAssignableInstances.js';
import { useInstanceFeatures } from './useInstanceFeatures.js';
import useReviewerModelOptions from './useReviewerModelOptions.js';

const TASK_DESCRIPTION_DRAFT_KEY = 'portos-cos-task-description-draft';
const QUICK_TEMPLATES_EXPANDED_KEY = 'portos-cos-quick-templates-expanded';
const INVALID_DRAFT = Symbol('invalid task description draft');

const REVIEW_PICKER_TO_PAYLOAD_KEY = {
  reviewers: 'reviewers',
  usernames: 'usernames',
  optionalReviewers: 'optionalReviewers',
  reviewerMaxRounds: 'reviewerMaxRounds',
  reviewerModels: 'reviewerModels',
  reviewerEfforts: 'reviewerEfforts',
  stopMode: 'reviewStopMode',
  reviewerApplies: 'reviewerApplies',
};

const reviewOverridePayload = (reviewOverrides) => Object.fromEntries(
  Object.entries(REVIEW_PICKER_TO_PAYLOAD_KEY)
    .filter(([pickerKey]) => reviewOverrides[pickerKey] !== undefined)
    .map(([pickerKey, payloadKey]) => [payloadKey, reviewOverrides[pickerKey]]),
);

const readTaskDescriptionDraft = (defaultApp) => {
  const raw = safeReadStorage(TASK_DESCRIPTION_DRAFT_KEY);
  if (raw === null) return { description: '', app: defaultApp };
  const draft = safeReadJsonStorage(TASK_DESCRIPTION_DRAFT_KEY, INVALID_DRAFT);
  if (draft === INVALID_DRAFT) return { description: raw, app: defaultApp };
  if (typeof draft === 'string') return { description: draft, app: defaultApp };
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return { description: '', app: defaultApp };
  return {
    description: typeof draft.description === 'string' ? draft.description : '',
    app: typeof draft.app === 'string' && draft.app ? draft.app : defaultApp,
  };
};

const readQuickTemplatesExpanded = (fallback) => {
  const stored = safeReadStorage(QUICK_TEMPLATES_EXPANDED_KEY);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return fallback;
};

const createReviewDefaults = () => ({
  reviewers: [...DEFAULT_REVIEWERS],
  usernames: [],
  optionalReviewers: [],
  reviewerMaxRounds: {},
  reviewerModels: {},
  reviewerEfforts: {},
  stopMode: DEFAULT_REVIEW_STOP_MODE,
  reviewerApplies: false,
});

const createOrchestrationProfile = () => ({
  architect: { provider: '', model: '', effort: '' },
  implementer: { provider: '', model: '', effort: '' },
  reviewer: { provider: '', model: '', effort: '' },
});

const soleSelectableModel = (provider, selectedModel = '') => {
  const models = resolveProviderModelOptions(provider, selectedModel).models;
  return models.length === 1 ? models[0] : '';
};

const runShapeDefaultsPatch = (selectedApp) => {
  const worktreeOptOut = selectedApp?.defaultUseWorktree === false;
  const defaultOpenPR = selectedApp?.defaultOpenPR ?? !worktreeOptOut;
  return {
    useWorktree: (selectedApp?.defaultUseWorktree ?? true) || defaultOpenPR,
    openPR: defaultOpenPR,
    prCompletion: selectedApp?.defaultPrCompletion || DEFAULT_PR_COMPLETION,
  };
};

const appDefaultsPatch = (selectedApp) => ({
  createJiraTicket: !!selectedApp?.jira?.enabled,
  ...runShapeDefaultsPatch(selectedApp),
});

const templateProfile = (profile) => ({
  architect: {
    provider: profile?.architect?.provider || '',
    model: profile?.architect?.model || '',
    effort: profile?.architect?.effort || '',
  },
  implementer: {
    provider: profile?.implementer?.provider || '',
    model: profile?.implementer?.model || '',
    effort: profile?.implementer?.effort || '',
  },
  reviewer: {
    provider: profile?.reviewer?.provider || '',
    model: profile?.reviewer?.model || '',
    effort: profile?.reviewer?.effort || '',
  },
});

export function createTaskAddFormState({ initialDraft, defaultApp = '', apps, queueFirst = false, defaultExpanded = false }) {
  return {
    newTask: {
      description: initialDraft.description,
      model: '',
      provider: '',
      effort: '',
      temperature: '',
      thinking: '',
      app: apps?.some((app) => app.id === initialDraft.app) ? initialDraft.app : defaultApp,
    },
    addToTop: false,
    enhancePrompt: false,
    isEnhancing: false,
    useWorktree: true,
    whenDone: 'leave-uncommitted',
    openPR: true,
    simplify: true,
    planOnly: false,
    issueTarget: 'upstream',
    issueTargets: { appId: null, value: null },
    worktreeChangesExpected: undefined,
    prCompletion: DEFAULT_PR_COMPLETION,
    reviewDefaults: createReviewDefaults(),
    reviewOverrides: {},
    reviewerCliInstalled: {},
    providerReviewUnsupported: {},
    targetInstanceId: '',
    createJiraTicket: false,
    screenshots: [],
    attachments: [],
    templates: [],
    showTemplates: readQuickTemplatesExpanded(queueFirst),
    expanded: defaultExpanded,
    configurationOpen: false,
    templateNameInput: '',
    showTemplateSave: false,
    isSubmitting: false,
    slashdoCommand: '',
    orchestrationMode: 'direct',
    orchestrationProfiles: [],
    selectedProfileId: '',
    orchestrationProfile: createOrchestrationProfile(),
    resolvedWorkTracker: { appId: null, tracker: null },
  };
}

export function taskAddFormReducer(state, action) {
  if (action.type === 'patch') {
    const patch = typeof action.patch === 'function' ? action.patch(state) : action.patch;
    return { ...state, ...patch };
  }
  if (action.type === 'task') {
    const patch = typeof action.patch === 'function' ? action.patch(state.newTask) : action.patch;
    return { ...state, newTask: { ...state.newTask, ...patch } };
  }
  return state;
}

export default function useTaskAddForm({
  providers,
  providersLoaded = true,
  apps,
  onTaskAdded,
  defaultExpanded = false,
  defaultApp = '',
  queueFirst = false,
}) {
  const initialDraftRef = useRef(null);
  if (initialDraftRef.current === null) initialDraftRef.current = readTaskDescriptionDraft(defaultApp);
  const initialDraft = initialDraftRef.current;
  const pendingDraftAppRef = useRef(Boolean(initialDraft.app) && !apps?.length);
  const [state, dispatch] = useReducer(
    taskAddFormReducer,
    { initialDraft, defaultApp, apps, queueFirst, defaultExpanded },
    createTaskAddFormState,
  );

  const setField = (field, value) => dispatch({ type: 'patch', patch: { [field]: value } });
  const setTaskField = (field, value) => dispatch({ type: 'task', patch: { [field]: value } });
  const { instances: assignableInstances, isFederated } = useAssignableInstances();
  const { isFeatureEnabled } = useInstanceFeatures();
  const quickTemplatesEnabled = isFeatureEnabled('cos-task-templates');
  const reviewerModelOptions = useReviewerModelOptions();
  const submittingRef = useRef(false);
  const descriptionRef = useRef(null);
  const templateAppChangeRef = useRef(false);
  const showTemplatesInitialized = useRef(false);

  useEffect(() => {
    api.getOrchestrationProfiles?.({ silent: true })
      ?.then((res) => {
        const list = Array.isArray(res) ? res : res?.profiles || [];
        dispatch({ type: 'patch', patch: { orchestrationProfiles: list } });
      })
      ?.catch(() => {});
  }, []);

  useEffect(() => {
    if (state.newTask.description) {
      safeWriteJsonStorage(TASK_DESCRIPTION_DRAFT_KEY, {
        description: state.newTask.description,
        app: state.newTask.app || null,
      });
    } else {
      safeRemoveStorage(TASK_DESCRIPTION_DRAFT_KEY);
    }
  }, [state.newTask.app, state.newTask.description]);

  useEffect(() => {
    if (!pendingDraftAppRef.current || !apps?.length) return;
    pendingDraftAppRef.current = false;
    if (apps.some((app) => app.id === initialDraft.app)) {
      dispatch({ type: 'task', patch: { app: initialDraft.app } });
    }
  }, [apps, initialDraft.app]);

  const handleAppChange = (app) => {
    pendingDraftAppRef.current = false;
    dispatch({ type: 'task', patch: { app } });
  };

  useEffect(() => {
    if (!state.newTask.app || !apps?.length || apps.some((app) => app.id === state.newTask.app)) return;
    dispatch({ type: 'task', patch: { app: defaultApp } });
  }, [apps, defaultApp, state.newTask.app]);

  useEffect(() => {
    if (!quickTemplatesEnabled) {
      dispatch({ type: 'patch', patch: { templates: [], showTemplateSave: false } });
      return undefined;
    }
    let active = true;
    api.getCosPopularTemplates(8)
      .then((data) => {
        if (active) dispatch({ type: 'patch', patch: { templates: data?.templates || [] } });
      })
      .catch(() => {
        if (active) dispatch({ type: 'patch', patch: { templates: [] } });
      });
    return () => { active = false; };
  }, [quickTemplatesEnabled]);

  useEffect(() => {
    if (!showTemplatesInitialized.current) {
      showTemplatesInitialized.current = true;
      return;
    }
    safeWriteStorage(QUICK_TEMPLATES_EXPANDED_KEY, String(state.showTemplates));
  }, [state.showTemplates]);

  useEffect(() => {
    let cancelled = false;
    api.getCodeReviewDefaults({ silent: true })
      .then((d) => {
        if (cancelled || !d) return;
        dispatch({
          type: 'patch',
          patch: {
            reviewDefaults: {
              reviewers: Array.isArray(d.reviewers) && d.reviewers.length ? d.reviewers : DEFAULT_REVIEWERS,
              usernames: Array.isArray(d.usernames) ? d.usernames : [],
              optionalReviewers: Array.isArray(d.optionalReviewers) ? d.optionalReviewers : [],
              reviewerMaxRounds: d.reviewerMaxRounds && typeof d.reviewerMaxRounds === 'object' && !Array.isArray(d.reviewerMaxRounds) ? d.reviewerMaxRounds : {},
              reviewerModels: reviewerModelsFromDefaults(d),
              reviewerEfforts: reviewerEffortsFromDefaults(d),
              stopMode: d.stopMode || DEFAULT_REVIEW_STOP_MODE,
              reviewerApplies: d.reviewerApplies === true,
            },
            reviewerCliInstalled: d.installed && typeof d.installed === 'object' && !Array.isArray(d.installed) ? d.installed : {},
            providerReviewUnsupported: d.providerReviewUnsupported && typeof d.providerReviewUnsupported === 'object' && !Array.isArray(d.providerReviewUnsupported) ? d.providerReviewUnsupported : {},
          },
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const enabledProviders = useMemo(
    () => providers?.filter((provider) => provider.enabled && isProcessProvider(provider)) || [],
    [providers],
  );

  const apiOnlyProviders = useMemo(() => {
    const enabled = providers?.filter((provider) => provider.enabled) || [];
    return enabled.length > 0 && enabledProviders.length === 0;
  }, [providers, enabledProviders]);

  useEffect(() => {
    if (!providersLoaded) return;
    if (isCompositeProviderId(state.newTask.provider)) return;
    if (state.newTask.provider && !enabledProviders.some((provider) => provider.id === state.newTask.provider)) {
      dispatch({ type: 'task', patch: { provider: '', model: '', effort: '', temperature: '', thinking: '' } });
    }
  }, [enabledProviders, state.newTask.provider, providersLoaded]);

  const selectedApp = useMemo(
    () => apps?.find((app) => app.id === state.newTask.app),
    [apps, state.newTask.app],
  );
  const appHasJira = selectedApp?.jira?.enabled;
  const selectedAppId = selectedApp?.id || PORTOS_APP_ID;

  useEffect(() => {
    const configuredTracker = selectedApp?.workTracker;
    const appId = selectedApp?.id || PORTOS_APP_ID;
    if (selectedApp && configuredTracker && configuredTracker !== 'auto') {
      dispatch({ type: 'patch', patch: { resolvedWorkTracker: { appId, tracker: configuredTracker } } });
      return undefined;
    }

    dispatch({ type: 'patch', patch: { resolvedWorkTracker: { appId, tracker: null } } });
    let cancelled = false;
    Promise.resolve(api.getAppWorkTracker(appId, { silent: true }))
      .then((info) => {
        if (!cancelled) dispatch({ type: 'patch', patch: { resolvedWorkTracker: { appId, tracker: info?.resolved || null } } });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'patch', patch: { resolvedWorkTracker: { appId, tracker: null } } });
      });
    return () => { cancelled = true; };
  }, [selectedApp?.id, selectedApp?.workTracker]);

  const planOnlyTrackerStatus = useMemo(() => {
    const configuredTracker = selectedApp?.workTracker;
    const tracker = configuredTracker && configuredTracker !== 'auto'
      ? configuredTracker
      : state.resolvedWorkTracker.appId === (selectedApp?.id || PORTOS_APP_ID) ? state.resolvedWorkTracker.tracker : null;
    if (!tracker) return 'pending';
    return tracker === 'github' || tracker === 'gitlab' ? 'supported' : 'unsupported';
  }, [state.resolvedWorkTracker, selectedApp]);
  const planOnlySupported = planOnlyTrackerStatus === 'supported';

  useEffect(() => {
    const appId = selectedApp?.id || PORTOS_APP_ID;
    if (!state.planOnly || !planOnlySupported) {
      dispatch({ type: 'patch', patch: { issueTargets: { appId, value: null } } });
      return undefined;
    }
    let cancelled = false;
    dispatch({ type: 'patch', patch: { issueTargets: { appId, value: null } } });
    Promise.resolve(api.getAppRepositorySources(appId, { silent: true }))
      .then((status) => {
        if (cancelled) return;
        const value = status?.issueTargets || null;
        dispatch({ type: 'patch', patch: { issueTargets: { appId, value }, issueTarget: value?.default || 'upstream' } });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'patch', patch: { issueTargets: { appId, value: null } } });
      });
    return () => { cancelled = true; };
  }, [state.planOnly, planOnlySupported, selectedApp?.id]);

  useEffect(() => {
    if (planOnlyTrackerStatus !== 'unsupported' || !state.planOnly) return;
    dispatch({
      type: 'patch',
      patch: {
        planOnly: false,
        ...(state.slashdoCommand === 'plan-task' ? { slashdoCommand: '', worktreeChangesExpected: undefined } : {}),
      },
    });
  }, [state.planOnly, planOnlyTrackerStatus, state.slashdoCommand]);

  const appDefaultsSig = useMemo(
    () => selectedApp
      ? `${selectedApp.id}|${String(selectedApp.defaultOpenPR)}|${selectedApp.defaultPrCompletion || DEFAULT_PR_COMPLETION}|${String(selectedApp.defaultUseWorktree)}|${!!selectedApp.jira?.enabled}`
      : `none:${state.newTask.app || ''}`,
    [selectedApp, state.newTask.app],
  );

  useEffect(() => {
    if (templateAppChangeRef.current) {
      templateAppChangeRef.current = false;
      return;
    }
    if (state.planOnly) {
      dispatch({ type: 'patch', patch: { createJiraTicket: false, useWorktree: false, openPR: false, simplify: false } });
      return;
    }
    dispatch({ type: 'patch', patch: appDefaultsPatch(selectedApp) });
  }, [appDefaultsSig]);

  const selectedProvider = providers?.find((provider) => provider.id === state.newTask.provider);
  const { models: availableModels, source: modelSource, unlistedSelection } = resolveProviderModelOptions(selectedProvider, state.newTask.model);
  const soleAvailableModel = availableModels.length === 1 ? availableModels[0] : '';
  const selectedModelOrSole = state.newTask.model || soleAvailableModel;

  useEffect(() => {
    if (!soleAvailableModel) return;
    dispatch({
      type: 'task',
      patch: (task) => {
        if (!task.provider || task.model === soleAvailableModel || task.model) return task;
        return {
          ...task,
          model: soleAvailableModel,
          effort: effortSurvivingModel(selectedProvider, soleAvailableModel, task.effort),
        };
      },
    });
  }, [soleAvailableModel, selectedProvider]);

  const modelOptions = useMemo(() => availableModels.map((id) => ({
    id,
    name: unlistedSelection && id === state.newTask.model
      ? `${id} (${modelSource === MODEL_SOURCE.account ? 'not in account catalog' : 'no longer offered by this provider'})`
      : id.replace('claude-', '').replace(/-\d+$/, ''),
  })), [availableModels, unlistedSelection, modelSource, state.newTask.model]);

  const modelSourceNote = (() => {
    if (!isCodexSubscriptionProvider(selectedProvider)) return '';
    if (modelSource === MODEL_SOURCE.account) return 'Models your signed-in ChatGPT account can run.';
    if (modelSource === MODEL_SOURCE.accountEmpty) return 'Your signed-in ChatGPT account exposes no models.';
    return 'Showing PortOS’s bundled list — the signed-in ChatGPT account catalog has not been loaded.';
  })();

  const providerModelNote = (() => {
    if (!selectedProvider) return '';
    if (modelSource === MODEL_SOURCE.accountEmpty) return 'Your signed-in account exposes no models.';
    if (isTuiProvider(selectedProvider)) return `${selectedProvider.name} runs in an attachable terminal UI session.`;
    if (isCliProvider(selectedProvider)) return `${selectedProvider.name} uses its CLI configured default model.`;
    return 'No models are configured. PortOS will use the provider default.';
  })();

  const handleSelectOrchestrationProfile = (profileId) => {
    const found = state.orchestrationProfiles.find((profile) => profile.id === profileId);
    dispatch({
      type: 'patch',
      patch: {
        selectedProfileId: profileId,
        ...(found?.profile ? { orchestrationProfile: templateProfile(found.profile) } : {}),
      },
    });
  };

  const updateOrchestrationRoleField = (roleKey, field, value) => {
    dispatch({
      type: 'patch',
      patch: (current) => {
        const roleData = current.orchestrationProfile[roleKey] || {};
        const updatedRole = { ...roleData, [field]: value };
        if (field === 'provider') {
          const provider = providers?.find((item) => item.id === value);
          const sole = soleSelectableModel(provider);
          updatedRole.model = sole;
          updatedRole.effort = sole ? effortSurvivingModel(provider, sole, '') : '';
        } else if (field === 'model') {
          const provider = providers?.find((item) => item.id === roleData.provider);
          updatedRole.effort = effortSurvivingModel(provider, value, roleData.effort);
        }
        return { orchestrationProfile: { ...current.orchestrationProfile, [roleKey]: updatedRole } };
      },
    });
  };

  const handleProviderChange = (providerId) => {
    const model = soleSelectableModel(providers?.find((provider) => provider.id === providerId));
    dispatch({ type: 'task', patch: { provider: providerId, model, effort: '', temperature: '', thinking: '' } });
  };

  const handlePlanOnlyChange = (enabled) => {
    if (enabled && !planOnlySupported) return;
    if (enabled) {
      dispatch({
        type: 'patch',
        patch: {
          planOnly: true,
          slashdoCommand: 'plan-task',
          createJiraTicket: false,
          useWorktree: false,
          openPR: false,
          simplify: false,
          worktreeChangesExpected: false,
        },
      });
      return;
    }
    dispatch({
      type: 'patch',
      patch: state.slashdoCommand === 'plan-task'
        ? { planOnly: false, ...runShapeDefaultsPatch(selectedApp), simplify: true, worktreeChangesExpected: undefined }
        : { planOnly: false },
    });
  };

  const applyTemplate = async (template) => {
    if (template.app) pendingDraftAppRef.current = false;
    const seeded = seedModelEffort(
      providers?.find((provider) => provider.id === template.provider),
      template.model,
      template.effort,
    );
    const nextTask = {
      ...state.newTask,
      description: template.description,
      ...(template.app ? { app: template.app } : {}),
      ...(template.provider ? { provider: template.provider, model: seeded.model, effort: seeded.effort } : {}),
    };
    const templatePlanOnly = template.slashdoCommand === 'plan-task';
    const patch = {
      newTask: nextTask,
      slashdoCommand: template.slashdoCommand || '',
      planOnly: templatePlanOnly,
      worktreeChangesExpected: template.settings?.worktreeChangesExpected,
    };
    if (state.planOnly && !templatePlanOnly) {
      Object.assign(patch, runShapeDefaultsPatch(selectedApp), { simplify: true });
    }
    if (template.app && template.app !== state.newTask.app) templateAppChangeRef.current = true;
    if (template.settings && typeof template.settings === 'object') {
      if (template.settings.useWorktree !== undefined) patch.useWorktree = template.settings.useWorktree;
      if (template.settings.openPR !== undefined) patch.openPR = template.settings.openPR;
      if (template.settings.simplify !== undefined) patch.simplify = template.settings.simplify;
    }
    if (templatePlanOnly) {
      Object.assign(patch, {
        createJiraTicket: false,
        useWorktree: false,
        openPR: false,
        simplify: false,
        worktreeChangesExpected: false,
      });
    }
    dispatch({ type: 'patch', patch });
    descriptionRef.current?.focus();
    const usageRecorded = await api.applyCosTaskTemplate(template.id, { silent: true })
      .then(() => true)
      .catch((error) => {
        console.warn(`⚠️ Template usage not recorded for ${template.id}: ${error?.message || error}`);
        toast.warning('Template applied locally, but usage could not be recorded');
        return false;
      });
    if (usageRecorded) toast.success(`Template applied: ${template.name}`);
  };

  const saveAsTemplate = async () => {
    if (!state.newTask.description.trim()) {
      toast.error('Enter a task description first');
      return;
    }
    if (!state.showTemplateSave) {
      setField('templateNameInput', state.newTask.description.substring(0, 40));
      setField('showTemplateSave', true);
      return;
    }
    if (!state.templateNameInput.trim()) {
      toast.error('Template name is required');
      return;
    }
    const result = await api.createCosTaskTemplate({
      name: state.templateNameInput.trim(),
      description: state.newTask.description,
      provider: state.newTask.provider,
      model: state.newTask.model || soleAvailableModel,
      effort: state.newTask.effort,
      app: state.newTask.app,
      ...(state.planOnly ? {
        slashdoCommand: 'plan-task',
        settings: {
          useWorktree: false,
          openPR: false,
          simplify: false,
          worktreeChangesExpected: false,
        },
      } : {}),
    }, { silent: true }).catch((error) => {
      toast.error(error.message);
      return null;
    });
    if (result?.success) {
      toast.success('Template saved');
      setField('showTemplateSave', false);
      setField('templateNameInput', '');
      api.getCosPopularTemplates(8)
        .then((data) => dispatch({ type: 'patch', patch: { templates: data?.templates || [] } }))
        .catch((error) => console.warn(`⚠️ Template refresh failed: ${error?.message || error}`));
    }
  };

  const deleteTemplate = async (templateId, event) => {
    event.stopPropagation();
    const result = await api.deleteCosTaskTemplate(templateId, { silent: true }).catch((error) => {
      toast.error(error.message);
      return null;
    });
    if (result?.success) {
      dispatch({ type: 'patch', patch: (current) => ({ templates: current.templates.filter((template) => template.id !== templateId) }) });
    }
  };

  const handleFileSelect = async (event) => {
    await processScreenshotUploads(event.target.files, {
      onSuccess: (fileInfo) => dispatch({ type: 'patch', patch: (current) => ({ screenshots: [...current.screenshots, fileInfo] }) }),
      onError: (message) => toast.error(message),
    });
  };

  const removeScreenshot = (id) => {
    dispatch({ type: 'patch', patch: (current) => ({ screenshots: current.screenshots.filter((screenshot) => screenshot.id !== id) }) });
  };

  const handleAttachmentSelect = async (event) => {
    await processAttachmentUploads(event.target.files, {
      onSuccess: (fileInfo) => dispatch({ type: 'patch', patch: (current) => ({ attachments: [...current.attachments, fileInfo] }) }),
      onError: (message) => toast.error(message),
    });
  };

  const removeAttachment = (id) => {
    dispatch({ type: 'patch', patch: (current) => ({ attachments: current.attachments.filter((attachment) => attachment.id !== id) }) });
  };

  const handleAddTask = async () => {
    if (submittingRef.current) return;
    if (!state.newTask.description.trim()) {
      toast.error('Description is required');
      return;
    }

    submittingRef.current = true;
    dispatch({ type: 'patch', patch: { isSubmitting: true } });

    let finalDescription = state.newTask.description;
    if (state.enhancePrompt) {
      dispatch({ type: 'patch', patch: { isEnhancing: true } });
      const enhanceResult = await api.enhanceCosTaskPrompt({ description: state.newTask.description }).catch((error) => {
        toast('Enhancement failed, using original description', { icon: '⚠️' });
        console.warn(`⚠️ Task enhancement failed: ${error.message}`);
        return null;
      });
      if (enhanceResult?.enhancedDescription?.trim()) {
        finalDescription = enhanceResult.enhancedDescription;
        toast.success('Prompt enhanced');
      } else if (enhanceResult) {
        toast('Enhancement returned empty result, using original', { icon: '⚠️' });
      }
      dispatch({ type: 'patch', patch: { isEnhancing: false } });
    }

    const result = await api.addCosTask({
      description: finalDescription,
      model: selectedModelOrSole || undefined,
      provider: state.newTask.provider || undefined,
      effort: state.newTask.effort || undefined,
      orchestrationMode: state.orchestrationMode === 'orchestrated' ? 'orchestrated' : undefined,
      orchestrationProfile: state.orchestrationMode === 'orchestrated' ? state.orchestrationProfile : undefined,
      temperature: state.newTask.temperature === '' ? undefined : Number(state.newTask.temperature),
      thinking: state.newTask.thinking === '' ? undefined : state.newTask.thinking === 'true',
      app: state.newTask.app || undefined,
      targetInstanceId: state.targetInstanceId || undefined,
      planOnly: state.planOnly,
      issueTarget: state.planOnly ? state.issueTarget : undefined,
      slashdoCommand: state.planOnly ? 'plan-task' : (state.slashdoCommand || undefined),
      slashdoArgs: state.planOnly ? '--yes' : undefined,
      createJiraTicket: state.planOnly ? false : state.createJiraTicket,
      useWorktree: state.planOnly ? false : state.useWorktree,
      whenDone: state.planOnly || state.useWorktree ? undefined : state.whenDone,
      openPR: state.planOnly ? false : state.useWorktree && state.openPR,
      simplify: state.planOnly ? false : state.simplify,
      ...(state.planOnly
        ? { worktreeChangesExpected: false }
        : state.worktreeChangesExpected !== undefined ? { worktreeChangesExpected: state.worktreeChangesExpected } : {}),
      prCompletion: !state.planOnly && state.useWorktree && state.openPR ? state.prCompletion : undefined,
      ...(!state.planOnly && state.openPR && state.prCompletion === 'review-then-merge' ? reviewOverridePayload(state.reviewOverrides) : {}),
      screenshots: state.screenshots.length > 0 ? state.screenshots.map((screenshot) => screenshot.path) : undefined,
      attachments: state.attachments.length > 0 ? state.attachments.map((attachment) => ({
        filename: attachment.filename,
        originalName: attachment.originalName,
        path: attachment.path,
        size: attachment.size,
        mimeType: attachment.mimeType,
      })) : undefined,
      position: state.addToTop ? 'top' : 'bottom',
    }, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to add task');
      return null;
    });

    submittingRef.current = false;
    dispatch({ type: 'patch', patch: { isSubmitting: false, isEnhancing: false } });
    if (!result) return;

    dispatch({
      type: 'patch',
      patch: {
        newTask: { ...state.newTask, description: '' },
        slashdoCommand: state.planOnly ? 'plan-task' : '',
        worktreeChangesExpected: state.planOnly ? false : undefined,
        screenshots: [],
        attachments: [],
      },
    });
    safeRemoveStorage(TASK_DESCRIPTION_DRAFT_KEY);
    toast.success('Task added');
    onTaskAdded?.(result, { position: state.addToTop ? 'top' : 'bottom' });
  };

  const handleDescriptionKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.repeat || state.isSubmitting
      || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
    event.preventDefault();
    handleAddTask();
  };

  return {
    state,
    apps,
    providersLoaded,
    setField,
    setTaskField,
    handleAppChange,
    handleProviderChange,
    handlePlanOnlyChange,
    handleSelectOrchestrationProfile,
    updateOrchestrationRoleField,
    applyTemplate,
    saveAsTemplate,
    deleteTemplate,
    handleFileSelect,
    removeScreenshot,
    handleAttachmentSelect,
    removeAttachment,
    handleAddTask,
    handleDescriptionKeyDown,
    descriptionRef,
    assignableInstances,
    isFederated,
    quickTemplatesEnabled,
    reviewerModelOptions,
    enabledProviders,
    apiOnlyProviders,
    selectedApp,
    selectedAppId,
    appHasJira,
    selectedProvider,
    availableModels,
    modelSource,
    unlistedSelection,
    soleAvailableModel,
    selectedModelOrSole,
    modelOptions,
    modelSourceNote,
    providerModelNote,
    planOnlyTrackerStatus,
    planOnlySupported,
    issueTargets: state.issueTargets,
  };
}
