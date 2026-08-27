import { getSettings, updateSettings } from './settings.js';
import { getAllProviders, getProviderById, isOllamaBackedProvider, setActiveProvider, updateProvider } from './providers.js';
import * as brainService from './brain.js';
import * as universeService from './universeBuilder.js';
import * as storyBuilderService from './storyBuilder.js';
import * as pipelineSeriesService from './pipeline/series.js';
import * as taskScheduleService from './taskSchedule.js';
import * as loopsService from './loops.js';
import * as featureAgentsService from './featureAgents.js';
import * as agentPersonalitiesService from './agentPersonalities.js';
import * as autonomousJobsService from './autonomousJobs.js';
import { getVoiceConfig, updateVoiceConfig } from './voice/config.js';
import { isPlainObject } from '../lib/objects.js';
import { ServerError } from '../lib/errorHandler.js';
import { effortLevelsForProvider } from '../lib/providerModels.js';

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

const addSettingsEntries = async (entries) => {
  const settings = await getSettings();
  const voice = await getVoiceConfig().catch(() => settings.voice || {});
  const messages = settings.messages || {};

  entries.push(makeEntry({
    id: 'settings.embeddings',
    area: 'Memory & Catalog',
    label: 'Vector embeddings',
    source: 'settings.embeddings',
    providerId: settings.embeddings?.provider || 'none',
    model: settings.embeddings?.model || null,
    providerOptions: embeddingProviders,
    providerTypes: [],
    notes: 'Powers semantic search, including Chief of Staff memory retrieval.',
    link: '/models/embeddings',
  }));

  for (const [key, label] of [
    ['autofixer', 'Autofixer'],
    ['calendarSync', 'Calendar Sync'],
  ]) {
    entries.push(makeEntry({
      id: `settings.${key}`,
      area: 'Automation',
      assignmentType: 'Agents & automation',
      label,
      source: `settings.${key}`,
      providerId: settings[key]?.providerId || null,
      model: settings[key]?.model || null,
      ...agentEntry,
      notes: 'Requires a CLI/TUI provider because it runs agentic tool work.',
      link: key === 'autofixer' ? '/settings/autofixer' : '/settings/general',
    }));
  }

  entries.push(makeEntry({
    id: 'settings.creativeDirector.treatment',
    area: 'Creative Director',
    assignmentType: 'Creative workflows',
    label: 'Treatment generation model',
    source: 'settings.creativeDirector.treatment',
    providerId: settings.creativeDirector?.treatment?.providerId || null,
    model: settings.creativeDirector?.treatment?.model || null,
    ...agentEntry,
    notes: 'Agent model that turns a project brief into a treatment and scene plan. Blank = system default provider and model. Each Creative Director project can override this from its Models drawer.',
    link: '/creative-director',
  }));

  entries.push(makeEntry({
    id: 'settings.creativeDirector.plan',
    area: 'Creative Director',
    assignmentType: 'Creative workflows',
    label: 'Production planning model',
    source: 'settings.creativeDirector.plan',
    providerId: settings.creativeDirector?.plan?.providerId || null,
    model: settings.creativeDirector?.plan?.model || null,
    ...agentEntry,
    notes: 'Agent model that converts a production directive into an executable plan. Blank = system default provider and model. Each Creative Director project can override this from its Models drawer.',
    link: '/creative-director',
  }));

  entries.push(makeEntry({
    id: 'settings.creativeDirector.evaluation',
    area: 'Creative Director',
    assignmentType: 'Creative workflows',
    label: 'Scene evaluation vision model',
    source: 'settings.creativeDirector.evaluation',
    providerId: settings.creativeDirector?.evaluation?.providerId || null,
    model: settings.creativeDirector?.evaluation?.model || null,
    providerTypes: apiProviderTypes,
    // Scene evaluation is a vision call — restrict local Ollama/LM Studio
    // model pickers to VLMs so a text-only default can't be selected by mistake.
    modelFilter: 'vision',
    notes: 'Vision model that judges each rendered scene. Use a local Ollama or LM Studio VLM here. Blank = auto-pick an installed local vision model; if none is available it falls back to the coding agent. Each Creative Director project can override this from its Models drawer.',
    link: '/creative-director',
  }));

  entries.push(makeEntry({
    id: 'settings.voice.llm',
    area: 'Voice',
    assignmentType: 'Voice & messaging',
    label: 'Conversational LLM',
    source: 'settings.voice.llm',
    providerId: voice.llm?.provider || null,
    model: voice.llm?.model || null,
    providerTypes: apiProviderTypes,
    link: '/settings/voice',
  }));
  entries.push(makeEntry({
    id: 'settings.voice.vision',
    area: 'Voice',
    assignmentType: 'Voice & messaging',
    label: 'Screen vision model',
    source: 'settings.voice.llm.visionModel',
    providerId: voice.llm?.provider || null,
    model: voice.llm?.visionModel || null,
    providerEditable: false,
    providerTypes: apiProviderTypes,
    link: '/settings/voice',
  }));
  entries.push(makeEntry({
    id: 'settings.voice.codeAgent',
    area: 'Voice',
    assignmentType: 'Voice & messaging',
    label: 'Delegated coding agent',
    source: 'settings.voice.llm.codeAgent',
    providerId: voice.llm?.codeAgent?.provider || null,
    model: voice.llm?.codeAgent?.model || null,
    ...agentEntry,
    link: '/settings/voice',
  }));

  for (const action of ['triage', 'reply']) {
    const cfg = messages[action] || {};
    entries.push(makeEntry({
      id: `settings.messages.${action}`,
      area: 'Messages',
      assignmentType: 'Voice & messaging',
      label: `${action[0].toUpperCase()}${action.slice(1)} assistant`,
      source: `settings.messages.${action}`,
      providerId: cfg.providerId || messages.providerId || null,
      model: cfg.model || messages.model || null,
      link: '/messages/config',
    }));
  }

  for (const backend of ['lmstudio', 'ollama']) {
    entries.push(makeEntry({
      id: `settings.codeReview.${backend}`,
      area: 'Review Loop',
      label: `${backend === 'lmstudio' ? 'LM Studio' : 'Ollama'} reviewer model`,
      source: `settings.codeReview.${backend}Model`,
      providerId: backend,
      model: settings.codeReview?.[`${backend}Model`] || null,
      providerEditable: false,
      providerTypes: [],
      notes: 'Model used when the local reviewer is in the default review chain.',
      link: '/ai',
    }));
  }
};

