import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for aiAssignments.js — the cross-feature provider/model inventory.
 *
 * The service is a read-everywhere/write-everywhere dispatcher: getAiAssignments
 * assembles entries from ~11 feature services, and updateAiAssignment routes an
 * `id` to the matching writer. These tests pin the dispatch table, the not-found
 * guards (which must surface 4xx ServerErrors, not silent no-ops or 500s), and
 * that each write targets the correct service with the correct shape.
 */

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getAllProviders: vi.fn(),
  getProviderById: vi.fn(),
  setActiveProvider: vi.fn(),
  updateProvider: vi.fn(),
  loadMeta: vi.fn(),
  updateMeta: vi.fn(),
  listUniverses: vi.fn(),
  updateUniverse: vi.fn(),
  listStorySessions: vi.fn(),
  updateStorySession: vi.fn(),
  listSeries: vi.fn(),
  updateSeries: vi.fn(),
  getScheduleStatus: vi.fn(),
  getTaskInterval: vi.fn(),
  updateTaskInterval: vi.fn(),
  getLoops: vi.fn(),
  updateLoop: vi.fn(),
  getAllFeatureAgents: vi.fn(),
  updateFeatureAgent: vi.fn(),
  getAllAgents: vi.fn(),
  getAgentById: vi.fn(),
  updateAgent: vi.fn(),
  getVoiceConfig: vi.fn(),
  updateVoiceConfig: vi.fn(),
}));

vi.mock('./settings.js', () => ({ getSettings: mocks.getSettings, updateSettings: mocks.updateSettings }));
vi.mock('./providers.js', () => ({
  getAllProviders: mocks.getAllProviders,
  getProviderById: mocks.getProviderById,
  setActiveProvider: mocks.setActiveProvider,
  updateProvider: mocks.updateProvider,
}));
vi.mock('./brain.js', () => ({ loadMeta: mocks.loadMeta, updateMeta: mocks.updateMeta }));
vi.mock('./universeBuilder.js', () => ({ listUniverses: mocks.listUniverses, updateUniverse: mocks.updateUniverse }));
vi.mock('./storyBuilder.js', () => ({ listStorySessions: mocks.listStorySessions, updateStorySession: mocks.updateStorySession }));
vi.mock('./pipeline/series.js', () => ({ listSeries: mocks.listSeries, updateSeries: mocks.updateSeries }));
vi.mock('./taskSchedule.js', () => ({
  getScheduleStatus: mocks.getScheduleStatus,
  getTaskInterval: mocks.getTaskInterval,
  updateTaskInterval: mocks.updateTaskInterval,
}));
vi.mock('./loops.js', () => ({ getLoops: mocks.getLoops, updateLoop: mocks.updateLoop }));
vi.mock('./featureAgents.js', () => ({ getAllFeatureAgents: mocks.getAllFeatureAgents, updateFeatureAgent: mocks.updateFeatureAgent }));
vi.mock('./agentPersonalities.js', () => ({
  getAllAgents: mocks.getAllAgents,
  getAgentById: mocks.getAgentById,
  updateAgent: mocks.updateAgent,
}));
vi.mock('./voice/config.js', () => ({ getVoiceConfig: mocks.getVoiceConfig, updateVoiceConfig: mocks.updateVoiceConfig }));

const { getAiAssignments, updateAiAssignment } = await import('./aiAssignments.js');

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults that let getAiAssignments() (called after every write) resolve.
  mocks.getAllProviders.mockResolvedValue({
    activeProvider: 'openai',
    providers: [
      { id: 'openai', name: 'OpenAI', type: 'api', enabled: true, defaultModel: 'gpt-4', models: ['gpt-4', 'gpt-4o'], fallbackProvider: null },
      { id: 'claude', name: 'Claude', type: 'cli', enabled: true, defaultModel: 'opus', models: ['opus'], fallbackProvider: 'openai' },
    ],
  });
  mocks.getSettings.mockResolvedValue({
    embeddings: { provider: 'ollama', model: 'nomic' },
    autofixer: { providerId: 'claude', model: 'opus' },
    messages: {},
    codeReview: {},
  });
  mocks.getVoiceConfig.mockResolvedValue({ llm: { provider: 'openai', model: 'gpt-4', visionModel: 'gpt-4o', codeAgent: { provider: 'claude', model: 'opus' } } });
  mocks.loadMeta.mockResolvedValue({ defaultProvider: 'openai', defaultModel: 'gpt-4' });
  mocks.listUniverses.mockResolvedValue([]);
  mocks.listStorySessions.mockResolvedValue([]);
  mocks.listSeries.mockResolvedValue([]);
  mocks.getScheduleStatus.mockResolvedValue({ tasks: { 'morning-brief': { providerId: 'claude', model: 'opus' } } });
  mocks.getLoops.mockResolvedValue([]);
  mocks.getAllFeatureAgents.mockResolvedValue([]);
  mocks.getAllAgents.mockResolvedValue([]);
});

