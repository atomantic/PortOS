import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_CONTEXT_LIMITS,
  AGENT_CONTEXT_TOOL_REGISTRY,
  advertiseAgentContextTools,
  agentContextSettingsSchema,
} from './agentContextValidation.js';

const advertisedSchema = (schema) => {
  const output = z.toJSONSchema(schema);
  delete output.$schema;
  return output;
};

describe('agentContextValidation', () => {
  it('accepts only bounded, unique known settings scopes', () => {
    expect(agentContextSettingsSchema.parse({
      enabled: true,
      profile: 'metadata',
      scopes: ['navigation', 'brain'],
      actions: { readPortos: true, writePortos: false },
    })).toEqual({
      enabled: true,
      profile: 'metadata',
      scopes: ['navigation', 'brain'],
      actions: { readPortos: true, writePortos: false },
    });
    expect(agentContextSettingsSchema.safeParse({ scopes: ['brain', 'brain'] }).success).toBe(false);
    expect(agentContextSettingsSchema.safeParse({ scopes: ['privacy-vault'] }).success).toBe(false);
    expect(agentContextSettingsSchema.safeParse({ enabled: true, unknown: true }).success).toBe(false);
    expect(agentContextSettingsSchema.safeParse({ actions: { shell: true } }).success).toBe(false);
  });

  it('advertises the same schemas used for runtime validation', () => {
    const advertised = advertiseAgentContextTools(['navigation', 'workspaces']);
    for (const tool of advertised) {
      const runtime = AGENT_CONTEXT_TOOL_REGISTRY.find((candidate) => candidate.name === tool.name);
      expect(tool.inputSchema).toEqual(advertisedSchema(runtime.inputSchema));
      expect(tool.outputSchema).toEqual(advertisedSchema(runtime.outputSchema));
    }
  });

  it('marks every advertised tool as read-only and non-destructive', () => {
    for (const tool of advertiseAgentContextTools(['navigation', 'workspaces'])) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it('enforces result limits in tool input schemas', () => {
    const search = AGENT_CONTEXT_TOOL_REGISTRY.find((tool) => tool.name === 'search_context');
    expect(search.inputSchema.safeParse({ query: 'x', limit: AGENT_CONTEXT_LIMITS.maxResults }).success).toBe(true);
    expect(search.inputSchema.safeParse({ query: 'x', limit: AGENT_CONTEXT_LIMITS.maxResults + 1 }).success).toBe(false);
    expect(AGENT_CONTEXT_LIMITS.maxApproxTokens).toBeLessThanOrEqual(Math.ceil(AGENT_CONTEXT_LIMITS.maxResponseChars / 4));
  });
});
