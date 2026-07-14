import { z } from 'zod';
import { basename, extname } from 'path';

// Image extensions a vision screenshot may carry. Mirrors the runner's
// getMimeType keys — anything else (or a no-extension path like `passwd`) is
// rejected.
const ALLOWED_SCREENSHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * Sanitize the untrusted `screenshots[]` array from POST /api/runs into safe,
 * screenshots-dir-relative basenames. `screenshots[]` is unauthenticated user
 * input passed to the vision loader, which base64-encodes each image and
 * forwards it to the configured external provider — so without this an entry
 * like `../../../../etc/passwd` or an absolute `/etc/passwd` would exfiltrate an
 * arbitrary readable file (issue #1870, the sibling of the #1820 vision-test
 * fix). `basename` collapses every directory component (neutralizing `../`
 * traversal AND absolute-path escapes, including the legitimate absolute paths
 * the RunnerPage uploads under data/screenshots) and the extension allow-list
 * rejects non-image references before any file is read. Lives here (not the
 * shared loadImageAsBase64) so trusted in-process callers that pass validated
 * absolute paths from other image roots — e.g. Universe Builder gallery images
 * under data/images — keep working; only the HTTP boundary is constrained.
 *
 * @param {unknown} screenshots
 * @returns {{ safe: string[], rejected: string[] }}
 */
export function sanitizeScreenshotRefs(screenshots) {
  const safe = [];
  const rejected = [];
  if (!Array.isArray(screenshots)) return { safe, rejected };
  for (const entry of screenshots) {
    if (typeof entry !== 'string' || !entry) {
      rejected.push(String(entry));
      continue;
    }
    const name = basename(entry);
    if (!name || name === '.' || name === '..' ||
        !ALLOWED_SCREENSHOT_EXTENSIONS.has(extname(name).toLowerCase())) {
      rejected.push(entry);
      continue;
    }
    safe.push(name);
  }
  return { safe, rejected };
}

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
  // Marks a `claude` CLI/TUI provider whose ANTHROPIC_BASE_URL points at a
  // local Ollama daemon — the "Claude Ollama" pattern. Drives model refresh to
  // pull tool-use-capable Ollama models instead of the static Anthropic list.
  ollamaBacked: z.boolean().optional(),
  // Explicit opt-in to attach the provider's API key to an arbitrary
  // (non-local, non-allowlisted) endpoint. Guards against SSRF / key
  // exfiltration to a hostile or mistyped host — see
  // internal/endpointGuard.js. Metadata endpoints stay blocked even when true.
  allowCustomEndpoint: z.boolean().optional(),
  envVars: z.record(z.string()).optional(),
  secretEnvVars: z.array(z.string()).optional(),
  headlessArgs: z.array(z.string()).optional(),
  tuiPromptDelayMs: z.number().int().min(250).max(60000).optional(),
  tuiIdleTimeoutMs: z.number().int().min(10000).max(1800000).optional(),
  // Absolute wall-clock ceiling for a long-running TUI agent (idle-reap can't
  // bound a busy-but-stuck agent — see DEFAULT_TUI_MAX_RUNTIME_MS). Min 1min,
  // max 12h to cover the longest legitimate multi-hour orchestration.
  tuiMaxRuntimeMs: z.number().int().min(60000).max(43200000).optional()
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
    errors: result.error.issues.map(e => ({
      path: e.path.join('.'),
      message: e.message
    }))
  };
}
