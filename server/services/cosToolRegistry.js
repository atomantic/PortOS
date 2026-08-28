/**
 * Capability-oriented tool registry shared by HTTP, voice adapters, and the
 * Persistent Mind. Raw routes are deliberately not callable through it.
 */

import { z } from 'zod';
import {
  COS_TOOL_SCHEMA_VERSION,
  cosToolCallSchema,
  normalizePortosSemanticToolGrants,
} from '../lib/cosToolContracts.js';
import { zodToOpenApiSchema } from '../lib/apiContractSchemas.js';
import { canonicalStringify } from '../lib/objects.js';
import { sha256Text } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import {
  persistentMindCleanupRequestSchema,
  persistentMindTaskRequestSchema,
} from '../lib/persistentMindCapabilities.js';
import { dispatchTool, getToolSpecs, getToolSpecsForIntent } from './voice/tools.js';
import { executePersistentMindTaskRequests } from './persistentMindTaskCapability.js';
import { cleanupPersistentMind } from './persistentMindMaintenance.js';

const MAX_CALL_RESULTS = 500;
const MAX_IDEMPOTENCY_TOMBSTONES = 10_000;
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

const VOICE_ADAPTERS = Object.freeze({
  brain_capture: { id: 'brain.capture', sideEffect: 'write', capability: 'writePortos' },
  brain_search: { id: 'brain.search', sideEffect: 'read', capability: 'readPortos' },
  brain_list_recent: { id: 'brain.recent', sideEffect: 'read', capability: 'readPortos' },
  meatspace_log_drink: { id: 'health.log.drink', sideEffect: 'write', capability: 'writePortos' },
  meatspace_log_nicotine: { id: 'health.log.nicotine', sideEffect: 'write', capability: 'writePortos' },
  meatspace_summary_today: { id: 'health.today', sideEffect: 'read', capability: 'readPortos' },
  meatspace_log_weight: { id: 'health.log.weight', sideEffect: 'write', capability: 'writePortos' },
  meatspace_log_workout: { id: 'health.log.workout', sideEffect: 'write', capability: 'writePortos' },
  goal_list: { id: 'goals.list', sideEffect: 'read', capability: 'readPortos' },
  goal_update_progress: { id: 'goals.update-progress', sideEffect: 'write', capability: 'writePortos' },
  goal_log_note: { id: 'goals.log-note', sideEffect: 'write', capability: 'writePortos' },
  pm2_status: { id: 'system.processes.status', sideEffect: 'read', capability: 'readPortos' },
  feeds_digest: { id: 'feeds.digest', sideEffect: 'read', capability: 'readPortos' },
  feeds_mark_read: { id: 'feeds.mark-read', sideEffect: 'write', capability: 'writePortos' },
  daily_log_append: { id: 'journal.append', sideEffect: 'write', capability: 'writePortos' },
  daily_log_read: { id: 'journal.read', sideEffect: 'read', capability: 'readPortos' },
  time_now: { id: 'time.now', sideEffect: 'read', capability: 'readPortos' },
  calendar_today: { id: 'calendar.today', sideEffect: 'read', capability: 'readPortos' },
  calendar_next: { id: 'calendar.next', sideEffect: 'read', capability: 'readPortos' },
  weather_now: { id: 'weather.now', sideEffect: 'read', capability: 'readPortos' },
  code_agent_status: { id: 'cos.agents.status', sideEffect: 'read', capability: 'readPortos' },
  catalog_lookup: { id: 'catalog.search', sideEffect: 'read', capability: 'readPortos' },
});

const compactDescription = (description) => {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  const firstSentence = text.match(/^.*?[.!?](?:\s|$)/)?.[0] || text;
  return firstSentence.slice(0, 280);
};

const closedInputSchema = (schema) => ({
  type: 'object',
  properties: {},
  ...(schema || {}),
  additionalProperties: false,
});

const objectOutputSchema = Object.freeze({ type: 'object', additionalProperties: true });

