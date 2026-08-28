import { z } from 'zod';
import {
  createDefaultPortosSemanticToolGrants,
  portosSemanticToolGrantsSchema,
} from './cosToolContracts.js';

export const AGENT_CONTEXT_SCHEMA_VERSION = 3;
export const AGENT_CONTEXT_PROTOCOL_VERSION = '2025-11-25';
export const AGENT_CONTEXT_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2025-03-26',
  '2025-06-18',
  AGENT_CONTEXT_PROTOCOL_VERSION,
]);

export const AGENT_CONTEXT_SCOPES = Object.freeze(['navigation', 'workspaces', 'brain', 'identity']);
export const AGENT_CONTEXT_PROFILES = Object.freeze(['metadata', 'summary']);
export const AGENT_CONTEXT_DEFAULT_SCOPES = Object.freeze(['navigation', 'workspaces']);
export const AGENT_CONTEXT_DEFAULT_ACTIONS = Object.freeze(createDefaultPortosSemanticToolGrants());
export const AGENT_CONTEXT_LIMITS = Object.freeze({
  defaultResults: 10,
  maxResults: 25,
  maxSummaryChars: 320,
  maxResponseChars: 20_000,
  maxApproxTokens: 5_000,
  maxSourceItems: 1_000,
  maxQueryChars: 200,
  maxRefChars: 180,
});

const uniqueScopes = (scopes) => new Set(scopes).size === scopes.length;

export const agentContextSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  profile: z.enum(AGENT_CONTEXT_PROFILES).optional(),
  scopes: z.array(z.enum(AGENT_CONTEXT_SCOPES))
    .min(1)
    .max(AGENT_CONTEXT_SCOPES.length)
    .refine(uniqueScopes, 'Scopes must be unique')
    .optional(),
  actions: portosSemanticToolGrantsSchema.optional(),
}).strict();

const requestedScopesSchema = z.array(z.enum(AGENT_CONTEXT_SCOPES))
  .min(1)
  .max(AGENT_CONTEXT_SCOPES.length)
  .refine(uniqueScopes, 'Scopes must be unique')
  .optional();

export const agentContextSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(AGENT_CONTEXT_LIMITS.maxQueryChars),
  scopes: requestedScopesSchema,
  limit: z.number().int().min(1).max(AGENT_CONTEXT_LIMITS.maxResults).optional(),
}).strict();

export const agentContextGetInputSchema = z.object({
  ref: z.string().trim().min(1).max(AGENT_CONTEXT_LIMITS.maxRefChars),
}).strict();

export const agentContextListInputSchema = z.object({
  scope: z.enum(AGENT_CONTEXT_SCOPES),
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(AGENT_CONTEXT_LIMITS.maxResults).optional(),
}).strict();

export const agentContextNavigationInputSchema = z.object({
  query: z.string().trim().min(1).max(AGENT_CONTEXT_LIMITS.maxQueryChars),
}).strict();

export const agentContextProfileInputSchema = z.object({}).strict();

export const agentContextItemSchema = z.object({
  ref: z.string().max(AGENT_CONTEXT_LIMITS.maxRefChars),
  scope: z.enum(AGENT_CONTEXT_SCOPES),
  kind: z.string().max(80),
  title: z.string().max(160),
  summary: z.string().max(AGENT_CONTEXT_LIMITS.maxSummaryChars),
  path: z.string().max(300).optional(),
}).strict();

export const agentContextSearchOutputSchema = z.object({
  items: z.array(agentContextItemSchema).max(AGENT_CONTEXT_LIMITS.maxResults),
  total: z.number().int().min(0),
  truncated: z.boolean(),
  sourceTruncated: z.boolean(),
  sourceStatus: z.enum(['fresh', 'stale']),
}).strict();

export const agentContextGetOutputSchema = z.object({
  item: agentContextItemSchema.nullable(),
  sourceTruncated: z.boolean(),
  sourceStatus: z.enum(['fresh', 'stale']),
}).strict();