const addRecordEntries = async (entries) => {
  const [
    brainMeta,
    universes,
    storySessions,
    series,
    schedule,
    loops,
    featureAgents,
    socialAgents,
    autonomousJobs,
  ] = await Promise.all([
    brainService.loadMeta().catch(() => null),
    universeService.listUniverses().catch(() => []),
    storyBuilderService.listStorySessions().catch(() => []),
    pipelineSeriesService.listSeries().catch(() => []),
    taskScheduleService.getScheduleStatus().catch(() => null),
    loopsService.getLoops().catch(() => []),
    featureAgentsService.getAllFeatureAgents().catch(() => []),
    agentPersonalitiesService.getAllAgents().catch(() => []),
    autonomousJobsService.getAllJobs().catch(() => []),
  ]);

  if (brainMeta) {
    entries.push(makeEntry({
      id: 'brain.default',
      area: 'Brain',
      label: 'Default classifier and digest model',
      source: 'brain/meta.json',
      providerId: brainMeta.defaultProvider || null,
      model: brainMeta.defaultModel || null,
      link: '/brain/config',
    }));
  }

  for (const universe of universes) {
    if (universe.llm?.provider || universe.llm?.model) {
      entries.push(makeEntry({
        id: `universe.${universe.id}`,
        area: 'Universe Builder',
        assignmentType: 'World & story building',
        label: universe.name,
        source: `universe ${universe.id}.llm`,
        providerId: universe.llm?.provider || null,
        model: universe.llm?.model || null,
        scope: 'record',
        link: `/universes/${universe.id}`,
      }));
    }
  }

  for (const session of storySessions) {
    if (session.llm?.provider || session.llm?.model) {
      entries.push(makeEntry({
        id: `story.${session.id}`,
        area: 'Story Builder',
        assignmentType: 'World & story building',
        label: session.title,
        source: `story session ${session.id}.llm`,
        providerId: session.llm?.provider || null,
        model: session.llm?.model || null,
        scope: 'record',
        link: `/story-builder/${session.id}`,
      }));
    }
  }

  for (const s of series) {
    if (s.llm?.provider || s.llm?.model) {
      entries.push(makeEntry({
        id: `pipeline.series.${s.id}`,
        area: 'Pipeline',
        assignmentType: 'World & story building',
        label: s.name,
        source: `pipeline series ${s.id}.llm`,
        providerId: s.llm?.provider || null,
        model: s.llm?.model || null,
        scope: 'record',
        link: `/pipeline/series/${s.id}`,
      }));
    }
  }

  for (const [taskType, task] of Object.entries(schedule?.tasks || {})) {
    if (task.providerId || task.model || task.effort) {
      entries.push(makeEntry({
        id: `cos.task.${taskType}`,
        area: 'Chief of Staff',
        assignmentType: 'Scheduled tasks',
        label: `Scheduled task: ${taskType}`,
        source: `cos task-schedule ${taskType}`,
        providerId: task.providerId || null,
        model: task.model || null,
        effort: task.effort || null,
        effortEditable: true,
        scope: 'record',
        ...agentEntry,
        link: '/cos/config',
      }));
    }
    for (const [index, stage] of (task.taskMetadata?.pipeline?.stages || []).entries()) {
      if (stage?.providerId || stage?.model || stage?.effort) {
        entries.push(makeEntry({
          id: `cos.taskStage.${taskType}.${index}`,
          area: 'Chief of Staff',
          assignmentType: 'Scheduled tasks',
          label: `${taskType} stage: ${stage.name || index + 1}`,
          source: `cos task ${taskType}.taskMetadata.pipeline.stages[${index}]`,
          providerId: stage.providerId || null,
          model: stage.model || null,
          effort: stage.effort || null,
          effortEditable: true,
          scope: 'record',
          ...agentEntry,
          link: '/cos/config',
        }));
      }
    }
  }

  for (const loop of loops) {
    if (loop.providerId) {
      entries.push(makeEntry({
        id: `loop.${loop.id}`,
        area: 'Loops',
        assignmentType: 'Agents & automation',
        label: loop.name || loop.id,
        source: `loop ${loop.id}.providerId`,
        providerId: loop.providerId || null,
        model: null,
        scope: 'record',
        modelEditable: false,
        ...agentEntry,
        link: '/loops',
      }));
    }
  }

  for (const agent of featureAgents) {
    if (agent.providerId || agent.model) {
      entries.push(makeEntry({
        id: `featureAgent.${agent.id}`,
        area: 'Feature Agents',
        assignmentType: 'Agents & automation',
        label: agent.name,
        source: `feature agent ${agent.id}`,
        providerId: agent.providerId || null,
        model: agent.model || null,
        scope: 'record',
        ...agentEntry,
        link: `/feature-agents/${agent.id}/config`,
      }));
    }
  }

  for (const agent of socialAgents) {
    const configs = [];
    if (agent.aiConfig?.providerId || agent.aiConfig?.model) configs.push(['default', agent.aiConfig]);
    for (const key of ['content', 'engagement']) {
      if (agent.aiConfig?.[key]?.providerId || agent.aiConfig?.[key]?.model) configs.push([key, agent.aiConfig[key]]);
    }
    for (const [key, cfg] of configs) {
      entries.push(makeEntry({
        id: `socialAgent.${agent.id}.${key}`,
        area: 'Social Agents',
        assignmentType: 'Agents & automation',
        label: `${agent.name} ${key}`,
        source: `agent personality ${agent.id}.aiConfig.${key}`,
        providerId: cfg.providerId || null,
        model: cfg.model || null,
        scope: 'record',
        link: `/agents/${agent.id}/overview`,
      }));
    }
  }

  for (const job of autonomousJobs) {
    // Legacy/custom jobs omitted `type`; execution treats those as agent jobs.
    if ((job.type || 'agent') !== 'agent' || (!job.providerId && !job.model && !job.effort)) continue;
    entries.push(makeEntry({
      id: `cos.job.${job.id}`,
      area: 'Chief of Staff',
      assignmentType: 'Scheduled tasks',
      label: `Scheduled job: ${job.name}`,
      source: `cos autonomous job ${job.id}`,
      providerId: job.providerId || null,
      model: job.model || null,
      effort: job.effort || null,
      effortEditable: true,
      scope: 'record',
      ...agentEntry,
      link: '/cos/jobs',
    }));
  }
};

