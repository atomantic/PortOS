import { getSettings, updateSettings } from './settings.js';
import { getProviderById, getSelectableProviders, isOllamaBackedProvider, setActiveProvider, updateProvider } from './provider/providers.js';
import * as brainStorage from './brainStorage.js';
import * as universeService from './universeBuilder.js';
import * as storyBuilderService from './storyBuilder.js';
import * as pipelineSeriesService from './pipeline/series.js';
import * as taskScheduleService from './taskSchedule.js';
import * as loopsService from './loops.js';
import * as featureAgentsService from './featureAgents.js';
import * as agentPersonalitiesService from './agent/agentPersonalities.js';
import * as autonomousJobsService from './autonomousJobs.js';
import { getVoiceConfig, updateVoiceConfig } from './voice/config.js';
import { isPlainObject } from '../lib/objects.js';
import { ServerError } from '../lib/errorHandler.js';
import { effortLevelsForProvider } from '../lib/provider/providerModels.js';
import { isToolFreeOneShotProvider } from '../lib/provider/providerVendors.js';
import { memoryClassifierSettingsSchema } from '../lib/instanceSettingsValidation.js';
import { validateRequest } from '../lib/validateRequest.js';

const textProviderTypes = ['api', 'cli', 'tui'];
const cliProviderTypes = ['cli', 'tui'];
const apiProviderTypes = ['api'];
const embeddingProviders = [
  { id: 'none', name: 'Disabled' },
  { id: 'ollama', name: 'Ollama' },
  { id: 'lmstudio', name: 'LM Studio' },
];

// Shared shape for every assignment whose provider runs an AGENT HARNESS. Such a
// stage only works with a model that emits native tool calls — a local model that
// can't (e.g. Gemma) narrates a done-message instead of acting, silently wedging
// the run. `needsTools` is the SERVER-side source of truth every editor reads
// (AI Assignments, the Creative Director Models drawer, any future one), so the
// flag can't drift per-editor the way the drawer's hard-coded stage list did —
// that list left the same pins editable without a warning from AI Assignments.
// Mirrors how the scene-evaluation entry carries `modelFilter: 'vision'`.
const agentEntry = { providerTypes: cliProviderTypes, needsTools: true };

const asNullable = (value) => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
};

const validationError = (message) => new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });

const pickModelOptions = (provider) => {
  const raw = Array.isArray(provider?.models) ? provider.models : [];
  const ids = raw.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
  if (provider?.defaultModel && !ids.includes(provider.defaultModel)) ids.unshift(provider.defaultModel);
  return ids;
};

const makeEntry = ({
  id,
  area,
  label,
  source,
  providerId = null,
  model = null,
  effort = null,
  assignmentType = 'Configuration',
  scope = 'global',
  editable = true,
  providerEditable = true,
  modelEditable = true,
  effortEditable = false,
  providerTypes = textProviderTypes,
  providerOptions = null,
  providerPlaceholder = null,
  modelOptions = null,
  // Optional client-side model-list filter key. `'vision'` tells the AI
  // Assignments / Creative Director pickers to restrict LOCAL backends
  // (Ollama / LM Studio) to vision-capable models only.
  modelFilter = null,
  // Marks an assignment whose provider runs an agent harness (see `agentEntry`).
  // Editors annotate their model options with a tool-use marker and warn when the
  // EFFECTIVE model (explicit pin, else the provider default) isn't a recognized
  // tool-caller. Advisory only — never a filter, because the capability signal is
  // a positive allowlist and a non-match is "unrecognized", not a proven negative.
  needsTools = false,
  link = null,
  notes = '',
}) => ({
  id,
  area,
  label,
  source,
  providerId: providerId || null,
  model: model || null,
  effort: effort || null,
  assignmentType,
  scope,
  editable,
  providerEditable,
  modelEditable,
  effortEditable,
  providerTypes,
  providerOptions,
  providerPlaceholder,
  modelOptions,
  modelFilter,
  needsTools,
  link,
  notes,
});

const patchSettingsPath = async (path, value) => {
  const settings = await getSettings();
  const segments = path.split('.');
  const top = segments[0];
  const root = isPlainObject(settings[top]) ? { ...settings[top] } : {};
  let cur = root;
  for (const segment of segments.slice(1, -1)) {
    cur[segment] = isPlainObject(cur[segment]) ? { ...cur[segment] } : {};
    cur = cur[segment];
  }
  cur[segments[segments.length - 1]] = value;
  await updateSettings({ [top]: root });
};

