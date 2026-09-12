import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const mock = vi.hoisted(() => ({ capabilities: {}, agentContext: {}, recipes: [], dispatch: vi.fn(), runPrompt: vi.fn(), mutations: [] }));
vi.mock('./cosState.js', () => ({ loadState: async () => ({ config: { persistentMindCapabilities: mock.capabilities } }) }));
vi.mock('./settings.js', () => ({ getSettings: async () => ({ agentContext: mock.agentContext }) }));
vi.mock('./voice/tools.js', () => ({
  getToolSpecs: () => [{ function: { name: 'brain_search', description: 'Search records.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }],
  getToolSpecsForIntent: () => ({ specs: [] }),
  dispatchTool: (...args) => mock.dispatch(...args),
}));
vi.mock('./persistentMindMaintenance.js', () => ({ cleanupPersistentMind: vi.fn() }));
vi.mock('./persistentMindTaskCapability.js', () => ({
  executePersistentMindTaskRequests: vi.fn(async () => []), buildPersistentMindTaskCapabilityPrompt: () => '',
  readPersistentMindTaskCatalog: vi.fn(), readPersistentMindTaskInventory: vi.fn(),
}));
vi.mock('./persistentMindContext.js', () => ({
  createPersistentMindMemoryFromCandidate: vi.fn(), readPersistentMindMemories: vi.fn(async () => []), readPersistentMindName: vi.fn(async () => null),
}));
vi.mock('./persistentMindVisibility.js', () => ({ readPersistentMindVisibility: vi.fn(async () => ({})), buildPersistentMindVisibilityPrompt: () => '' }));
vi.mock('./persistentMindUserActions.js', () => ({ readPersistentMindUserActionsPrompt: vi.fn(async () => '') }));
vi.mock('./persistentMindCallCapability.js', () => ({ buildPersistentMindCallCapabilityPrompt: () => '', executePersistentMindCallRequest: vi.fn(async () => null) }));
vi.mock('./promptRunner.js', () => ({ runPromptThroughProvider: (...args) => mock.runPrompt(...args), assertVisionRunUsedImages: (_, provider) => provider }));
vi.mock('./runner.js', () => ({ stopRun: vi.fn() }));
vi.mock('./mindToolRecipes.js', async () => {
  const { validateMindToolRecipe } = await import('../lib/mindToolRecipes.js');
  const validate = async (candidate) => validateMindToolRecipe(candidate, (await import('./cosToolRegistry.js')).getCosToolCatalog().tools).definition;
  return {
    listRecipes: async () => ({ recipes: structuredClone(mock.recipes) }),
    getRecipeByName: async (name) => structuredClone(mock.recipes.find((recipe) => recipe.name === name)),
    getRecipe: async (id, options) => ({ recipe: mock.recipes.find((recipe) => recipe.id === id), versions: mock.mutations.slice(options.offset, options.offset + options.limit) }),
    createRecipe: async (candidate, options) => {
      const definition = await validate(candidate);
      const recipe = { id: randomUUID(), name: definition.name, definition, activeRevision: 1, archived: false };
      mock.recipes.push(recipe); mock.mutations.push({ ...structuredClone(recipe), author: options.author }); return recipe;
    },
    updateRecipe: async (id, args) => {
      const definition = await validate(args.definition);
      const recipe = mock.recipes.find((row) => row.id === id);
      Object.assign(recipe, { definition, activeRevision: recipe.activeRevision + 1 }); return recipe;
    },
    restoreRecipe: async (id) => {
      const recipe = mock.recipes.find((row) => row.id === id);
      Object.assign(recipe, { definition: structuredClone(mock.mutations[0].definition), activeRevision: recipe.activeRevision + 1 }); return recipe;
    },
  };
});
import { executeCosToolCall, readCosToolRecipeCatalog, readPersistentMindRecipeCatalog, getCosToolCatalog, __testing } from './cosToolRegistry.js';
import { createPersistentMindTurnAdapter } from './persistentMindAdapter.js';
const definition = (steps = 2) => ({
  schemaVersion: 1, name: 'recipe.project-check', purpose: 'Read a project check-in',
  parameters: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'], additionalProperties: false },
  steps: Array.from({ length: steps }, (_, index) => ({ id: `read${index}`, tool: 'brain.search', arguments: { query: { input: 'project' } } })),
  outputs: { summary: { step: `read${steps - 1}`, path: ['summary'] } },
});
const authority = () => ({ scope: 'mind', capabilities: mock.capabilities });
const call = (name, args = {}, context = {}, requestId = randomUUID()) => executeCosToolCall({ call: { name, arguments: args, requestId }, authority: authority(), context });
const save = () => call('mind.recipes.create', { definition: definition() });
beforeEach(() => {
  vi.clearAllMocks(); mock.capabilities = { manageToolRecipes: true, readPortos: true };
  mock.agentContext = { enabled: true, scopes: ['navigation'], actions: { callToolRecipes: true, readPortos: true } };
  mock.recipes = []; mock.mutations = [];
  __testing.toolCalls.clear(); __testing.toolCallFingerprints.clear(); mock.dispatch.mockResolvedValue({ summary: 'Synthetic private result' });
});
it('creates, discovers and runs a two-read recipe on the next continuation, then reuses it on a later wake', async () => {
  mock.runPrompt.mockResolvedValueOnce({ text: JSON.stringify({ toolCalls: [{ name: 'mind.recipes.create', arguments: { definition: definition() } }] }) })
    .mockResolvedValueOnce({ text: JSON.stringify({ toolCalls: [{ name: 'recipe.project-check', arguments: { project: 'Example' } }] }) })
    .mockResolvedValue({ text: JSON.stringify({ message: 'Check complete.' }) });
  const events = [];
  const adapter = createPersistentMindTurnAdapter();
  const options = { provider: { id: 'fixture', type: 'api' }, model: 'fixture-model', turnId: 'wake1', wake: { kind: 'self' }, context: { text: '' }, recordCapabilityEvent: (event) => events.push(event) };
  await adapter.run(options);
  expect(mock.dispatch).toHaveBeenCalledTimes(2);
  expect(mock.runPrompt.mock.calls[1][0].prompt).toContain('"name":"recipe.project-check"');
  expect(mock.runPrompt.mock.calls[2][0].prompt).toContain('Synthetic private result');
  expect(mock.runPrompt.mock.calls.every(([args]) => args.model === 'fixture-model')).toBe(true);
  expect(JSON.stringify(events)).not.toContain('Synthetic private result');
  expect(events.filter((event) => event.id.startsWith('recipe-step:'))).toHaveLength(2);
  expect(mock.mutations[0].author).toBe('mind');
  mock.runPrompt.mockResolvedValueOnce({ text: JSON.stringify({ toolCalls: [{ name: 'recipe.project-check', arguments: { project: 'Example' } }] }) });
  await adapter.run({ ...options, turnId: 'wake2' });
  expect(mock.dispatch).toHaveBeenCalledTimes(4);
});
it('cannot multiply the adapter turn budget through a five-step wrapper or later calls', async () => {
  await call('mind.recipes.create', { definition: definition(5) });
  mock.runPrompt.mockResolvedValueOnce({ text: JSON.stringify({ toolCalls: [
    { name: 'recipe.project-check', arguments: { project: 'Example' } },
    { name: 'brain.search', arguments: { query: 'Must not execute' } },
  ] }) }).mockResolvedValue({ text: JSON.stringify({ message: 'Partial check.' }) });
  await createPersistentMindTurnAdapter().run({ provider: { id: 'fixture', type: 'api' }, model: 'fixture-model', turnId: 'budget-wake', wake: { kind: 'self' }, context: { text: '' } });
  expect(mock.dispatch).toHaveBeenCalledTimes(4);
  expect(mock.dispatch.mock.calls.every(([, args]) => args.query === 'Example')).toBe(true);
  expect(mock.runPrompt).toHaveBeenCalledTimes(2);
  expect(mock.runPrompt.mock.calls[1][0].prompt).toContain('budget is exhausted');
  expect(mock.runPrompt.mock.calls[1][0].prompt).toContain('"state":"partial"');
});
it('exposes only agent-eligible recipes and enforces a fresh grant with a local five-child budget', async () => {
  await call('mind.recipes.create', { definition: definition(5) });
  const recipes = await readCosToolRecipeCatalog({ scope: 'agent' });
  const agentCatalog = getCosToolCatalog({ scope: 'agent', capabilities: mock.agentContext.actions, recipes });
  const advertised = agentCatalog.tools.find((tool) => tool.name === 'recipe.project-check');
  expect(advertised).toMatchObject({
    granted: true,
    recipe: { source: 'persistent-mind-library', revision: 1, underlyingTools: ['brain.search'] },
  });
  expect(JSON.stringify(advertised)).not.toContain('arguments');
  const result = await executeCosToolCall({
    call: { name: 'recipe.project-check', arguments: { project: 'Example' }, requestId: randomUUID() },
    authority: { scope: 'agent', capabilities: mock.agentContext.actions },
  });
  expect(result).toMatchObject({ state: 'completed', result: { revision: 1, outcomes: expect.any(Array) } });
  expect(result.result.outcomes).toHaveLength(5);
  expect(mock.dispatch).toHaveBeenCalledTimes(5);

  mock.agentContext.actions.callToolRecipes = false;
  await expect(executeCosToolCall({
    call: { name: 'recipe.project-check', arguments: { project: 'Example' }, requestId: randomUUID() },
    authority: { scope: 'agent', capabilities: { callToolRecipes: true, readPortos: true } },
  })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
});
it('marks a recipe using a Mind-only primitive unavailable to agents', async () => {
  mock.capabilities.chooseThinkingPreset = true;
  const mindOnly = definition(1);
  mindOnly.steps[0].tool = 'mind.thinking-presets';
  mindOnly.steps[0].arguments = {};
  mindOnly.outputs = { presets: { step: 'read0', path: [] } };
  await call('mind.recipes.create', { definition: mindOnly });
  const recipes = await readCosToolRecipeCatalog({ scope: 'agent' });
  const catalog = getCosToolCatalog({ scope: 'agent', capabilities: mock.agentContext.actions, recipes });
  expect(catalog.tools.find((tool) => tool.name === mindOnly.name)).toMatchObject({
    granted: false,
    recipe: { available: false, disabledReason: expect.stringMatching(/agent scope/) },
  });
});
it('re-reads agent authority before every child and stops a recipe after revocation', async () => {
  await save();
  mock.dispatch.mockImplementationOnce(async () => {
    mock.agentContext.actions.callToolRecipes = false;
    return { summary: 'Private' };
  });
  const result = await executeCosToolCall({
    call: { name: 'recipe.project-check', arguments: { project: 'Example' }, requestId: randomUUID() },
    authority: { scope: 'agent', capabilities: { callToolRecipes: true, readPortos: true } },
  });
  expect(result).toMatchObject({ state: 'failed', result: { state: 'partial', failingStep: 'read1' } });
  expect(mock.dispatch).toHaveBeenCalledTimes(1);
});
it('intersects fresh Agent Tools grants with the original caller authority', async () => {
  await save();
  await expect(executeCosToolCall({
    call: { name: 'recipe.project-check', arguments: { project: 'Example' }, requestId: randomUUID() },
    authority: { scope: 'agent', capabilities: { callToolRecipes: true, readPortos: false } },
  })).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
  expect(mock.dispatch).not.toHaveBeenCalled();
});
it('stops after revocation, removes discovery, and keeps already completed reads marked partial', async () => {
  await save();
  mock.dispatch.mockImplementationOnce(async () => { mock.capabilities.readPortos = false; return { summary: 'Private' }; });
  const result = await call('recipe.project-check', { project: 'Example' }, { toolBudget: { used: 1 } });
  expect(result).toMatchObject({ state: 'failed', result: { state: 'partial', revision: 1, failingStep: 'read1' } });
  expect(mock.dispatch).toHaveBeenCalledTimes(1);
  expect(await readPersistentMindRecipeCatalog(mock.capabilities)).toEqual([]);
});
it('charges children to the shared turn budget and reports cancellation and missing fields', async () => {
  await call('mind.recipes.create', { definition: definition(5) });
  const budget = { used: 1 };
  expect(await call('recipe.project-check', { project: 'Example' }, { toolBudget: budget })).toMatchObject({ result: { state: 'partial', failingStep: 'read4' } });
  expect(budget.used).toBe(5); expect(mock.dispatch).toHaveBeenCalledTimes(4);
  const controller = new AbortController(); controller.abort();
  expect(await call('recipe.project-check', { project: 'Example' }, { signal: controller.signal, toolBudget: { used: 1 } })).toMatchObject({ result: { state: 'aborted' } });
  mock.recipes[0].definition = definition(); mock.dispatch.mockResolvedValue({});
  expect(await call('recipe.project-check', { project: 'Example' }, { toolBudget: { used: 1 } })).toMatchObject({ result: { state: 'partial', failingStep: 'outputs', error: expect.stringContaining('missing') } });
});
it('retains the valid definition on invalid edits and binds invocation replay to the pinned revision', async () => {
  const saved = await save(); const id = saved.result.id;
  const invalid = definition(); invalid.steps[0].tool = 'brain.capture';
  expect(await call('mind.recipes.update', { id, definition: invalid, expectedRevision: 1 })).toMatchObject({ state: 'failed' });
  const context = { toolBudget: { used: 1 } }; const invocation = randomUUID();
  expect(await call('recipe.project-check', { project: 'Example' }, context, invocation)).toMatchObject({ state: 'completed', result: { revision: 1 } });
  expect(await call('recipe.project-check', { project: 'Example' }, context, invocation)).toMatchObject({ duplicate: true });
  expect(await call('mind.recipes.restore', { id, revision: 1, expectedRevision: 1 })).toMatchObject({ result: { activeRevision: 2 } });
  await expect(call('recipe.project-check', { project: 'Example' }, context, invocation)).rejects.toMatchObject({ code: 'TOOL_IDEMPOTENCY_CONFLICT' });
  expect(mock.dispatch).toHaveBeenCalledTimes(2);
});
it('denies management without an explicit live grant or outside mind scope and pages history', async () => {
  const saved = await save();
  expect(await call('mind.recipes.read', { id: saved.result.id, limit: 1, offset: 1 })).toMatchObject({ result: { versions: [] } });
  for (const scope of ['ui', 'agent', 'voice']) await expect(executeCosToolCall({ call: { name: 'mind.recipes.list', requestId: randomUUID() }, authority: { scope, authenticated: true, capabilities: mock.capabilities } })).rejects.toMatchObject({ code: 'TOOL_SCOPE_DENIED' });
  mock.capabilities.manageToolRecipes = false;
  await expect(call('mind.recipes.list')).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
  expect(getCosToolCatalog({ scope: 'mind', capabilities: mock.capabilities }).tools.filter((tool) => tool.name.startsWith('mind.recipes.')).every((tool) => !tool.granted)).toBe(true);
});

it('returns structured incompatible-definition failures and requires a new invocation after repair', async () => {
  await save();
  mock.recipes[0].definition.steps[0].tool = 'retired.search';
  const invocation = randomUUID();
  const failed = await call('recipe.project-check', { project: 'Example' }, { toolBudget: { used: 1 } }, invocation);
  expect(failed).toMatchObject({ state: 'failed', result: { recipeId: mock.recipes[0].id, revision: 1, failingStep: 'read0', guidance: expect.stringContaining('repair') } });
  expect(await readPersistentMindRecipeCatalog(mock.capabilities)).toEqual([]);
  mock.recipes[0].definition = definition(); mock.recipes[0].activeRevision += 1;
  await expect(call('recipe.project-check', { project: 'Example' }, { toolBudget: { used: 1 } }, invocation)).rejects.toMatchObject({ code: 'TOOL_IDEMPOTENCY_CONFLICT' });
  expect(mock.dispatch).not.toHaveBeenCalled();
});
