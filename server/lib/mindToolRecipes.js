/** Closed, non-executable recipe definitions. No tools or providers run here. */
import { z } from 'zod';
import { ServerError } from './errorHandler.js';

export const MIND_TOOL_RECIPE_SCHEMA_VERSION = 1;
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value), 'reserved field');
const fields = (schema) => z.record(key, schema).refine((value) => Object.keys(value).length <= 30, 'at most 30 fields');
const primitiveMatches = (value, type) => type === 'null' ? value === null
  : type === 'integer' ? Number.isInteger(value)
    : typeof value === type;
const parameter = z.lazy(() => z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']),
  description: z.string().max(500).optional(),
  properties: fields(parameter).optional(),
  required: z.array(key).max(30).optional(),
  additionalProperties: z.literal(false).optional(),
  items: parameter.optional(),
  enum: z.array(z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])).min(1).max(30).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.type === 'object') {
    if (!value.properties || value.additionalProperties !== false) ctx.addIssue({ code: 'custom', message: 'objects require properties and additionalProperties: false' });
    for (const name of value.required || []) if (!Object.hasOwn(value.properties || {}, name)) ctx.addIssue({ code: 'custom', path: ['required'], message: 'required field must exist in properties' });
  } else if (value.properties || value.required || value.additionalProperties !== undefined) ctx.addIssue({ code: 'custom', message: 'object keywords require object type' });
  if (value.enum?.some((entry) => !primitiveMatches(entry, value.type))) ctx.addIssue({ code: 'custom', path: ['enum'], message: 'enum values must match the declared primitive type' });
  if ((value.type === 'array') !== !!value.items) ctx.addIssue({ code: 'custom', path: ['items'], message: 'only arrays require an items schema' });
}));
const path = z.array(z.string().regex(/^(?:[A-Za-z][A-Za-z0-9_-]{0,63}|0|[1-9][0-9]{0,5})$/)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value), 'reserved field')).max(8);
export const mindToolRecipeBindingSchema = z.union([
  z.object({ literal: z.json() }).strict(),
  z.object({ input: key }).strict(),
  z.object({ step: key, path }).strict(),
]);
const definition = z.object({
  schemaVersion: z.literal(MIND_TOOL_RECIPE_SCHEMA_VERSION),
  name: z.string().regex(/^recipe\.[a-z][a-z0-9-]{0,63}$/),
  purpose: z.string().trim().min(1).max(1000),
  parameters: parameter.refine((value) => value.type === 'object', 'parameters must be a closed object'),
  steps: z.array(z.object({ id: key, tool: z.string().min(1).max(100), arguments: fields(mindToolRecipeBindingSchema) }).strict()).min(1).max(5),
  outputs: fields(mindToolRecipeBindingSchema).refine((value) => Object.keys(value).length > 0, 'at least one output binding'),
}).strict();
// Bound recursive parsing before Zod descends into authored JSON.
const boundedJson = z.unknown().superRefine((value, ctx) => {
  const queue = [[value, 0]];
  let nodes = 0;
  let chars = 0;
  while (queue.length) {
    const [item, depth] = queue.pop();
    if (typeof item === 'string') chars += item.length;
    if (++nodes > 4000 || depth > 16 || chars > 64000) {
      ctx.addIssue({ code: 'custom', message: 'definition exceeds depth or size limit' });
      return;
    }
    if (item && typeof item === 'object') queue.push(...Object.values(item).map((child) => [child, depth + 1]));
    else if (typeof item === 'string' && item.length > 12000) {
      ctx.addIssue({ code: 'custom', message: 'definition value exceeds size limit' });
      return;
    }
  }
});
export const mindToolRecipeDefinitionSchema = boundedJson.pipe(definition);
export const mindToolRecipeSaveSchema = z.object({ definition: mindToolRecipeDefinitionSchema }).strict();
export const mindToolRecipeRevisionSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const mindToolRecipeUpdateSchema = mindToolRecipeRevisionSchema.extend({ definition: mindToolRecipeDefinitionSchema });
export const mindToolRecipeRestoreSchema = mindToolRecipeRevisionSchema.extend({ revision: z.number().int().positive() });

