/**
 * OpenAPI 3.1 spec builder for PortOS's public API surface.
 *
 * Native (no swagger-ui dependency): builds the document from the API registry
 * (server/lib/apiRegistry.js) plus per-path operation metadata declared here.
 * Request bodies reuse the same Zod schemas the routes validate against
 * (via `z.toJSONSchema`), so the docs can't drift from validation.
 *
 * Only APIs that are currently `exposed` appear in `paths`. An exposed API
 * with `requireAuth:true` gets a `security` requirement on each of its
 * operations; a passwordless one omits it (anonymous access allowed).
 */

import { z } from 'zod';
import { resolveApiAccess } from './apiRegistry.js';

// Request-body schema for POST /api/voice/public/synthesize. A LIGHT copy of
// the route's schema (routes/voicePublic.js) — kept here rather than imported
// because the route file pulls in heavy TTS service modules and this builder
// must stay a pure, dependency-light lib module. The two are asserted to
// produce identical JSON Schema by the parity test in openapiSpec.test.js, so
// they can't silently drift.
// `text` max mirrors MAX_PROACTIVE_TEXT_LEN (4000) used by the route. If that
// constant changes, the parity test in openapiSpec.test.js fails until this is
// updated to match — so the documented limit can't understate the real one.
// Mirrors the route schema field-for-field, including `.trim()` (which the
// route applies so whitespace-only text 400s). `.trim()` doesn't surface in
// `z.toJSONSchema` output, so the parity test can't catch its absence — keep
// it here by hand so the two definitions stay literally identical.
const synthesizeBodySchema = z.object({
  text: z.string().trim().min(1).max(4000),
  engine: z.enum(['kokoro', 'piper']).optional(),
  voice: z.string().max(128).optional(),
  // Range 0.25–4 is the validated bound (Piper honors the full range). Kokoro
  // clamps speed to 0.5–2.0 internally (tts-kokoro.js), so values outside that
  // are silently clamped when engine=kokoro — documented here so callers know.
  rate: z.number().min(0.25).max(4).optional()
    .describe('Speech rate. Validated 0.25–4 (Piper). Kokoro clamps to 0.5–2.0.'),
});

const jsonSchema = (schema) => {
  const s = z.toJSONSchema(schema);
  // OpenAPI 3.1 path objects don't want the top-level $schema dialect marker.
  delete s.$schema;
  return s;
};

// Per-path operation metadata, keyed by the path strings in API_REGISTRY's
// `docPaths`. A path absent here still appears as a bare documented path (so
// the registry stays the source of truth for WHICH paths exist) but with a
// generic description.
const OPERATIONS = {
  '/api/voice/public/synthesize': {
    post: {
      summary: 'Synthesize speech',
      description: 'Convert text to spoken audio (WAV) using the selected engine and voice.',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: jsonSchema(synthesizeBodySchema) } },
      },
      responses: {
        200: { description: 'WAV audio', content: { 'audio/wav': { schema: { type: 'string', format: 'binary' } } } },
        400: { description: 'Invalid payload or unknown voice' },
      },
    },
  },
  '/api/voice/public/voices': {
    get: {
      summary: 'List voices',
      description: 'Enumerate available voices for an engine (query param `engine`, default = active).',
      parameters: [{ name: 'engine', in: 'query', required: false, schema: { type: 'string', enum: ['kokoro', 'piper'] } }],
      responses: { 200: { description: 'Voice list' } },
    },
  },
  '/api/voice/public/engines': {
    get: {
      summary: 'List engines',
      description: 'Discover available TTS engines and the configured default voice per engine.',
      responses: { 200: { description: 'Engine list + defaults' } },
    },
  },
  '/sdapi/v1/txt2img': {
    post: { summary: 'Text-to-image (AUTOMATIC1111-compatible)', responses: { 200: { description: 'Generated image(s)' } } },
  },
  '/sdapi/v1/sd-models': { get: { summary: 'List image models', responses: { 200: { description: 'Model catalog' } } } },
  '/sdapi/v1/samplers': { get: { summary: 'List samplers', responses: { 200: { description: 'Sampler list' } } } },
  '/sdapi/v1/options': { get: { summary: 'Active model/options', responses: { 200: { description: 'Options' } } } },
  '/sdapi/v1/progress': { get: { summary: 'Generation progress', responses: { 200: { description: 'Progress' } } } },
};

// Attach a `security` requirement to every operation under a path item when the
// API requires auth. Passwordless APIs get an empty array (anonymous allowed).
const applySecurity = (pathItem, requireAuth) => {
  const out = {};
  for (const [method, op] of Object.entries(pathItem)) {
    out[method] = requireAuth ? { ...op, security: [{ bearerAuth: [] }, { basicAuth: [] }] } : { ...op, security: [] };
  }
  return out;
};

/**
 * Build the OpenAPI 3.1 document for the currently-exposed public APIs.
 * @param {object} settings full settings object (for resolveApiAccess)
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] server base URL (e.g. https://host:5555)
 * @param {string} [opts.version] PortOS version for info.version
 * @returns {object} OpenAPI 3.1 document
 */
export const buildOpenApiSpec = (settings, { baseUrl, version = '0.0.0' } = {}) => {
  const apis = resolveApiAccess(settings);
  const paths = {};
  const tags = [];

  for (const api of apis) {
    if (!api.exposed) continue;
    tags.push({ name: api.id, description: api.description });
    for (const path of api.docPaths) {
      const pathItem = OPERATIONS[path] || { get: { summary: path, responses: { 200: { description: 'OK' } } } };
      // Tag each operation with the API id so docs UIs can group them.
      const tagged = Object.fromEntries(
        Object.entries(pathItem).map(([method, op]) => [method, { tags: [api.id], ...op }]),
      );
      paths[path] = applySecurity(tagged, api.requireAuth);
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'PortOS Public API',
      version,
      description: 'Externally-callable PortOS services. Only APIs you have exposed in Settings → API Access appear here.',
    },
    servers: baseUrl ? [{ url: baseUrl }] : [],
    tags,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'PortOS session token (when the API requires auth).' },
        basicAuth: { type: 'http', scheme: 'basic', description: 'PortOS password via HTTP Basic (username ignored).' },
      },
    },
  };
};
