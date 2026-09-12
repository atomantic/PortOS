/** Mind-only recipe catalog and bounded orchestration over semantic reads. */
import { z } from 'zod';
import { COS_TOOL_SCHEMA_VERSION, COS_TOOL_CALL_LIMITS, providerToolName } from '../lib/cosToolContracts.js';
import { validateMindToolRecipe, resolveMindToolRecipeBinding } from '../lib/mindToolRecipes.js';
import { zodToOpenApiSchema } from '../lib/apiContractSchemas.js';
import {
  agentContextSettingsSchema,
  createDefaultAgentContextActionGrants,
  normalizeAgentContextActionGrants,
} from '../lib/agentContextValidation.js';
import { ServerError } from '../lib/errorHandler.js';
import { sha256Text } from '../lib/fileUtils.js';

const page = { limit: z.number().int().min(1).max(20).optional().default(10), offset: z.number().int().min(0).max(100000).optional().default(0) };
const id = z.string().uuid();
const revision = z.number().int().positive();
const managementSchemas = {
  create: z.object({ definition: z.json() }).strict(),
  list: z.object(page).strict(),
  read: z.object({ id, ...page }).strict(),
  update: z.object({ id, definition: z.json(), expectedRevision: revision }).strict(),
  archive: z.object({ id, expectedRevision: revision }).strict(),
  restore: z.object({ id, revision, expectedRevision: revision }).strict(),
};
const descriptor = (name, description, input_schema, adapter, requiredCapabilities, sideEffect = 'read', {
  scopes = ['mind'],
  recipe,
} = {}) => ({
  type: 'portos_tool', name, version: COS_TOOL_SCHEMA_VERSION, providerName: providerToolName(name), aliases: [],
  description, input_schema, output_schema: { type: 'object', additionalProperties: true },
  policy: { scopes, requiredCapabilities, sideEffect, idempotent: true, async: false, confirmation: 'capability-grant' },
  adapter,
  ...(recipe ? { recipe } : {}),
});
export const recipeManagementTools = Object.entries(managementSchemas).map(([operation, schema]) => descriptor(
  `mind.recipes.${operation}`, `${operation} saved read-tool recipe definitions. Read/list return paged definitions/history only. Create/update require schemaVersion:1, recipe.* name, purpose, closed parameters, 1-5 steps with {id,tool,arguments}, and outputs. Bindings are {literal:value}, {input:parameter}, or {step:id,path:[field]}.`,
  zodToOpenApiSchema(schema), { kind: 'recipe-management', operation }, ['manageToolRecipes'], ['list', 'read'].includes(operation) ? 'read' : 'write',
));

const recipeAccessCapability = (scope) => scope === 'agent' ? 'callToolRecipes' : 'manageToolRecipes';
const recipeMetadata = (recipe, definition, { scope, available = true, disabledReason } = {}) => ({
  id: recipe.id,
  source: 'persistent-mind-library',
  revision: recipe.activeRevision,
  scope,
  available,
  underlyingTools: [...new Set((definition?.steps || []).map((step) => step.tool))],
  ...(disabledReason ? { disabledReason: String(disabledReason).slice(0, 500) } : {}),
});

export const recipeTool = (recipe, primitives, { scope = 'mind' } = {}) => {
  if (recipe.archived) throw new ServerError('Recipe is archived. Restore a revision before calling it.', { code: 'RECIPE_ARCHIVED', status: 409 });
  const { definition } = validateMindToolRecipe(recipe.definition, primitives, { scope });
  const required = [...new Set([recipeAccessCapability(scope), ...definition.steps.flatMap((step) => primitives.find((tool) => tool.name === step.tool).policy.requiredCapabilities)])];
  return descriptor(definition.name, definition.purpose.slice(0, 280), definition.parameters,
    { kind: 'recipe', recipe: { id: recipe.id, activeRevision: recipe.activeRevision, definition }, scope }, required, 'read', {
      scopes: [scope], recipe: recipeMetadata(recipe, definition, { scope }),
    });
};

// Even an incompatible revision gets a replay fingerprint and structured failure.
// A repair must never silently reinterpret the same invocation requestId.
export const resolveRecipeInvocation = (recipe, primitives, { scope = 'mind' } = {}) => Promise.resolve()
  .then(() => recipeTool(recipe, primitives, { scope }))
  .catch((error) => descriptor(recipe.name, 'Unavailable saved recipe', { type: 'object', additionalProperties: true },
    { kind: 'recipe', recipe, scope, validationError: { message: error.message, step: error.context?.step || 'definition' } }, [recipeAccessCapability(scope)], 'read', {
      scopes: [scope], recipe: recipeMetadata(recipe, recipe.definition, { scope, available: false, disabledReason: error.message }),
    }));

export const resolveMindRecipeInvocation = (recipe, primitives) => resolveRecipeInvocation(recipe, primitives, { scope: 'mind' });

export async function readRecipeToolsForScope(scope, primitives) {
  if (!['agent', 'mind'].includes(scope)) return [];
  const { listRecipes } = await import('./mindToolRecipes.js');
  const { recipes } = await listRecipes({ limit: 20 });
  const checked = await Promise.all(recipes.map((recipe) => resolveRecipeInvocation(recipe, primitives, { scope })));
  let chars = 0;
  return checked.flatMap((tool) => {
    const size = JSON.stringify(tool.input_schema).length + tool.description.length;
    if (chars + size > 24000) return [];
    chars += size;
    return [tool];
  });
}