const fail = (field, message, step) => {
  throw new ServerError(`${field}: ${message}`, { status: 400, code: 'RECIPE_VALIDATION_ERROR', context: { field, ...(step ? { step } : {}) } });
};
const parseDefinition = (candidate) => {
  const parsed = mindToolRecipeDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(issue.path.join('.') || 'definition', issue.message);
  }
  return parsed.data;
};
const compatibleType = (source, target) => {
  if (!target.type || !source.type) return true;
  const targets = Array.isArray(target.type) ? target.type : [target.type];
  const sources = Array.isArray(source.type) ? source.type : [source.type];
  return sources.some((type) => targets.includes(type) || (type === 'integer' && targets.includes('number')));
};
const checkBindingType = (source, target, field, step) => {
  if (!compatibleType(source, target)) fail(field, 'binding type does not match target argument contract', step);
  if (source.enum && target.enum && !source.enum.some((value) => target.enum.includes(value))) fail(field, 'binding enum cannot satisfy target argument contract', step);
  if (source.type === 'array' && target.type === 'array' && source.items && target.items) checkBindingType(source.items, target.items, field, step);
  if (source.type === 'object' && target.type === 'object') {
    for (const required of target.required || []) {
      if (!Object.hasOwn(source.properties || {}, required) && source.additionalProperties === false) fail(field, 'binding object lacks a required target field', step);
    }
    for (const [name, schema] of Object.entries(source.properties || {})) {
      if (target.properties?.[name]) checkBindingType(schema, target.properties[name], field, step);
      else if (target.additionalProperties === false && (source.required || []).includes(name)) fail(field, 'binding object contains a required field outside the target contract', step);
    }
  }
};
const walkOutput = (schema, segments, field, step, runtimeChecks) => {
  let current = schema;
  for (const segment of segments) {
    if (current?.type === 'array' && /^\d+$/.test(segment)) current = current.items;
    else if (Object.hasOwn(current?.properties || {}, segment)) current = current.properties[segment];
    else if (current?.additionalProperties === true || !current?.type) {
      runtimeChecks.push({ field, step, message: 'Open output: binding presence and type must be checked at invocation' });
      return null;
    } else fail(field, 'output field is not declared by this tool', step);
  }
  return current;
};

/** Validate against the current catalog without reading any private tool result. */
export function validateMindToolRecipe(candidate, catalog) {
  const value = parseDefinition(candidate);
  const runtimeChecks = [];
  const names = new Set(catalog.flatMap((tool) => [tool.name, tool.providerName, ...(tool.aliases || [])]));
  if (names.has(value.name)) fail('name', 'name collides with a shipped tool');
  const earlier = new Map();
  const inspectBinding = (binding, target, field, step) => {
    let source;
    if (Object.hasOwn(binding, 'literal')) {
      if (target && !z.fromJSONSchema(target).safeParse(binding.literal).success) fail(field, 'literal does not match target argument contract', step);
      return;
    }
    if (binding.input) {
      source = value.parameters.properties[binding.input];
      if (!source) fail(field, 'input field is not declared', step);
      if (!(value.parameters.required || []).includes(binding.input)) runtimeChecks.push({ field, step, message: 'Optional input binding must be present at invocation' });
    } else {
      const tool = earlier.get(binding.step);
      if (!tool) fail(field, 'step reference must name an earlier step', step);
      source = walkOutput(tool.output_schema, binding.path, field, step, runtimeChecks);
    }
    if (!target || !source) return;
    checkBindingType(source, target, field, step);
    // Constraints and optional output properties need the actual value even
    // when their top-level types agree. Never promise static certainty here.
    runtimeChecks.push({ field, step, message: 'Validate bound value against the target contract at invocation' });
  };
  for (const [index, step] of value.steps.entries()) {
    const field = `steps.${index}`;
    if (earlier.has(step.id)) fail(`${field}.id`, 'step ids must be unique', step.id);
    const tool = catalog.find((entry) => entry.name === step.tool);
    if (!tool || tool.policy.sideEffect !== 'read' || !tool.policy.scopes.includes('mind') || tool.name.startsWith('recipe.')) fail(`${field}.tool`, 'select a current canonical read tool in mind scope', step.id);
    const contract = tool.input_schema;
    for (const required of contract.required || []) if (!Object.hasOwn(step.arguments, required)) fail(`${field}.arguments.${required}`, 'required argument is missing', step.id);
    for (const [name, binding] of Object.entries(step.arguments)) {
      if (!Object.hasOwn(contract.properties || {}, name)) fail(`${field}.arguments.${name}`, 'unknown tool argument', step.id);
      inspectBinding(binding, contract.properties[name], `${field}.arguments.${name}`, step.id);
    }
    earlier.set(step.id, tool);
  }
  for (const [name, binding] of Object.entries(value.outputs)) inspectBinding(binding, null, `outputs.${name}`);
  return { valid: true, definition: value, runtimeChecks };
}

/** Phase 2 can use this at invocation; it never executes a tool itself. */
export function resolveMindToolRecipeBinding(binding, inputs, results, field = 'binding') {
  if (Object.hasOwn(binding, 'literal')) return structuredClone(binding.literal);
  if (binding.input) {
    if (!Object.hasOwn(inputs, binding.input)) fail(field, 'input binding is missing');
    return inputs[binding.input];
  }
  if (!Object.hasOwn(results, binding.step)) fail(field, 'step result is missing', binding.step);
  let value = results[binding.step];
  for (const segment of binding.path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) fail(field, 'output binding is missing', binding.step);
    value = value[segment];
  }
  return value;
}