const automationSettingsHandlers = [
  { key: 'autofixer', label: 'Autofixer', link: '/settings/autofixer' },
  { key: 'calendarSync', label: 'Calendar Sync', link: '/calendar/config' },
].map(({ key, label, link }) => ({
  id: `settings.${key}`,
  collect: ({ settings }, id) => ({
    area: 'Automation',
    assignmentType: 'Agents & automation',
    label,
    source: id,
    providerId: settings[key]?.providerId,
    model: settings[key]?.model,
    ...agentEntry,
    notes: 'Requires a CLI/TUI provider because it runs agentic tool work.',
    link,
  }),
  update: ({ providerId, model }) => updateSettings({ [key]: { providerId, model } }),
}));

const creativeDirectorHandlers = [
  {
    stage: 'treatment',
    label: 'Treatment generation model',
    notes: 'Agent model that turns a project brief into a treatment and scene plan. Blank = system default provider and model. Each Creative Director project can override this from its Models drawer.',
  },
  {
    stage: 'plan',
    label: 'Production planning model',
    notes: 'Agent model that converts a production directive into an executable plan. Blank = system default provider and model. Each Creative Director project can override this from its Models drawer.',
  },
  {
    stage: 'evaluation',
    label: 'Scene evaluation vision model',
    notes: 'Vision model that judges each rendered scene. Use a local Ollama or LM Studio VLM here. Blank = auto-pick an installed local vision model; if none is available it falls back to the coding agent. Each Creative Director project can override this from its Models drawer.',
  },
].map(({ stage, label, notes }) => ({
  id: `settings.creativeDirector.${stage}`,
  collect: ({ settings }, id) => ({
    area: 'Creative Director',
    assignmentType: 'Creative workflows',
    label,
    source: id,
    providerId: settings.creativeDirector?.[stage]?.providerId,
    model: settings.creativeDirector?.[stage]?.model,
    ...(stage === 'evaluation'
      ? { providerTypes: apiProviderTypes, modelFilter: 'vision' }
      : { ...agentEntry, effort: settings.creativeDirector?.[stage]?.effort, effortEditable: true }),
    notes,
    link: '/creative-director',
  }),
  update: ({ providerId, model, effortPatch }) => patchSettingsPath(`creativeDirector.${stage}`, {
    providerId, model, ...(stage === 'evaluation' ? {} : effortPatch),
  }),
}));

const messageHandlers = ['triage', 'reply'].map(action => ({
  id: `settings.messages.${action}`,
  collect: ({ messages }, id) => ({
    area: 'Messages',
    assignmentType: 'Voice & messaging',
    label: `${action[0].toUpperCase()}${action.slice(1)} assistant`,
    source: id,
    providerId: messages[action]?.providerId || messages.providerId,
    model: messages[action]?.model || messages.model,
    link: '/messages/config',
  }),
  update: async ({ providerId, model }) => {
    const settings = await getSettings();
    const messages = isPlainObject(settings.messages) ? { ...settings.messages } : {};
    const current = isPlainObject(messages[action]) ? messages[action] : {};
    messages[action] = { ...current, providerId, model };
    await updateSettings({ messages });
  },
}));

const codeReviewHandlers = ['lmstudio', 'ollama'].map(backend => ({
  id: `settings.codeReview.${backend}`,
  collect: ({ settings }) => ({
    area: 'Review Loop',
    label: `${backend === 'lmstudio' ? 'LM Studio' : 'Ollama'} reviewer model`,
    source: `settings.codeReview.${backend}Model`,
    providerId: backend,
    model: settings.codeReview?.[`${backend}Model`],
    providerEditable: false,
    providerTypes: [],
    notes: 'Model used when the local reviewer is in the default review chain.',
    link: '/ai',
  }),
  update: ({ model }) => patchSettingsPath(`codeReview.${backend}Model`, model),
}));