describe('getAiAssignments', () => {
  it('returns a curated providers list (no secrets) plus assembled assignments', async () => {
    const result = await getAiAssignments();
    expect(result.activeProvider).toBe('openai');
    expect(result.providers).toEqual([
      { id: 'openai', name: 'OpenAI', type: 'api', enabled: true, defaultModel: 'gpt-4', models: ['gpt-4', 'gpt-4o'] },
      { id: 'claude', name: 'Claude', type: 'cli', enabled: true, defaultModel: 'opus', models: ['opus'] },
    ]);
    // The provider mock has no apiKey, but assert the curated shape has no extra keys regardless.
    for (const p of result.providers) {
      expect(Object.keys(p).sort()).toEqual(['defaultModel', 'enabled', 'id', 'models', 'name', 'type']);
    }
    const ids = result.assignments.map((a) => a.id);
    expect(ids).toContain('provider.active');
    expect(ids).toContain('settings.embeddings');
    expect(ids).toContain('settings.voice.vision');
    expect(ids).toContain('settings.creativeDirector.treatment');
    expect(ids).toContain('settings.creativeDirector.plan');
    expect(ids).toContain('settings.creativeDirector.evaluation');
    expect(ids).toContain('cos.task.morning-brief');
  });
});

describe('updateAiAssignment routing', () => {
  it('provider.active sets the active provider', async () => {
    await updateAiAssignment('provider.active', { providerId: 'claude' });
    expect(mocks.setActiveProvider).toHaveBeenCalledWith('claude');
  });

  it('settings.voice.vision writes only visionModel under llm (deep-merge contract)', async () => {
    await updateAiAssignment('settings.voice.vision', { model: 'gpt-4o-mini' });
    expect(mocks.updateVoiceConfig).toHaveBeenCalledWith({ llm: { visionModel: 'gpt-4o-mini' } });
  });

  it('settings.autofixer writes the {providerId, model} shape the feature reads', async () => {
    await updateAiAssignment('settings.autofixer', { providerId: 'claude', model: 'opus' });
    expect(mocks.updateSettings).toHaveBeenCalledWith({ autofixer: { providerId: 'claude', model: 'opus' } });
  });

  it('settings.creativeDirector.evaluation writes the vision provider/model under creativeDirector', async () => {
    await updateAiAssignment('settings.creativeDirector.evaluation', { providerId: 'ollama', model: 'qwen2.5-vl' });
    expect(mocks.updateSettings).toHaveBeenCalledWith({ creativeDirector: { evaluation: { providerId: 'ollama', model: 'qwen2.5-vl' } } });
  });

  it.each(['treatment', 'plan'])('settings.creativeDirector.%s writes that agent stage provider/model', async (stage) => {
    await updateAiAssignment(`settings.creativeDirector.${stage}`, { providerId: 'claude', model: 'sonnet' });
    expect(mocks.updateSettings).toHaveBeenCalledWith({ creativeDirector: { [stage]: { providerId: 'claude', model: 'sonnet' } } });
  });

  it('cos.task.<existing> updates the schedule interval', async () => {
    await updateAiAssignment('cos.task.morning-brief', { providerId: 'claude', model: 'opus' });
    expect(mocks.updateTaskInterval).toHaveBeenCalledWith('morning-brief', { providerId: 'claude', model: 'opus' });
  });

  it('provider.model.<id>.<field> writes the field on the right provider, even when the id contains a dot', async () => {
    mocks.getProviderById.mockResolvedValue({ id: 'lm.studio', name: 'LM Studio', models: ['mistral'] });
    await updateAiAssignment('provider.model.lm.studio.heavyModel', { model: 'mistral' });
    expect(mocks.getProviderById).toHaveBeenCalledWith('lm.studio');
    expect(mocks.updateProvider).toHaveBeenCalledWith('lm.studio', { heavyModel: 'mistral' });
  });
});

describe('updateAiAssignment guards', () => {
  it('rejects an unknown id with a 400 ServerError', async () => {
    await expect(updateAiAssignment('totally.bogus.id', {})).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a blank system default provider with a 400', async () => {
    await expect(updateAiAssignment('provider.active', { providerId: '  ' })).rejects.toMatchObject({ status: 400 });
    expect(mocks.setActiveProvider).not.toHaveBeenCalled();
  });

  it('does NOT create a junk schedule record for an unknown cos.task id (404, no write)', async () => {
    await expect(updateAiAssignment('cos.task.does-not-exist', { providerId: 'x' })).rejects.toMatchObject({ status: 404 });
    expect(mocks.updateTaskInterval).not.toHaveBeenCalled();
  });

  it('surfaces a 404 when a feature agent no longer exists (instead of silent success)', async () => {
    mocks.updateFeatureAgent.mockResolvedValue(null);
    await expect(updateAiAssignment('featureAgent.gone', { providerId: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('surfaces a 404 when a provider model target is missing', async () => {
    mocks.getProviderById.mockResolvedValue(null);
    await expect(updateAiAssignment('provider.model.ghost.defaultModel', { model: 'x' })).rejects.toMatchObject({ status: 404 });
    expect(mocks.updateProvider).not.toHaveBeenCalled();
  });
});
