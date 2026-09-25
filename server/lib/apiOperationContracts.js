/** Detailed OpenAPI contracts layered over the exhaustive generated inventory. */

import {
  sdapiTxt2imgBodySchema,
  voiceSynthesizeBodySchema,
  zodToOpenApiSchema,
} from './apiContractSchemas.js';
import { writersRoomWorksQuerySchema, writersRoomWorksResponseSchema } from './pipelineValidation.js';
import { TTS_ENGINE_IDS } from './voiceEngines.js';
import { cosToolCallSchema } from './cosToolContracts.js';
import { agentContextMcpInboundSchema } from './agentContextValidation.js';

const jsonBody = (schema, required = true) => ({
  required,
  content: { 'application/json': { schema: zodToOpenApiSchema(schema) } },
});

export const API_OPERATION_CONTRACTS = Object.freeze({
  '/api/api-docs/openapi.json': {
    get: { summary: 'Read exposed OpenAPI document', responses: { 200: { description: 'OpenAPI 3.0.3 document for currently exposed external APIs' } } },
  },
  '/api/api-docs/internal/openapi.json': {
    get: { summary: 'Read complete internal OpenAPI document', responses: { 200: { description: 'OpenAPI 3.0.3 document for every mounted HTTP operation' } } },
  },
  '/api/api-docs/catalog.json': {
    get: { summary: 'Read HTTP API catalog', responses: { 200: { description: 'Searchable generated HTTP operation metadata and coverage' } } },
  },
  '/api/api-docs/events.json': {
    get: { summary: 'Read Socket.IO event catalog', responses: { 200: { description: 'Searchable generated Socket.IO event metadata and coverage' } } },
  },
  '/api/api-docs/asyncapi.json': {
    get: { summary: 'Read AsyncAPI document', responses: { 200: { description: 'AsyncAPI 3 document for the Socket.IO transport' } } },
  },
  '/api/api-docs/tools.min.json': {
    get: { summary: 'Read minimized semantic tool resource', responses: { 200: { description: 'Schema-optimized provider-neutral tool resource' } } },
  },
  '/api/writers-room/works': {
    get: {
      summary: 'List Writers Room works',
      description: 'No query returns the legacy array. Paging captures ordered membership for five minutes; echo nextCursor to continue. Deleted works are omitted; total describes original membership. Restart on CURSOR_EXPIRED.',
      parameters: Object.entries(writersRoomWorksQuerySchema.shape).map(([name, schema]) => ({
        name, in: 'query', required: false, schema: zodToOpenApiSchema(schema),
      })),
      responses: {
        200: { description: 'Legacy array or bounded snapshot page',
          content: { 'application/json': { schema: zodToOpenApiSchema(writersRoomWorksResponseSchema) } } },
        400: { description: 'Invalid paging query or cursor' },
        409: { description: 'Restart pagination', 'x-portos-error-codes': ['CURSOR_EXPIRED'] },
      },
    },
  },
  '/api/review/queue': {
    get: {
      summary: 'Read the cross-domain review action queue',
      description: 'Returns the canonical action projection. Passing limit opts into a short-lived snapshot; echo nextCursor unchanged for the next page. A null total means one or more sources are unavailable or bounded.',
      parameters: [
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
        { name: 'cursor', in: 'query', required: false, schema: { type: 'string', maxLength: 4096 } },
      ],
      responses: {
        200: { description: 'Canonical action rows, per-source health, totals, and an optional snapshot cursor' },
        400: { description: 'Invalid query or cursor', 'x-portos-error-codes': ['VALIDATION_ERROR', 'INVALID_CURSOR', 'CURSOR_QUERY_MISMATCH'] },
        409: { description: 'The short-lived snapshot expired and pagination must restart', 'x-portos-error-codes': ['CURSOR_EXPIRED'] },
      },
    },
  },
  '/api/agent-context/manifest': {
    get: { summary: 'Read local Agent Tools MCP manifest', responses: { 200: { description: 'MCP transport, context scopes, semantic grants, schemas, and limits' } } },
  },
  '/api/agent-context/mcp': {
    post: {
      summary: 'Call local Agent Tools MCP',
      description: 'Loopback-only, opt-in stateless MCP Streamable HTTP transport.',
      requestBody: jsonBody(agentContextMcpInboundSchema),
      responses: { 200: { description: 'JSON-RPC result' }, 202: { description: 'Notification accepted' }, 403: { description: 'Transport disabled or caller not local' } },
    },
  },
  '/api/voice/public/synthesize': {
    post: {
      summary: 'Synthesize speech',
      description: 'Convert text to spoken audio (WAV) using the selected engine and voice.',
      requestBody: jsonBody(voiceSynthesizeBodySchema),
      responses: {
        200: { description: 'WAV audio', content: { 'audio/wav': { schema: { type: 'string', format: 'binary' } } } },
        400: { description: 'Invalid payload or unknown voice', 'x-portos-error-codes': ['VALIDATION_ERROR', 'UNKNOWN_VOICE'] },
      },
      'x-portos-tool': {
        name: 'voice.synthesize', version: 1,
        policy: { privacy: 'personal', sideEffect: 'local-compute', async: false },
      },
    },
  },
  '/api/voice/public/voices': {
    get: {
      summary: 'List voices',
      description: 'Enumerate available voices for an engine. Defaults to the active engine.',
      parameters: [{ name: 'engine', in: 'query', required: false, schema: { type: 'string', enum: [...TTS_ENGINE_IDS] } }],
      responses: { 200: { description: 'Voice list', content: { 'application/json': { schema: { type: 'object' } } } } },
      'x-portos-tool': { name: 'voice.list-voices', version: 1, policy: { privacy: 'internal', sideEffect: 'read', async: false } },
    },
  },
  '/api/voice/public/engines': {
    get: {
      summary: 'List engines',
      description: 'Discover available TTS engines and the configured default voice per engine.',
      responses: { 200: { description: 'Engine list and defaults', content: { 'application/json': { schema: { type: 'object' } } } } },
      'x-portos-tool': { name: 'voice.list-engines', version: 1, policy: { privacy: 'internal', sideEffect: 'read', async: false } },
    },
  },
  '/sdapi/v1/txt2img': {
    post: {
      summary: 'Generate an image',
      description: 'AUTOMATIC1111-compatible text-to-image generation through the active PortOS image provider.',
      requestBody: jsonBody(sdapiTxt2imgBodySchema),
      responses: {
        200: { description: 'Generated images in AUTOMATIC1111 response format' },
        400: { description: 'Invalid generation payload', 'x-portos-error-codes': ['VALIDATION_ERROR'] },
        403: { description: 'A1111 API exposure is disabled' },
        500: { description: 'Generation failed or its output could not be read', 'x-portos-error-codes': ['GEN_FAILED', 'GEN_OUTPUT_MISSING'] },
        504: { description: 'Generation timed out', 'x-portos-error-codes': ['GEN_TIMEOUT'] },
      },
      'x-portos-tool': {
        name: 'image.generate', version: 1,
        policy: { privacy: 'personal', sideEffect: 'local-compute', async: true },
      },
    },
  },
  '/sdapi/v1/sd-models': {
    get: {
      summary: 'List image models',
      responses: {
        200: { description: 'Model catalog', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
        403: { description: 'A1111 API exposure is disabled' },
      },
      'x-portos-tool': { name: 'image.list-models', version: 1, policy: { privacy: 'internal', sideEffect: 'read', async: false } },
    },
  },
  '/sdapi/v1/samplers': {
    get: {
      summary: 'List samplers',
      responses: {
        200: { description: 'Sampler list', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
        403: { description: 'A1111 API exposure is disabled' },
      },
      'x-portos-tool': { name: 'image.list-samplers', version: 1, policy: { privacy: 'internal', sideEffect: 'read', async: false } },
    },
  },
  '/sdapi/v1/options': {
    get: {
      summary: 'Read active image options',
      responses: {
        200: { description: 'Active model and options', content: { 'application/json': { schema: { type: 'object' } } } },
        403: { description: 'A1111 API exposure is disabled' },
      },
      'x-portos-tool': { name: 'image.get-options', version: 1, policy: { privacy: 'internal', sideEffect: 'read', async: false } },
    },
    post: {
      summary: 'Acknowledge image options',
      description: 'Compatibility endpoint. PortOS does not switch its underlying model from this request.',
      responses: { 200: { description: 'Acknowledgement' } },
    },
  },
  '/sdapi/v1/progress': {
    get: {
      summary: 'Read generation progress',
      responses: {
        200: { description: 'Current generation progress or idle state', content: { 'application/json': { schema: { type: 'object' } } } },
        403: { description: 'A1111 API exposure is disabled' },
      },
      'x-portos-tool': { name: 'image.get-progress', version: 1, policy: { privacy: 'internal', sideEffect: 'read', async: false } },
    },
  },
  '/sdapi/v1/portos/video-models': {
    get: { summary: 'List PortOS video models', responses: { 200: { description: 'Video model catalog and default' } } },
  },
  '/api/cos/tools': {
    get: {
      summary: 'List semantic CoS tools',
      description: 'Return the provider-neutral tool catalog, optionally filtered and translated to OpenAI, Anthropic, or MCP syntax.',
      parameters: [
        { name: 'scope', in: 'query', schema: { type: 'string', enum: ['all', 'agent', 'mind', 'ui', 'voice'] } },
        { name: 'intent', in: 'query', schema: { type: 'string', maxLength: 500 } },
        { name: 'format', in: 'query', schema: { type: 'string', enum: ['portos', 'openai', 'anthropic', 'mcp'] } },
      ],
      responses: { 200: { description: 'Versioned semantic tool catalog' }, 304: { description: 'Catalog ETag is unchanged' } },
    },
  },
  '/api/cos/tools/call': {
    post: {
      summary: 'Call a semantic CoS tool',
      description: 'Execute one allowlisted tool. Mutations require a trusted authenticated UI session or process-local Persistent Mind authority.',
      requestBody: jsonBody(cosToolCallSchema),
      responses: {
        200: { description: 'Normalized tool result' },
        400: { description: 'Invalid call or arguments' },
        403: { description: 'Scope, capability, or authentication denied' },
        409: { description: 'Idempotency conflict' },
      },
    },
  },
  '/api/cos/tools/calls/:requestId': {
    get: {
      summary: 'Read a semantic tool result',
      description: 'Read the normalized result retained for a prior process-local request id.',
      responses: { 200: { description: 'Normalized tool result' }, 404: { description: 'Unknown or expired request id' } },
    },
  },
});

export const modeledApiOperationKeys = () => new Set(
  Object.entries(API_OPERATION_CONTRACTS).flatMap(([path, pathItem]) =>
    Object.keys(pathItem).map((method) => `${method.toUpperCase()} ${path}`)),
);