const voiceTools = (intent) => {
  const specs = intent ? getToolSpecsForIntent(intent).specs : getToolSpecs();
  return specs.flatMap((spec) => {
    const legacyName = spec.function.name;
    const adapter = VOICE_ADAPTERS[legacyName];
    if (!adapter) return [];
    const providerName = adapter.id.replaceAll('.', '_').replaceAll('-', '_');
    return [{
      type: 'portos_tool',
      name: adapter.id,
      version: COS_TOOL_SCHEMA_VERSION,
      providerName,
      aliases: [...new Set([legacyName, providerName])],
      description: compactDescription(spec.function.description),
      input_schema: closedInputSchema(spec.function.parameters),
      output_schema: objectOutputSchema,
      policy: {
        scopes: ['agent', 'mind', 'ui', 'voice'],
        requiredCapabilities: [adapter.capability],
        sideEffect: adapter.sideEffect,
        idempotent: adapter.sideEffect === 'read',
        async: false,
        confirmation: adapter.sideEffect === 'read' ? 'none' : 'capability-grant',
      },
      adapter: { kind: 'voice-tool', legacyName },
    }];
  });
};

const taskTool = Object.freeze({
  type: 'portos_tool',
  name: 'cos.create-task',
  version: COS_TOOL_SCHEMA_VERSION,
  providerName: 'cos_create_task',
  aliases: ['cos_create_task'],
  description: 'Queue one bounded, supervised CoS agent task through the normal scheduler and delivery gates.',
  input_schema: zodToOpenApiSchema(persistentMindTaskRequestSchema),
  output_schema: objectOutputSchema,
  policy: {
    scopes: ['mind'],
    requiredCapabilities: ['createTasks'],
    sideEffect: 'supervised-write',
    idempotent: true,
    async: true,
    confirmation: 'capability-grant',
  },
  adapter: { kind: 'persistent-mind-task' },
});

const mindCleanupTool = Object.freeze({
  type: 'portos_tool',
  name: 'mind.cleanup',
  version: COS_TOOL_SCHEMA_VERSION,
  providerName: 'mind_cleanup',
  aliases: ['mind_cleanup'],
  description: 'Clean Persistent Mind-owned memories, trajectory history, or derived context when stale information is no longer useful.',
  input_schema: zodToOpenApiSchema(persistentMindCleanupRequestSchema),
  output_schema: objectOutputSchema,
  policy: {
    scopes: ['mind'],
    requiredCapabilities: ['manageMind'],
    sideEffect: 'destructive',
    idempotent: true,
    async: false,
    confirmation: 'capability-grant',
  },
  adapter: { kind: 'persistent-mind-maintenance' },
});

const toolCatalog = (intent) => [taskTool, mindCleanupTool, ...voiceTools(intent)];
const toolCalls = new Map();
const toolCallFingerprints = new Map();

const normalizeToolCapabilities = (raw) => ({
  ...normalizePortosSemanticToolGrants(raw),
  createTasks: raw?.createTasks === true,
  manageMind: raw?.manageMind === true,
});

const publicTool = (tool, { scope, capabilities }) => ({
  type: tool.type,
  name: tool.name,
  version: tool.version,
  providerName: tool.providerName,
  aliases: tool.aliases,
  description: tool.description,
  input_schema: tool.input_schema,
  output_schema: tool.output_schema,
  policy: tool.policy,
  availableInScope: scope === 'all' || tool.policy.scopes.includes(scope),
  granted: !['agent', 'mind'].includes(scope)
    ? null
    : tool.policy.requiredCapabilities.every((capability) => capabilities[capability] === true),
});

export const getCosToolCatalog = ({ scope = 'all', intent, capabilities } = {}) => {
  const grants = normalizeToolCapabilities(capabilities);
  const tools = toolCatalog(intent)
    .filter((tool) => scope === 'all' || tool.policy.scopes.includes(scope))
    .map((tool) => publicTool(tool, { scope, capabilities: grants }));
  return {
    type: 'portos_tool_catalog',
    schemaVersion: COS_TOOL_SCHEMA_VERSION,
    scope,
    tools,
    stats: {
      total: tools.length,
      read: tools.filter((tool) => tool.policy.sideEffect === 'read').length,
      write: tools.filter((tool) => tool.policy.sideEffect !== 'read').length,
      granted: tools.filter((tool) => tool.granted === true).length,
    },
  };
};