export const agentContextListOutputSchema = z.object({
  items: z.array(agentContextItemSchema).max(AGENT_CONTEXT_LIMITS.maxResults),
  total: z.number().int().min(0),
  nextCursor: z.number().int().min(0).nullable(),
  truncated: z.boolean(),
  sourceTruncated: z.boolean(),
  sourceStatus: z.enum(['fresh', 'stale']),
}).strict();

export const agentContextNavigationOutputSchema = z.object({
  match: agentContextItemSchema.nullable(),
  sourceStatus: z.enum(['fresh', 'stale']),
}).strict();

export const agentContextProfileOutputSchema = z.object({
  profile: z.enum(AGENT_CONTEXT_PROFILES),
  scopes: z.array(z.enum(AGENT_CONTEXT_SCOPES)),
  actions: portosSemanticToolGrantsSchema,
  limits: z.object({
    defaultResults: z.number().int().positive(),
    maxResults: z.number().int().positive(),
    maxSummaryChars: z.number().int().positive(),
    maxResponseChars: z.number().int().positive(),
    maxApproxTokens: z.number().int().positive(),
    maxSourceItems: z.number().int().positive(),
  }).strict(),
  exclusions: z.array(z.string()),
}).strict();

export const agentContextMcpRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(200), z.number().finite()]),
  method: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const agentContextMcpNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const agentContextMcpResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(200), z.number().finite()]),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
}).strict().refine((value) => value.result !== undefined || value.error !== undefined, {
  message: 'A response requires result or error',
});

export const agentContextMcpInboundSchema = z.union([
  agentContextMcpRequestSchema,
  agentContextMcpNotificationSchema,
  agentContextMcpResponseSchema,
]);

export const agentContextInitializeParamsSchema = z.object({
  protocolVersion: z.string().max(40),
  capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(80),
    title: z.string().max(160).optional(),
    websiteUrl: z.url().max(500).optional(),
    icons: z.array(z.object({
      src: z.string().min(1).max(500),
      mimeType: z.string().max(120).optional(),
      sizes: z.array(z.string().max(40)).max(20).optional(),
      theme: z.enum(['light', 'dark']).optional(),
    }).strict()).max(20).optional(),
  }).strict(),
  _meta: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const agentContextToolsListParamsSchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const agentContextToolCallParamsSchema = z.object({
  name: z.string().min(1).max(120),
  arguments: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
}).strict();

const toolSpecs = [
  { name: 'search_context', title: 'Search PortOS context', description: 'Search enabled read-only context scopes with bounded results.', inputSchema: agentContextSearchInputSchema, outputSchema: agentContextSearchOutputSchema },
  { name: 'get_context', title: 'Get PortOS context item', description: 'Resolve one stable context reference from an enabled scope.', inputSchema: agentContextGetInputSchema, outputSchema: agentContextGetOutputSchema },
  { name: 'list_context', title: 'List PortOS context', description: 'List a bounded page from one enabled read-only context scope.', inputSchema: agentContextListInputSchema, outputSchema: agentContextListOutputSchema },
  { name: 'resolve_navigation', title: 'Resolve PortOS navigation', description: 'Resolve a PortOS page from its navigation aliases.', inputSchema: agentContextNavigationInputSchema, outputSchema: agentContextNavigationOutputSchema, requiredScope: 'navigation' },
  { name: 'context_profile', title: 'Describe PortOS context access', description: 'Return the active context profile, scopes, exclusions, and budgets.', inputSchema: agentContextProfileInputSchema, outputSchema: agentContextProfileOutputSchema },
];

const toAdvertisedSchema = (schema) => {
  const output = z.toJSONSchema(schema);
  delete output.$schema;
  return output;
};

export const AGENT_CONTEXT_TOOL_REGISTRY = Object.freeze(toolSpecs.map((tool) => Object.freeze(tool)));

export const advertiseAgentContextTools = (scopes = AGENT_CONTEXT_DEFAULT_SCOPES) =>
  AGENT_CONTEXT_TOOL_REGISTRY
    .filter((tool) => !tool.requiredScope || scopes.includes(tool.requiredScope))
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toAdvertisedSchema(tool.inputSchema),
      outputSchema: toAdvertisedSchema(tool.outputSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }));