const settingsHandlers = [
  {
    id: 'settings.embeddings',
    collect: ({ settings }, id) => ({
      area: 'Memory & Catalog',
      label: 'Vector embeddings',
      source: id,
      providerId: settings.embeddings?.provider || 'none',
      model: settings.embeddings?.model || null,
      providerOptions: embeddingProviders,
      providerTypes: [],
      notes: 'Powers semantic search for the creative catalog and memory (Brain, Chief of Staff retrieval). Until saved, memory keeps the legacy Chief of Staff embedding config.',
      link: '/models/embeddings',
    }),
    update: ({ providerId, model }) => updateSettings({ embeddings: { provider: providerId || 'none', model } }),
  },
  {
    id: 'settings.memoryClassifier',
    collect: ({ settings, providers }, id) => ({
      area: 'Memory & Catalog',
      label: 'Memory extraction model',
      source: id,
      providerId: settings.memoryClassifier?.providerId,
      model: settings.memoryClassifier?.model,
      providerOptions: [
        { id: 'none', name: 'Disabled' },
        ...providers.filter(isToolFreeOneShotProvider).map(p => ({
          id: p.id, name: p.name, enabled: p.enabled !== false,
        })),
      ],
      providerPlaceholder: 'Legacy LM Studio',
      providerTypes: ['api', 'cli'],
      notes: 'Classifies agent output using a provider that can run without tools. Disabled skips AI classification and keeps the configured pattern fallback.',
    }),
    update: async ({ providerId, model }) => {
      const assignment = validateRequest(memoryClassifierSettingsSchema, {
        providerId,
        model: providerId && providerId !== 'none' ? model : null,
      });
      if (assignment.providerId && assignment.providerId !== 'none') {
        const provider = await getProviderById(assignment.providerId);
        if (!isToolFreeOneShotProvider(provider) || provider.enabled === false) {
          throw validationError('Choose an enabled provider that can run without tools');
        }
      }
      await updateSettings({ memoryClassifier: assignment });
    },
  },
  ...automationSettingsHandlers,
  ...creativeDirectorHandlers,
  {
    id: 'settings.voice.llm',
    collect: ({ voice }, id) => ({
      area: 'Voice',
      assignmentType: 'Voice & messaging',
      label: 'Conversational LLM',
      source: id,
      providerId: voice.llm?.provider || null,
      model: voice.llm?.model || null,
      providerTypes: apiProviderTypes,
      link: '/settings/voice',
    }),
    update: ({ providerId, model }) => updateVoiceConfig({ llm: { provider: providerId || '', model: model || '' } }),
  },
  {
    id: 'settings.voice.vision',
    collect: ({ voice }, id) => ({
      area: 'Voice',
      assignmentType: 'Voice & messaging',
      label: 'Screen vision model',
      source: 'settings.voice.llm.visionModel',
      providerId: voice.llm?.provider || null,
      model: voice.llm?.visionModel || null,
      providerEditable: false,
      providerTypes: apiProviderTypes,
      link: '/settings/voice',
    }),
    update: ({ model }) => updateVoiceConfig({ llm: { visionModel: model || '' } }),
  },
  {
    id: 'settings.voice.codeAgent',
    collect: ({ voice }, id) => ({
      area: 'Voice',
      assignmentType: 'Voice & messaging',
      label: 'Delegated coding agent',
      source: 'settings.voice.llm.codeAgent',
      providerId: voice.llm?.codeAgent?.provider || null,
      model: voice.llm?.codeAgent?.model || null,
      ...agentEntry,
      link: '/settings/voice',
    }),
    update: ({ providerId, model }) => updateVoiceConfig({ llm: { codeAgent: { provider: providerId || '', model: model || '' } } }),
  },
  ...messageHandlers,
  ...codeReviewHandlers,
];

const addSettingsEntries = async (entries, providers) => {
  const settings = await getSettings();
  const voice = await getVoiceConfig().catch(() => settings.voice || {});
  const context = { settings, providers, voice, messages: settings.messages || {} };
  for (const { id, collect } of settingsHandlers) {
    entries.push(makeEntry({ id, ...collect(context, id) }));
  }
};