export const formatCosToolCatalog = (catalog, format = 'portos') => {
  if (format === 'portos') return catalog;
  const tools = catalog.tools.filter((tool) => tool.granted !== false).map((tool) => {
    if (format === 'openai') {
      return { type: 'function', function: { name: tool.providerName, description: tool.description, parameters: tool.input_schema } };
    }
    if (format === 'anthropic') {
      return { name: tool.providerName, description: tool.description, input_schema: tool.input_schema };
    }
    return {
      name: tool.providerName,
      description: tool.description,
      inputSchema: tool.input_schema,
      outputSchema: tool.output_schema,
      annotations: {
        readOnlyHint: tool.policy.sideEffect === 'read',
        destructiveHint: tool.policy.sideEffect === 'destructive',
        idempotentHint: tool.policy.idempotent,
        openWorldHint: false,
      },
    };
  });
  return { type: `${format}_tool_catalog`, schemaVersion: catalog.schemaVersion, scope: catalog.scope, tools };
};

export const buildPersistentMindToolPrompt = (capabilities) => {
  const catalog = getCosToolCatalog({ scope: 'mind', capabilities });
  const tools = catalog.tools.filter((tool) => tool.granted).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    sideEffect: tool.policy.sideEffect,
  }));
  if (tools.length === 0) {
    return `# PortOS semantic tools
Semantic tool access is OFF. Return an empty toolCalls array. Never invent a tool name or claim that a PortOS action ran.`;
  }
  return `# PortOS semantic tools
You may request up to five calls from the exact catalog below. These are semantic actions, not raw HTTP routes. Never invent a name, route, or argument. Use a stable requestId when practical and never submit the same action in both toolCalls and taskRequests.

${JSON.stringify(tools)}

Calls without requestId are coalesced by canonical tool name and arguments within this turn. Supply distinct requestId values only when two intentionally identical actions must both run.`;
};

const resolveTool = (name) => toolCatalog().find((tool) =>
  tool.name === name || tool.providerName === name || tool.aliases.includes(name));

export const isCosTaskToolName = (name) => resolveTool(name)?.adapter.kind === 'persistent-mind-task';

const validateAuthority = (tool, authority) => {
  const scope = authority?.scope || 'ui';
  if (!tool.policy.scopes.includes(scope)) {
    throw new ServerError(`Tool '${tool.name}' is unavailable in the ${scope} scope`, { status: 403, code: 'TOOL_SCOPE_DENIED' });
  }
  if (scope === 'mind' || scope === 'agent') {
    const capabilities = normalizeToolCapabilities(authority.capabilities);
    const missing = tool.policy.requiredCapabilities.filter((capability) => capabilities[capability] !== true);
    if (missing.length) {
      throw new ServerError(`Tool '${tool.name}' is not granted to the ${scope} principal`, { status: 403, code: 'TOOL_CAPABILITY_DENIED' });
    }
  }
  if (scope === 'ui' && tool.policy.sideEffect !== 'read' && authority?.authenticated !== true) {
    throw new ServerError('Mutating tool calls require an authenticated PortOS session', { status: 403, code: 'TOOL_AUTH_REQUIRED' });
  }
};

const validateArguments = (tool, args) => {
  const schema = z.fromJSONSchema(tool.input_schema);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new ServerError(`Invalid arguments for '${tool.name}': ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`, {
      status: 400,
      code: 'TOOL_VALIDATION_ERROR',
    });
  }
  return parsed.data;
};

const executeAdapter = async (tool, args, context) => {
  if (tool.adapter.kind === 'voice-tool') {
    return dispatchTool(tool.adapter.legacyName, args, { sideEffects: [], signal: context.signal });
  }
  if (tool.adapter.kind === 'persistent-mind-maintenance') {
    return cleanupPersistentMind({
      ...args,
      requestedBy: 'mind',
      preserveTurnId: context.turnId || null,
      preserveMessageId: context.wake?.kind === 'message' ? context.wake.message?.id || null : null,
    });
  }
  const [outcome] = await executePersistentMindTaskRequests({
    taskRequests: [args],
    turnId: context.turnId,
    wake: context.wake,
    signal: context.signal,
    recordCapabilityEvent: context.recordCapabilityEvent,
  });
  return {
    ok: outcome?.success === true,
    taskId: outcome?.task?.id || null,
    state: outcome?.success ? 'queued' : 'failed',
    duplicate: outcome?.duplicate === true,
    ...(outcome?.error ? { error: String(outcome.error).slice(0, 300) } : {}),
  };
};

