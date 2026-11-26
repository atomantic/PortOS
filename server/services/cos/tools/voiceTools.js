/** Adapts intent-selected voice tools to the semantic CoS catalog and dispatcher. */

import { dispatchTool, getToolSpecs, getToolSpecsForIntent } from '../../voice/tools.js';
import { COS_TOOL_SCHEMA_VERSION, COS_TOOL_OBJECT_OUTPUT_SCHEMA as objectOutputSchema, providerToolName } from '../../../lib/cos/cosToolContracts.js';

export const VOICE_ADAPTERS = Object.freeze({
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

export const voiceTools = (intent) => {
  const specs = intent ? getToolSpecsForIntent(intent).specs : getToolSpecs();
  return specs.flatMap((spec) => {
    const legacyName = spec.function.name;
    const adapter = VOICE_ADAPTERS[legacyName];
    if (!adapter) return [];
    const providerName = providerToolName(adapter.id);
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

const runVoiceTool = (tool, args, context, authority) => dispatchTool(tool.adapter.legacyName, args, {
  sideEffects: [], signal: context.signal,
  // executeCosToolCall already validated this server-owned principal and
  // the tool's capability. Never promote arguments or voice scope to host authority.
  hasHostControl: () => ['agent', 'mind'].includes(authority?.scope)
    || (authority?.scope === 'ui' && authority.authenticated === true),
});

export const voiceAdapterHandlers = {
  'voice-tool': runVoiceTool,
};