export async function getAiAssignments() {
  const providersData = await getAllProviders();
  const entries = [];
  await addSettingsEntries(entries);
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
  const { providerId, model, effort } = payload;
  const nextProviderId = asNullable(providerId);
  const nextModel = asNullable(model);
  const nextEffort = asNullable(effort);
  // Older clients only send provider/model. Preserve a saved effort unless the
  // caller explicitly supplies the field (null is the intentional clear).
  const effortPatch = Object.hasOwn(payload, 'effort') ? { effort: nextEffort } : {};

  if (id === 'provider.active') {
    if (!nextProviderId) throw new ServerError('System default provider is required', { status: 400, code: 'VALIDATION_ERROR' });
    await setActiveProvider(nextProviderId);
    return getAiAssignments();
  }

  if (id.startsWith('provider.model.')) {
    // field is a fixed dotless suffix (defaultModel/lightModel/...); parse it
    // from the last dot so a provider id containing a '.' still targets the
    // right provider (mirrors the replace-based fallback handler below).
    const rest = id.slice('provider.model.'.length);
    const lastDot = rest.lastIndexOf('.');
    const providerIdPart = rest.slice(0, lastDot);
    const field = rest.slice(lastDot + 1);
    const provider = await getProviderById(providerIdPart);
    if (!provider) throw new ServerError(`Provider not found: ${providerIdPart}`, { status: 404, code: 'NOT_FOUND' });
    await updateProvider(providerIdPart, { [field]: nextModel });
    return getAiAssignments();
  }

  if (id.startsWith('provider.fallback.')) {
    const providerIdPart = id.replace('provider.fallback.', '');
    await updateProvider(providerIdPart, { fallbackProvider: nextProviderId });
    return getAiAssignments();
  }

  if (id === 'settings.embeddings') {
    await updateSettings({ embeddings: { provider: nextProviderId || 'none', model: nextModel } });
    return getAiAssignments();
  }

  if (id === 'settings.autofixer' || id === 'settings.calendarSync') {
    const key = id.split('.')[1];
    await updateSettings({ [key]: { providerId: nextProviderId, model: nextModel } });
    return getAiAssignments();
  }

  if (id.startsWith('settings.creativeDirector.')) {
    const stage = id.slice('settings.creativeDirector.'.length);
    if (!['treatment', 'plan', 'evaluation'].includes(stage)) {
      throw new ServerError(`Unknown Creative Director assignment: ${id}`, { status: 400, code: 'VALIDATION_ERROR' });
    }
    await patchSettingsPath(`creativeDirector.${stage}`, { providerId: nextProviderId, model: nextModel });
    return getAiAssignments();
  }

  if (id === 'settings.voice.llm') {
    await updateVoiceConfig({ llm: { provider: nextProviderId || '', model: nextModel || '' } });
    return getAiAssignments();
  }

  if (id === 'settings.voice.vision') {
    await updateVoiceConfig({ llm: { visionModel: nextModel || '' } });
    return getAiAssignments();
  }

  if (id === 'settings.voice.codeAgent') {
    await updateVoiceConfig({ llm: { codeAgent: { provider: nextProviderId || '', model: nextModel || '' } } });
    return getAiAssignments();
  }

  if (id === 'settings.messages.triage' || id === 'settings.messages.reply') {
    const action = id.split('.')[2];
    const settings = await getSettings();
    const messages = isPlainObject(settings.messages) ? { ...settings.messages } : {};
    messages[action] = { ...(isPlainObject(messages[action]) ? messages[action] : {}), providerId: nextProviderId, model: nextModel };
    await updateSettings({ messages });
    return getAiAssignments();
  }

  if (id.startsWith('settings.codeReview.')) {
    const backend = id.split('.')[2];
    await patchSettingsPath(`codeReview.${backend}Model`, nextModel);
    return getAiAssignments();
  }

  if (id === 'brain.default') {
    await brainService.updateMeta({ defaultProvider: nextProviderId, defaultModel: nextModel });
    return getAiAssignments();
  }

  if (id.startsWith('universe.')) {
    await universeService.updateUniverse(id.replace('universe.', ''), { llm: { provider: nextProviderId, model: nextModel } });
    return getAiAssignments();
  }

  if (id.startsWith('story.')) {
    await storyBuilderService.updateStorySession(id.replace('story.', ''), { llm: { provider: nextProviderId, model: nextModel } });
    return getAiAssignments();
  }

  if (id.startsWith('pipeline.series.')) {
    await pipelineSeriesService.updateSeries(id.replace('pipeline.series.', ''), { llm: { provider: nextProviderId, model: nextModel } });
    return getAiAssignments();
  }

  if (id.startsWith('cos.taskStage.')) {
    const [, , taskType, indexRaw] = id.split('.');
    const index = Number(indexRaw);
    const task = await taskScheduleService.getTaskInterval(taskType);
    const stages = [...(task.taskMetadata?.pipeline?.stages || [])];
    if (!stages[index]) throw new ServerError(`Stage not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
    stages[index] = { ...stages[index], providerId: nextProviderId, model: nextModel, ...effortPatch };
    await taskScheduleService.updateTaskInterval(taskType, {
      taskMetadata: { ...(task.taskMetadata || {}), pipeline: { ...(task.taskMetadata?.pipeline || {}), stages } },
    });
    return getAiAssignments();
  }

  if (id.startsWith('cos.task.')) {
    const taskType = id.replace('cos.task.', '');
    // updateTaskInterval is create-if-missing, so an unknown taskType would
    // write a junk schedule record — gate on the existing task set first.
    const status = await taskScheduleService.getScheduleStatus();
    if (!status?.tasks?.[taskType]) throw new ServerError(`Scheduled task not found: ${taskType}`, { status: 404, code: 'NOT_FOUND' });
    await taskScheduleService.updateTaskInterval(taskType, { providerId: nextProviderId, model: nextModel, ...effortPatch });
    return getAiAssignments();
  }

  if (id.startsWith('cos.job.')) {
    const jobId = id.replace('cos.job.', '');
    const updated = await autonomousJobsService.updateJob(jobId, {
      providerId: nextProviderId,
      model: nextModel,
      ...effortPatch,
    });
    if (!updated) throw new ServerError(`Scheduled job not found: ${jobId}`, { status: 404, code: 'NOT_FOUND' });
    return getAiAssignments();
  }

  if (id.startsWith('loop.')) {
    await loopsService.updateLoop(id.replace('loop.', ''), { providerId: nextProviderId });
    return getAiAssignments();
  }

  if (id.startsWith('featureAgent.')) {
    const agentId = id.replace('featureAgent.', '');
    // updateFeatureAgent returns null (not throw) for an unknown id; surface it
    // so a stale edit doesn't report success while nothing changed.
    const updated = await featureAgentsService.updateFeatureAgent(agentId, { providerId: nextProviderId, model: nextModel });
    if (!updated) throw new ServerError(`Feature agent not found: ${agentId}`, { status: 404, code: 'NOT_FOUND' });
    return getAiAssignments();
  }

  if (id.startsWith('socialAgent.')) {
    const [, agentId, key] = id.split('.');
    const agent = await agentPersonalitiesService.getAgentById(agentId);
    if (!agent) throw new ServerError(`Agent not found: ${agentId}`, { status: 404, code: 'NOT_FOUND' });
    const aiConfig = isPlainObject(agent.aiConfig) ? { ...agent.aiConfig } : {};
    if (key === 'default') {
      aiConfig.providerId = nextProviderId || undefined;
      aiConfig.model = nextModel || undefined;
    } else {
      aiConfig[key] = { ...(isPlainObject(aiConfig[key]) ? aiConfig[key] : {}), providerId: nextProviderId || undefined, model: nextModel || undefined };
    }
    await agentPersonalitiesService.updateAgent(agentId, { aiConfig });
    return getAiAssignments();
  }

  throw new ServerError(`Unknown AI assignment: ${id}`, { status: 400, code: 'VALIDATION_ERROR' });
}