const providerModelFields = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];
// Provider registry entries have their own editor. Keep these write IDs for existing clients.
const providerHandlers = [
  {
    id: 'provider.active',
    update: ({ providerId }) => {
      if (!providerId) throw validationError('System default provider is required');
      return setActiveProvider(providerId);
    },
  },
  {
    prefix: 'provider.model.',
    update: async ({ model }, suffix) => {
      // A provider ID can contain dots. Model field names are dotless.
      const lastDot = suffix.lastIndexOf('.');
      const field = suffix.slice(lastDot + 1);
      if (lastDot <= 0 || !providerModelFields.includes(field)) throw validationError('Invalid provider model assignment');
      const id = suffix.slice(0, lastDot);
      const provider = await getProviderById(id);
      if (!provider) throw new ServerError(`Provider not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
      await updateProvider(id, { [field]: model });
    },
  },
  {
    prefix: 'provider.fallback.',
    update: ({ providerId }, id) => updateProvider(id, { fallbackProvider: providerId }),
  },
];

const worldRecordHandlers = [
  {
    prefix: 'universe.',
    area: 'Universe Builder',
    load: () => universeService.listUniverses(),
    updateRecord: (id, patch) => universeService.updateUniverse(id, patch),
    label: (record) => record.name,
    source: (id) => `universe ${id}.llm`,
    link: (id) => `/universes/${id}`,
  },
  {
    prefix: 'story.',
    area: 'Story Builder',
    load: () => storyBuilderService.listStorySessions(),
    updateRecord: (id, patch) => storyBuilderService.updateStorySession(id, patch),
    label: (record) => record.title,
    source: (id) => `story session ${id}.llm`,
    link: (id) => `/story-builder/${id}`,
  },
  {
    prefix: 'pipeline.series.',
    area: 'Pipeline',
    load: () => pipelineSeriesService.listSeries(),
    updateRecord: (id, patch) => pipelineSeriesService.updateSeries(id, patch),
    label: (record) => record.name,
    source: (id) => `pipeline series ${id}.llm`,
    link: (id) => `/pipeline/series/${id}`,
  },
].map(({ prefix, area, load, updateRecord, label, source, link }) => ({
  prefix,
  load: () => load().catch(() => []),
  collect: (records) => records.filter(({ llm }) => llm?.provider || llm?.model).map(record => ({
    id: `${prefix}${record.id}`,
    area,
    assignmentType: 'World & story building',
    label: label(record),
    source: source(record.id),
    providerId: record.llm.provider,
    model: record.llm.model,
    scope: 'record',
    link: link(record.id),
  })),
  update: ({ providerId, model }, id) => updateRecord(id, { llm: { provider: providerId, model } }),
}));

const hasScheduledAssignment = (config) => Boolean(config?.providerId || config?.model || config?.effort);

const scheduledEntry = ({ providerId, model, effort }, metadata) => ({
  area: 'Chief of Staff',
  assignmentType: 'Scheduled tasks',
  providerId,
  model,
  effort,
  effortEditable: true,
  scope: 'record',
  ...metadata,
});

const updateScheduledStage = async (id, suffix, updateStage) => {
  const [taskType, indexRaw] = suffix.split('.');
  const index = Number(indexRaw);
  const task = await taskScheduleService.getTaskInterval(taskType);
  const stages = [...(task.taskMetadata?.pipeline?.stages || [])];
  if (!stages[index]) throw new ServerError(`Stage not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
  stages[index] = updateStage(stages[index]);
  await taskScheduleService.updateTaskInterval(taskType, {
    taskMetadata: { ...(task.taskMetadata || {}), pipeline: { ...(task.taskMetadata?.pipeline || {}), stages } },
  });
};

const scheduledStageHandlers = [
  {
    prefix: 'cos.taskStage.',
    collect: (stage, taskType, index, prefix) => {
      if (!hasScheduledAssignment(stage)) return null;
      return scheduledEntry(stage, {
        id: `${prefix}${taskType}.${index}`,
        label: `${taskType} stage: ${stage.name || index + 1}`,
        source: `cos task ${taskType}.taskMetadata.pipeline.stages[${index}]`,
        ...agentEntry,
        link: '/cos/config',
      });
    },
    update: ({ providerId, model, effortPatch }, suffix, id) =>
      updateScheduledStage(id, suffix, stage => ({ ...stage, providerId, model, ...effortPatch })),
  },
  {
    prefix: 'cos.taskStageFallback.',
    collect: (stage, taskType, index, prefix) => {
      if (!hasScheduledAssignment(stage?.largeInputFallback)) return null;
      return scheduledEntry(stage.largeInputFallback, {
        id: `${prefix}${taskType}.${index}`,
        label: `${taskType} stage: ${stage.name || index + 1} (large-input fallback)`,
        source: `cos task ${taskType}.taskMetadata.pipeline.stages[${index}].largeInputFallback`,
        providerTypes: cliProviderTypes,
        notes: 'Requires a tool-free public-review provider and a model with enough context for the complete input. Configure eligible choices in the scheduled task options.',
        link: '/cos/config',
      });
    },
    update: ({ providerId, model, effortPatch }, suffix, id) =>
      updateScheduledStage(id, suffix, stage => {
        if (!isPlainObject(stage.largeInputFallback)) {
          throw new ServerError(`Fallback not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
        }
        const fallback = { ...stage.largeInputFallback, providerId, model, ...effortPatch };
        for (const key of ['providerId', 'model', 'effort']) {
          if (fallback[key] == null) delete fallback[key];
        }
        return { ...stage, largeInputFallback: fallback };
      }),
  },
];

const socialAgentKeys = ['default', 'content', 'engagement'];

const recordHandlers = [
  {
    id: 'brain.default',
    load: () => brainStorage.loadMeta().catch(() => null),
    collect: (meta, id) => meta ? [{
      id,
      area: 'Brain',
      label: 'Default classifier and digest model',
      source: 'brain/meta.json',
      providerId: meta.defaultProvider,
      model: meta.defaultModel,
      link: '/brain/config',
    }] : [],
    update: ({ providerId, model }) => brainStorage.updateMeta({ defaultProvider: providerId, defaultModel: model }),
  },
  ...worldRecordHandlers,
  {
    prefix: 'cos.task.',
    load: () => taskScheduleService.getScheduleStatus().catch(() => null),
    collect: (schedule, prefix) => {
      const entries = [];
      for (const [taskType, task] of Object.entries(schedule?.tasks || {})) {
        if (hasScheduledAssignment(task)) {
          entries.push(scheduledEntry(task, {
            id: `${prefix}${taskType}`,
            label: `Scheduled task: ${taskType}`,
            source: `cos task-schedule ${taskType}`,
            ...agentEntry,
            link: '/cos/config',
          }));
        }
        for (const [index, stage] of (task.taskMetadata?.pipeline?.stages || []).entries()) {
          for (const handler of scheduledStageHandlers) {
            const entry = handler.collect(stage, taskType, index, handler.prefix);
            if (entry) entries.push(entry);
          }
        }
      }
      return entries;
    },
    update: async ({ providerId, model, effortPatch }, taskType) => {
      // The schedule writer creates missing tasks; this editor only updates existing ones.
      const status = await taskScheduleService.getScheduleStatus();
      if (!status?.tasks?.[taskType]) throw new ServerError(`Scheduled task not found: ${taskType}`, { status: 404, code: 'NOT_FOUND' });
      await taskScheduleService.updateTaskInterval(taskType, { providerId, model, ...effortPatch });
    },
  },
  {
    prefix: 'loop.',
    load: () => loopsService.getLoops().catch(() => []),
    collect: (loops, prefix) => loops.filter(loop => loop.providerId).map(loop => ({
      id: `${prefix}${loop.id}`,
      area: 'Loops',
      assignmentType: 'Agents & automation',
      label: loop.name || loop.id,
      source: `loop ${loop.id}.providerId`,
      providerId: loop.providerId,
      scope: 'record',
      modelEditable: false,
      ...agentEntry,
      link: '/loops',
    })),
    update: ({ providerId }, id) => loopsService.updateLoop(id, { providerId }),
  },
  {
    prefix: 'featureAgent.',
    load: () => featureAgentsService.getAllFeatureAgents().catch(() => []),
    collect: (agents, prefix) => agents.filter(agent => agent.providerId || agent.model).map(agent => ({
      id: `${prefix}${agent.id}`,
      area: 'Feature Agents',
      assignmentType: 'Agents & automation',
      label: agent.name,
      source: `feature agent ${agent.id}`,
      providerId: agent.providerId,
      model: agent.model,
      scope: 'record',
      ...agentEntry,
      link: `/feature-agents/${agent.id}/config`,
    })),
    update: async ({ providerId, model }, id) => {
      const updated = await featureAgentsService.updateFeatureAgent(id, { providerId, model });
      if (!updated) throw new ServerError(`Feature agent not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
    },
  },
  {
    prefix: 'socialAgent.',
    load: () => agentPersonalitiesService.getAllAgents().catch(() => []),
    collect: (agents, prefix) => agents.flatMap(agent => {
      const entries = [];
      for (const key of socialAgentKeys) {
        const config = key === 'default' ? agent.aiConfig : agent.aiConfig?.[key];
        if (!config?.providerId && !config?.model) continue;
        entries.push({
          id: `${prefix}${agent.id}.${key}`,
          area: 'Social Agents',
          assignmentType: 'Agents & automation',
          label: `${agent.name} ${key}`,
          source: `agent personality ${agent.id}.aiConfig.${key}`,
          providerId: config.providerId,
          model: config.model,
          scope: 'record',
          link: `/agents/${agent.id}/overview`,
        });
      }
      return entries;
    }),
    update: async ({ providerId, model }, suffix) => {
      const parts = suffix.split('.');
      const [agentId, key] = parts;
      if (parts.length !== 2 || !agentId.trim() || !socialAgentKeys.includes(key)) {
        throw validationError('Invalid social agent assignment');
      }
      const agent = await agentPersonalitiesService.getAgentById(agentId);
      if (!agent) throw new ServerError(`Agent not found: ${agentId}`, { status: 404, code: 'NOT_FOUND' });
      const aiConfig = isPlainObject(agent.aiConfig) ? { ...agent.aiConfig } : {};
      const assignment = { providerId: providerId || undefined, model: model || undefined };
      if (key === 'default') Object.assign(aiConfig, assignment);
      else aiConfig[key] = { ...(isPlainObject(aiConfig[key]) ? aiConfig[key] : {}), ...assignment };
      await agentPersonalitiesService.updateAgent(agentId, { aiConfig });
    },
  },
  {
    prefix: 'cos.job.',
    load: () => autonomousJobsService.getAllJobs().catch(() => []),
    // Legacy/custom jobs without a type still execute as agent jobs.
    collect: (jobs, prefix) => jobs.filter(job => (job.type || 'agent') === 'agent' && hasScheduledAssignment(job)).map(job =>
      scheduledEntry(job, {
        id: `${prefix}${job.id}`,
        label: `Scheduled job: ${job.name}`,
        source: `cos autonomous job ${job.id}`,
        ...agentEntry,
        link: '/cos/jobs',
      })),
    update: async ({ providerId, model, effortPatch }, id) => {
      const updated = await autonomousJobsService.updateJob(id, { providerId, model, ...effortPatch });
      if (!updated) throw new ServerError(`Scheduled job not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
    },
  },
];

const assignmentHandlers = [...providerHandlers, ...settingsHandlers, ...recordHandlers, ...scheduledStageHandlers];

const addRecordEntries = async (entries) => {
  const records = await Promise.all(recordHandlers.map(({ load }) => load()));
  for (const [index, { id, prefix, collect }] of recordHandlers.entries()) {
    for (const entry of collect(records[index], id ?? prefix)) entries.push(makeEntry(entry));
  }
};

export async function getAiAssignments() {
  // The assignment page is a PICKER, so it takes the entitlement-scoped list:
  // offering a model the account cannot run is the failure this whole payload
  // exists to prevent (docs/MODEL_ACCESS.md).
  const providersData = await getSelectableProviders();
  const entries = [];
  await addSettingsEntries(entries, providersData.providers);
  await addRecordEntries(entries);
  return {
    providers: providersData.providers.map((p) => {
      const models = pickModelOptions(p);
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        enabled: p.enabled !== false,
        defaultModel: p.defaultModel || null,
        models,
        // Publish only the derived capability, never the command/path used to
        // detect it. Renamed/path-configured CLIs then retain effort controls
        // without exposing machine identity in this safe settings payload.
        effortLevels: [...(effortLevelsForProvider(p) || [])],
        effortLevelsByModel: Object.fromEntries(models.map((model) => [
          model,
          [...(effortLevelsForProvider(p, model) || [])],
        ])),
        // Resolved HERE rather than client-side: the client mirror of this
        // predicate reads `envVars.ANTHROPIC_BASE_URL` / `endpoint`, and this
        // payload deliberately ships neither (envVars can hold secrets). Without
        // the resolved flag a renamed `claude-ollama-tui` — the exact provider
        // class the tool-use warning exists for — looked like a cloud agent to
        // every editor and was silently skipped.
        ollamaBacked: isOllamaBackedProvider(p),
      };
    }),
    activeProvider: providersData.activeProvider || null,
    assignments: entries,
  };
}

export async function updateAiAssignment(id, payload = {}) {
  if (typeof id !== 'string') throw validationError('AI assignment ID must be a string');
  const handler = assignmentHandlers.find(({ id: exactId, prefix }) =>
    exactId === id || (prefix && id.startsWith(prefix)));
  if (!handler) throw validationError(`Unknown AI assignment: ${id}`);

  const { providerId, model, effort } = payload;
  // Older clients only send provider/model. Preserve saved effort when omitted.
  const effortPatch = Object.hasOwn(payload, 'effort') ? { effort: asNullable(effort) } : {};
  await handler.update({
    providerId: asNullable(providerId),
    model: asNullable(model),
    effortPatch,
  }, handler.prefix ? id.slice(handler.prefix.length) : id, id);
  return getAiAssignments();
}
