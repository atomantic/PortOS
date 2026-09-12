/** Mind-only recipe catalog and bounded orchestration over semantic reads. */
import { z } from 'zod';
import { COS_TOOL_SCHEMA_VERSION, COS_TOOL_CALL_LIMITS, providerToolName } from '../lib/cosToolContracts.js';
import { validateMindToolRecipe, resolveMindToolRecipeBinding } from '../lib/mindToolRecipes.js';
import { zodToOpenApiSchema } from '../lib/apiContractSchemas.js';
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
const descriptor = (name, description, input_schema, adapter, requiredCapabilities, sideEffect = 'read') => ({
  type: 'portos_tool', name, version: COS_TOOL_SCHEMA_VERSION, providerName: providerToolName(name), aliases: [],
  description, input_schema, output_schema: { type: 'object', additionalProperties: true },
  policy: { scopes: ['mind'], requiredCapabilities, sideEffect, idempotent: true, async: false, confirmation: 'capability-grant' },
  adapter,
});
export const recipeManagementTools = Object.entries(managementSchemas).map(([operation, schema]) => descriptor(
  `mind.recipes.${operation}`, `${operation} saved read-tool recipe definitions. Read/list return paged definitions/history only. Create/update require schemaVersion:1, recipe.* name, purpose, closed parameters, 1-5 steps with {id,tool,arguments}, and outputs. Bindings are {literal:value}, {input:parameter}, or {step:id,path:[field]}.`,
  zodToOpenApiSchema(schema), { kind: 'recipe-management', operation }, ['manageToolRecipes'], ['list', 'read'].includes(operation) ? 'read' : 'write',
));

export const recipeTool = (recipe, primitives) => {
  if (recipe.archived) throw new ServerError('Recipe is archived. Restore a revision before calling it.', { code: 'RECIPE_ARCHIVED', status: 409 });
  const { definition } = validateMindToolRecipe(recipe.definition, primitives);
  const required = [...new Set(['manageToolRecipes', ...definition.steps.flatMap((step) => primitives.find((tool) => tool.name === step.tool).policy.requiredCapabilities)])];
  return descriptor(definition.name, definition.purpose.slice(0, 280), definition.parameters,
    { kind: 'recipe', recipe: { id: recipe.id, activeRevision: recipe.activeRevision, definition } }, required);
};

// Even an incompatible revision gets a replay fingerprint and structured failure.
// A repair must never silently reinterpret the same invocation requestId.
export const resolveMindRecipeInvocation = (recipe, primitives) => Promise.resolve()
  .then(() => recipeTool(recipe, primitives))
  .catch((error) => descriptor(recipe.name, 'Unavailable saved recipe', { type: 'object', additionalProperties: true },
    { kind: 'recipe', recipe, validationError: { message: error.message, step: error.context?.step || 'definition' } }, ['manageToolRecipes']));

export async function readMindRecipeTools(capabilities, primitives) {
  if (capabilities?.manageToolRecipes !== true) return [];
  const { listRecipes } = await import('./mindToolRecipes.js');
  const { recipes } = await listRecipes({ limit: 20 });
  const checked = await Promise.allSettled(recipes.map(async (recipe) => recipeTool(recipe, primitives)));
  let chars = 0;
  return checked.flatMap((entry) => {
    if (entry.status !== 'fulfilled' || !entry.value.policy.requiredCapabilities.every((key) => capabilities[key] === true)) return [];
    const size = JSON.stringify(entry.value.input_schema).length + entry.value.description.length;
    if (chars + size > 24000) return [];
    chars += size;
    return [entry.value];
  });
}

export async function currentMindAuthority(authority) {
  const { loadState } = await import('./cosState.js');
  const root = await loadState();
  return { ...authority, capabilities: root.config?.persistentMindCapabilities || {} };
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
  const results = {};
  const outcomes = [];
  let failingStep = tool.adapter.validationError?.step || null;
  const run = async () => {
    if (tool.adapter.validationError) throw new Error(tool.adapter.validationError.message);
    for (const step of definition.steps) {
      failingStep = step.id;
      if (context.signal?.aborted) throw new Error('Recipe interrupted by turn cancellation');
      const liveAuthority = await currentMindAuthority(authority);
      if (context.signal?.aborted) throw new Error('Recipe interrupted by turn cancellation');
      if (!liveAuthority.capabilities.manageToolRecipes) throw new Error('Recipe management grant was revoked; remaining steps were stopped');
      validateMindToolRecipe(definition, getCosToolCatalog({ scope: 'mind' }).tools);
      if (!context.toolBudget || context.toolBudget.used >= COS_TOOL_CALL_LIMITS.maxCallsPerTurn) throw new Error('Shared turn tool-call budget exhausted; remaining steps were stopped');
      context.toolBudget.used += 1;
      const args = Object.fromEntries(Object.entries(step.arguments).map(([key, binding]) => [key, resolveMindToolRecipeBinding(binding, inputs, results, `steps.${step.id}.${key}`)]));
      const requestId = `recipe-${sha256Text(`${context.requestId}:${recipeId}:${revision}:${step.id}`).slice(0, 48)}`;
      const outcome = await executeCosToolCall({ call: { requestId, name: step.tool, arguments: args }, authority: liveAuthority, context });
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