export async function readMindRecipeTools(capabilities, primitives) {
  if (capabilities?.manageToolRecipes !== true) return [];
  const tools = await readRecipeToolsForScope('mind', primitives);
  return tools.filter((tool) => tool.recipe?.available === true
    && tool.policy.requiredCapabilities.every((key) => capabilities[key] === true));
}

export async function currentMindAuthority(authority) {
  const { loadState } = await import('./cosState.js');
  const root = await loadState();
  return { ...authority, capabilities: root.config?.persistentMindCapabilities || {} };
}

export async function currentAgentAuthority(authority) {
  const { getSettings } = await import('./settings.js');
  const settings = await getSettings();
  const parsed = agentContextSettingsSchema.safeParse(settings.agentContext ?? {});
  const storedCapabilities = parsed.success && parsed.data.enabled === true
    ? normalizeAgentContextActionGrants(parsed.data.actions)
    : createDefaultAgentContextActionGrants();
  const requestedCapabilities = normalizeAgentContextActionGrants(authority?.capabilities);
  const capabilities = Object.fromEntries(Object.keys(storedCapabilities)
    .map((key) => [key, storedCapabilities[key] === true && requestedCapabilities[key] === true]));
  return { ...authority, scope: 'agent', capabilities };
}

export async function executeRecipeManagement(tool, args, context) {
  const recipes = await import('./mindToolRecipes.js');
  const { operation } = tool.adapter;
  const parsed = managementSchemas[operation].parse(args);
  if (operation === 'list') return recipes.listRecipes(parsed);
  if (operation === 'read') return recipes.getRecipe(parsed.id, parsed);
  const result = operation === 'create' ? await recipes.createRecipe(parsed.definition, { author: 'mind' })
    : await recipes[`${operation}Recipe`](parsed.id, parsed, { author: 'mind' });
  await context.recordCapabilityEvent?.({ kind: 'result', id: `recipe-definition:${context.requestId}`, data: {
    displayText: `Recipe definition ${operation} completed`, recipeId: result.id, revision: result.activeRevision, operation,
  } });
  return result;
}

export async function executeRecipe(tool, inputs, context, authority) {
  const { executeCosToolCall, getCosToolCatalog } = await import('./cosToolRegistry.js');
  const { id: recipeId, activeRevision: revision, definition } = tool.adapter.recipe;
  const scope = tool.adapter.scope || authority?.scope || 'mind';
  const accessCapability = recipeAccessCapability(scope);
  const toolBudget = context.toolBudget || (scope === 'agent' ? { used: 0 } : null);
  const results = {};
  const outcomes = [];
  let failingStep = tool.adapter.validationError?.step || null;
  const run = async () => {
    if (tool.adapter.validationError) throw new Error(tool.adapter.validationError.message);
    for (const step of definition.steps) {
      failingStep = step.id;
      if (context.signal?.aborted) throw new Error('Recipe interrupted by turn cancellation');
      const liveAuthority = scope === 'agent'
        ? await currentAgentAuthority(authority)
        : await currentMindAuthority(authority);
      if (context.signal?.aborted) throw new Error('Recipe interrupted by turn cancellation');
      if (!liveAuthority.capabilities[accessCapability]) throw new Error('Recipe access was revoked; remaining steps were stopped');
      validateMindToolRecipe(definition, getCosToolCatalog({ scope }).tools, { scope });
      if (!toolBudget || toolBudget.used >= COS_TOOL_CALL_LIMITS.maxCallsPerTurn) throw new Error('Shared turn tool-call budget exhausted; remaining steps were stopped');
      toolBudget.used += 1;
      const args = Object.fromEntries(Object.entries(step.arguments).map(([key, binding]) => [key, resolveMindToolRecipeBinding(binding, inputs, results, `steps.${step.id}.${key}`)]));
      const requestId = `recipe-${sha256Text(`${context.requestId}:${recipeId}:${revision}:${step.id}`).slice(0, 48)}`;
      const outcome = await executeCosToolCall({ call: { requestId, name: step.tool, arguments: args }, authority: liveAuthority, context: { ...context, toolBudget } });
      outcomes.push({ step: step.id, state: outcome.state });
      await context.recordCapabilityEvent?.({ kind: 'result', id: `recipe-step:${requestId}`, data: {
        displayText: `Recipe step ${step.id} ${outcome.state}`, recipeId, revision, step: step.id, success: outcome.state === 'completed',
      } });
      if (outcome.state !== 'completed') throw new Error(outcome.error || 'Read tool failed');
      results[step.id] = outcome.result;
    }
    failingStep = 'outputs';
    const outputs = Object.fromEntries(Object.entries(definition.outputs).map(([key, binding]) => [key, resolveMindToolRecipeBinding(binding, inputs, results, `outputs.${key}`)]));
    return { ok: true, state: 'completed', recipeId, revision, outcomes, outputs };
  };
  return run().catch(async (error) => {
    const state = context.signal?.aborted ? 'aborted' : outcomes.some((outcome) => outcome.state === 'completed') ? 'partial' : 'failed';
    await context.recordCapabilityEvent?.({ kind: 'result', id: `recipe-failure:${context.requestId}`, data: {
      displayText: `Recipe ${state} at ${failingStep}`, recipeId, revision, step: failingStep, state, success: false,
    } });
    return { ok: false, state, recipeId, revision, failingStep, outcomes, error: String(error.message).slice(0, 500),
      guidance: 'Read the current definition and grants; repair or restore if needed. Use a new requestId only for an intentional retry.',
    };
  });
}
