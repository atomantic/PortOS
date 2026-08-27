/** Provider-neutral wire contracts for the semantic CoS tool interface. */

import { z } from 'zod';

export const COS_TOOL_SCHEMA_VERSION = 1;
export const PORTOS_SEMANTIC_TOOL_GRANT_KEYS = Object.freeze(['readPortos', 'writePortos']);
export const COS_TOOL_CALL_LIMITS = Object.freeze({
  requestIdChars: 200,
  nameChars: 100,
  maxCallsPerTurn: 5,
});

// Shared by every principal that can receive the governed semantic catalog.
// Principal-specific capabilities (for example Persistent Mind task creation)
// extend this object rather than cloning the read/write grant contract.
export const portosSemanticToolGrantsSchema = z.object({
  readPortos: z.boolean().optional(),
  writePortos: z.boolean().optional(),
}).strict();

export const createDefaultPortosSemanticToolGrants = () => ({
  readPortos: false,
  writePortos: false,
});

export const normalizePortosSemanticToolGrants = (raw) => {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    readPortos: source.readPortos === true,
    writePortos: source.writePortos === true,
  };
};

export const cosToolRequestIdSchema = z.string()
  .trim()
  .min(1)
  .max(COS_TOOL_CALL_LIMITS.requestIdChars)
  .regex(/^[A-Za-z0-9._:-]+$/, 'requestId contains unsupported characters');

export const cosToolCallSchema = z.object({
  type: z.literal('portos_tool_call').optional().default('portos_tool_call'),
  requestId: cosToolRequestIdSchema,
  name: z.string().trim().min(1).max(COS_TOOL_CALL_LIMITS.nameChars).regex(/^[A-Za-z0-9._-]+$/),
  version: z.literal(COS_TOOL_SCHEMA_VERSION).optional().default(COS_TOOL_SCHEMA_VERSION),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
}).strict();

export const cosToolCatalogQuerySchema = z.object({
  scope: z.enum(['all', 'agent', 'mind', 'ui', 'voice']).optional().default('all'),
  intent: z.string().trim().max(500).optional(),
  format: z.enum(['portos', 'openai', 'anthropic', 'mcp']).optional().default('portos'),
}).strict();

export const cosToolCallParamsSchema = z.object({ requestId: cosToolRequestIdSchema }).strict();

export const persistentMindToolCallSchema = cosToolCallSchema
  .omit({ type: true, version: true, requestId: true })
  .extend({ requestId: cosToolRequestIdSchema.optional() });
