import { z } from 'zod';

export const providerSchema = z.object({
  // Sample providers post a stable id (e.g. 'codex') so the server can adopt
  // them verbatim rather than slugifying the display name (which would turn
  // 'Codex CLI' into 'codex-cli' and break id-keyed CLI argument handling).
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase alphanumeric with hyphens').max(80).optional(),
  name: z.string().min(1).max(100),
  type: z.enum(['cli', 'api', 'tui']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  // CLI providers send `endpoint: ''` from the form; coerce empty/null to
  // undefined so the URL check only runs for actual values (API providers).
  endpoint: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.string().url().optional()
  ),
  apiKey: z.string().optional(),
  models: z.array(z.string()).optional(),
  defaultModel: z.string().nullable().optional(),
  lightModel: z.string().nullable().optional(),
  mediumModel: z.string().nullable().optional(),
  heavyModel: z.string().nullable().optional(),
  fallbackProvider: z.string().nullable().optional(),
  // Model to run on the fallback provider. The UI sends '' when no model is
  // pinned (fall back to the fallback provider's own default), so allow empty.
  fallbackModel: z.string().nullable().optional(),
  // Per-request context window (Ollama num_ctx). Lifts the ~4K default so long
  // prompts (e.g. a whole manuscript) aren't silently truncated. Null = unset.
  numCtx: z.number().int().min(512).max(1048576).nullable().optional(),
  // Planning-time context window (tokens) the editorial budgeter may assume for
  // this provider — distinct from numCtx (what we *ask Ollama for*). For cloud
  // providers numCtx stays null and this reflects the model's real ceiling.
  contextWindow: z.number().int().min(512).max(2097152).nullable().optional(),
  timeout: z.number().int().min(1000).max(1800000).optional(),
  enabled: z.boolean().optional(),
  envVars: z.record(z.string()).optional(),
  secretEnvVars: z.array(z.string()).optional(),
  headlessArgs: z.array(z.string()).optional(),
  tuiPromptDelayMs: z.number().int().min(250).max(60000).optional(),
  tuiIdleTimeoutMs: z.number().int().min(10000).max(1800000).optional()
});

export const runSchema = z.object({
  // `type` defaults to 'ai' so the common case (AI run via /api/runs from
  // RunnerPage / AIProviders / etc.) doesn't have to send it explicitly.
  type: z.enum(['ai', 'command']).optional().default('ai'),
  providerId: z.string().optional(),
  model: z.string().optional(),
  workspacePath: z.string().optional(),
  workspaceName: z.string().optional(),
  command: z.string().optional(),
  prompt: z.string().optional(),
  screenshots: z.array(z.string()).optional(),
  timeout: z.number().int().min(1000).max(1800000).optional()
});

export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.errors.map(e => ({
      path: e.path.join('.'),
      message: e.message
    }))
  };
}