const trimCallResults = () => {
  while (toolCalls.size > MAX_CALL_RESULTS) toolCalls.delete(toolCalls.keys().next().value);
};

const pruneToolCallFingerprints = (now = Date.now()) => {
  for (const [requestId, entry] of toolCallFingerprints) {
    if (entry.expiresAt > now) break;
    toolCallFingerprints.delete(requestId);
  }
  while (toolCallFingerprints.size > MAX_IDEMPOTENCY_TOMBSTONES) {
    toolCallFingerprints.delete(toolCallFingerprints.keys().next().value);
  }
};

const normalizeAdapterResult = ({ parsedCall, tool, result }) => {
  const parsedResult = z.record(z.string(), z.unknown()).safeParse(result);
  const base = {
    type: 'portos_tool_result',
    requestId: parsedCall.requestId,
    name: tool.name,
    version: COS_TOOL_SCHEMA_VERSION,
    duplicate: false,
  };
  if (!parsedResult.success) {
    return { ...base, state: 'failed', error: 'Tool adapter returned an invalid result' };
  }
  const failed = parsedResult.data.ok === false || parsedResult.data.state === 'failed';
  return {
    ...base,
    state: failed ? 'failed' : 'completed',
    ...(failed ? { error: String(parsedResult.data.error || parsedResult.data.summary || 'Tool adapter reported failure').slice(0, 500) } : {}),
    result: parsedResult.data,
  };
};

export const executeCosToolCall = async ({ call, authority, context = {} }) => {
  const parsedCall = cosToolCallSchema.parse(call);
  const tool = resolveTool(parsedCall.name);
  if (!tool) throw new ServerError(`Unknown tool '${parsedCall.name}'`, { status: 404, code: 'TOOL_NOT_FOUND' });
  validateAuthority(tool, authority);
  const args = validateArguments(tool, parsedCall.arguments);
  const fingerprint = sha256Text(canonicalStringify({ name: tool.name, arguments: args, scope: authority?.scope || 'ui' }));
  pruneToolCallFingerprints();
  const existing = toolCalls.get(parsedCall.requestId);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new ServerError('requestId was already used for a different tool call', { status: 409, code: 'TOOL_IDEMPOTENCY_CONFLICT' });
    }
    const result = await existing.promise;
    return { ...result, duplicate: true };
  }
  const retainedFingerprint = toolCallFingerprints.get(parsedCall.requestId);
  if (retainedFingerprint) {
    if (retainedFingerprint.fingerprint !== fingerprint) {
      throw new ServerError('requestId was already used for a different tool call', { status: 409, code: 'TOOL_IDEMPOTENCY_CONFLICT' });
    }
    throw new ServerError('requestId result has expired and cannot be replayed safely', { status: 409, code: 'TOOL_IDEMPOTENCY_EXPIRED' });
  }

  const promise = Promise.resolve()
    .then(() => executeAdapter(tool, args, context))
    .then(
      (result) => normalizeAdapterResult({ parsedCall, tool, result }),
      (error) => ({
        type: 'portos_tool_result',
        requestId: parsedCall.requestId,
        name: tool.name,
        version: COS_TOOL_SCHEMA_VERSION,
        state: 'failed',
        duplicate: false,
        error: String(error?.message || error || 'Tool execution failed').slice(0, 500),
      }),
    );
  toolCallFingerprints.set(parsedCall.requestId, {
    fingerprint,
    expiresAt: Date.now() + IDEMPOTENCY_RETENTION_MS,
  });
  pruneToolCallFingerprints();
  toolCalls.set(parsedCall.requestId, { fingerprint, promise });
  trimCallResults();
  return promise;
};

export const getCosToolCall = async (requestId) => {
  const entry = toolCalls.get(requestId);
  return entry ? entry.promise : null;
};

export const __testing = { VOICE_ADAPTERS, resolveTool, toolCalls, toolCallFingerprints };
