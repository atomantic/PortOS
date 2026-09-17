import { z } from 'zod';
import { MAX_MODEL_ACCESS_PATTERNS, MAX_MODEL_ACCESS_PATTERN_LENGTH, MODEL_ACCESS_MODES } from './internal/modelAccess.js';
import { basename, extname } from 'path';
import { MAX_TIMEOUT, MIN_TIMEOUT } from './constants.js';
import { MAX_PROVIDER_REF_LENGTH, PRESET_ID_RE, PRESET_ONLY_MESSAGE, parseProviderRef } from './internal/providerRef.js';

/**
 * A run's provider selection: a preset record id or a composite reference the
 * host resolves through `resolveCompositeProvider` (#7564). Mirrors the host's
 * `providerRefSchema` (`server/lib/zodCompat.js`) over the vendored grammar.
 */
export const providerRefSchema = z.string().trim().min(1).max(MAX_PROVIDER_REF_LENGTH)
  .refine((value) => parseProviderRef(value) !== null, 'providerId must be a preset id or a composite <harness>.<cli|tui|api>@<service-slug>[+<bootstrap-slug>]');

// Image extensions a vision screenshot may carry. Mirrors the runner's
// getMimeType keys — anything else (or a no-extension path like `passwd`) is
// rejected.
const ALLOWED_SCREENSHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// Reasoning-effort values accepted by the effort-capable CLI providers. Keep
// this local because the vendored toolkit must remain self-contained; the
// runtime mirror lives in server/lib/providerModels.js and the UI mirror lives
// in client/src/utils/providerModels.js.
const PROVIDER_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const providerEffort = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.enum(PROVIDER_EFFORT_LEVELS).nullable().optional()
);

// Hardware metadata is declarative and machine-local. Keep the shape bounded
// so a provider record cannot turn into an unbounded arbitrary JSON payload.
const providerHardwareRequirementsSchema = z.object({
  platforms: z.array(z.string().trim().min(1).max(32)).min(1).max(8).optional(),
  architectures: z.array(z.string().trim().min(1).max(32)).min(1).max(8).optional(),
  requiresAppleSilicon: z.boolean().optional(),
  requiresNvidiaGpu: z.boolean().optional(),
  minMemoryGb: z.number().positive().max(4096).optional(),
  minVramGb: z.number().positive().max(4096).optional(),
  minCudaComputeCapability: z.number().positive().max(20).optional(),
}).strict();

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
  command: z.string().trim().optional(),
  args: z.array(z.string()).optional(),
  // CLI providers send `endpoint: ''` from the form; coerce empty/null to
  // undefined so the URL check only runs for actual values (API providers).
  endpoint: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.string().url().optional()
  ),
  apiKey: z.string().optional(),
  models: z.array(z.string()).optional(),
  // Optional hardware gates for local providers. The PortOS host decorates
  // responses with inferred runtime requirements as well, so old records do
  // not need a migration to participate in filtering.
  hardwareRequirements: providerHardwareRequirementsSchema.optional(),
  modelHardwareRequirements: z.record(providerHardwareRequirementsSchema).optional(),
  defaultModel: z.string().nullable().optional(),
  // Empty string is the UI's "use the provider/CLI default" sentinel.
  effort: providerEffort,
  lightModel: z.string().nullable().optional(),
  mediumModel: z.string().nullable().optional(),
  heavyModel: z.string().nullable().optional(),
  ultraModel: z.string().nullable().optional(),
  // PRESET-ONLY: the fallback chain reads `providers[fallbackProvider]` off the
  // stored map, where a composite never exists (#7564).
  fallbackProvider: z.string().regex(PRESET_ID_RE, PRESET_ONLY_MESSAGE).max(80).nullable().optional(),
  // Model to run on the fallback provider. The UI sends '' when no model is
  // pinned (fall back to the fallback provider's own default), so allow empty.
  fallbackModel: z.string().nullable().optional(),
  // Per-request context window (Ollama num_ctx). Lifts the ~4K default so long
  // prompts (e.g. a whole manuscript) aren't silently truncated. Null = unset.
  numCtx: z.number().int().min(512).max(1048576).nullable().optional(),
  // Default generation controls for the local OpenAI-compatible backends
  // (Ollama, llama.cpp, MTPLX, vLLM) and the OpenCode wrappers in front of them.
  // Provider-level so the same local model keeps its defaults across API, CLI,
  // and TUI launchers; a run may still override them per task.
  // All three are nullable, and null is the UI's "unset" — a backend that is
  // never told a temperature / top_p / thinking mode keeps its own, which is not
  // the same as being pinned to a value. Without a clearable null the editor
  // could only ever add a pin, never remove one.
  temperature: z.number().min(0).max(2).nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
  thinking: z.boolean().nullable().optional(),
  // Planning-time context window (tokens) the editorial budgeter may assume for
  // this provider — distinct from numCtx (what we *ask Ollama for*). For cloud
  // providers numCtx stays null and this reflects the model's real ceiling.
  contextWindow: z.number().int().min(512).max(2097152).nullable().optional(),
  // Per-model context windows READ FROM the provider's own `/models` catalog
  // (OpenRouter's `context_length`, vLLM's `max_model_len`, …), keyed by model
  // id. Written by model refresh, not typed by a human — it beats the hardcoded
  // model table and loses to the explicit `contextWindow` override above.
  // The ceiling is deliberately wider than `contextWindow`'s: that one bounds
  // what a person can type, this one has to accept whatever a vendor declares,
  // and rejecting a 10M-window model would 400 the whole provider write.
  modelContextWindows: z.record(z.number().int().min(512).max(33554432)).optional(),
  // Which of the provider's advertised catalog this install is entitled to
  // run — a plan/tier scope the upstream `/models` response does not declare
  // (internal/modelAccess.js). Applied on the way OUT to model pickers; the
  // stored `models` catalog is never narrowed by it. Nullable so the editor can
  // clear a policy back to "none" (absent means "unchanged" on a PATCH).
  modelAccess: z.object({
    mode: z.enum(MODEL_ACCESS_MODES),
    // An EMPTY list is valid and means "no constraint yet" — see the sentinel
    // note in internal/modelAccess.js. Rejecting it here would make the editor
    // unable to save the mode before the list is typed.
    patterns: z.array(z.string().trim().min(1).max(MAX_MODEL_ACCESS_PATTERN_LENGTH))
      .max(MAX_MODEL_ACCESS_PATTERNS).optional(),
  }).strict().nullable().optional(),
  timeout: z.number().int().min(MIN_TIMEOUT).max(MAX_TIMEOUT).optional(),
  enabled: z.boolean().optional(),
  // A CLI/TUI provider that can ALSO serve plain text through a non-HTTP
  // transport — today only `codex-app-server`, the ChatGPT-subscription
  // endpoint. A string rather than a boolean so a second transport is a new
  // value instead of a second flag that can contradict the first. Declaring it
  // only ADVERTISES the capability.
  textTransport: z.enum(['codex-app-server']).nullable().optional(),
  // The explicit opt-in that makes the advertised transport usable. Separate
  // from `enabled` (which governs the CLI harness) and defaulted off, so a
  // fresh install never bills a subscription for a background feature the user
  // has not knowingly pointed at it.
  textTransportEnabled: z.boolean().optional(),
  // The read-only sandbox blocks writes but not absolute-path reads. This
  // acknowledgement is separate from the enable flag so an API/client cannot
  // turn the transport on without recording the user's explicit consent.
  textTransportReadRiskAcknowledged: z.boolean().optional(),
  // Marks a `claude` CLI/TUI provider whose ANTHROPIC_BASE_URL points at a
  // local Ollama daemon — the "Claude Ollama" pattern. Drives model refresh to
  // pull tool-use-capable Ollama models instead of the static Anthropic list.
  ollamaBacked: z.boolean().optional(),
  // Marks a harness wrapper (OpenCode, and Codex via its native `--oss
  // --local-provider lmstudio`) whose backend is the LM Studio server on this
  // machine. Distinct from `ollamaBacked`: a different daemon, a different port,
  // and — unlike Ollama — a context window that is fixed when the model is
  // LOADED rather than settable per request, so PortOS prepares nothing before a
  // spawn (see `localRuntimeNamespace` in ../providerModels.js).
  lmstudioBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a separately started MTPLX native-MTP
  // server. This is intentionally distinct from `ollamaBacked`: model weights
  // and runtime protocol configuration are not interchangeable.
  mtplxBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a separately started local llama.cpp
  // server (e.g. DFlash 2 speculative decoding).
  llamaBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a separately started local vLLM
  // container serving Qwen3.8-27B with DFlash 2 drafting. Distinct from
  // `llamaBacked`: a different engine, a different port, and a different auth
  // story (vLLM is started behind an API key; llama-server is not).
  vllmBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a separately started local SGLang
  // container serving Qwen3.8-27B on a Hopper/Blackwell card. Distinct from
  // `vllmBacked`: a different engine, a different port, a different tool-call
  // parser, and an API key that is optional rather than required.
  sglangBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a hosted OpenAI-compatible gateway
  // ('orcarouter', 'openrouter', 'nvidia-nim' — see internal/gateways.js). Its API key is read
  // from the sibling API record of the SAME id at spawn/refresh time and is
  // never stored in this wrapper's config.
  gatewayBacked: z.string().optional(),
  // Legacy per-gateway marker, superseded by `gatewayBacked` and still read
  // forever — stored records are never rewritten (installs upgrade on their own
  // schedule, so an older peer/version must keep resolving its own data).
  orcarouterBacked: z.boolean().optional(),
  // Explicit opt-in to attach the provider's API key to an arbitrary
  // (non-local, non-allowlisted) endpoint. Guards against SSRF / key
  // exfiltration to a hostile or mistyped host — see
  // endpointGuard.js. Metadata endpoints stay blocked even when true.
  allowCustomEndpoint: z.boolean().optional(),
  // Pin a Codex CLI/TUI provider to PortOS's own account by appending
  // `--ignore-user-config` at spawn, so a bridge that re-pointed model routing
  // in the user's `~/.codex/config.toml` no longer decides where PortOS's runs
  // go. Default OFF: today's behavior (Codex reads the user's config) is the
  // one an existing install already relies on, and an override that silently
  // turned itself on would be its own surprise.
  ignoreUserConfig: z.boolean().optional(),
  // A CLI/TUI provider whose harness auth is provisioned by an external CLI at
  // spawn time (e.g. a short-lived token for a proxy) rather than a static
  // `apiKey` PortOS stores. PortOS spawns `command`(+`args`) in front of the
  // harness invocation instead of the harness directly — the generic
  // `<bootstrap> run <harness> ...` shape. `setupCommand` is advisory only
  // (shown to the user as a one-time step, e.g. installing the bootstrap CLI's
  // package) — PortOS never executes it. Nullable so the editor can explicitly
  // clear a previously-set bootstrap back to "none" (absent means "unchanged"
  // on a PATCH, which is not the same as clearing it).
  credentialBootstrap: z.object({
    setupCommand: z.string().trim().max(500).optional(),
    command: z.string().trim().min(1).max(200),
    args: z.array(z.string().max(200)).max(20).optional(),
    // What PortOS names the harness AS, when calling the bootstrap CLI — some
    // wrapper CLIs use their own identifier for a harness rather than its
    // binary name (e.g. `claude-code` where `command` is the binary `claude`).
    // Defaults to `command` when unset.
    harnessId: z.string().trim().min(1).max(100).optional(),
    // Inserted between the harness identifier and the harness's OWN args —
    // some wrapper CLIs need their own flags kept apart from the wrapped
    // program's (e.g. `<bootstrap> run <harness> -- <harness args>`).
    argsSeparator: z.string().trim().max(20).optional(),
  }).strict().nullable().optional(),
  envVars: z.record(z.string()).optional(),
  secretEnvVars: z.array(z.string()).optional(),
  headlessArgs: z.array(z.string()).optional(),
  tuiPromptDelayMs: z.number().int().min(250).max(60000).optional(),
  tuiIdleTimeoutMs: z.number().int().min(1000).max(86400000).optional()
});

/**
 * What ONE mode of a dual-mode create may set for itself.
 *
 * Every rule is taken from `providerSchema`'s own shape rather than restated,
 * so a bound the single-mode create enforces cannot quietly differ from the one
 * a pair create enforces. The set is deliberately small: anything NOT here is
 * shared by both records, which is what keeps the pair groupable
 * (`providerModeGroups` refuses siblings that disagree on command, endpoint,
 * credentials or env — the disjointness test in `validation.test.js` pins that
 * these keys stay clear of {@link MODE_GROUPED_KEYS}).
 */
const providerModeOverrideSchema = z.object({
  args: providerSchema.shape.args,
  headlessArgs: providerSchema.shape.headlessArgs,
  tuiPromptDelayMs: providerSchema.shape.tuiPromptDelayMs,
}).strict();

/** The keys {@link providerModeOverrideSchema} lets a mode vary. */
export const PROVIDER_MODE_OVERRIDE_KEYS = Object.freeze(Object.keys(providerModeOverrideSchema.shape));

/**
 * POST /api/providers — the create body, which may declare BOTH execution modes
 * of one harness instead of forcing the user to add the CLI and the TUI
 * separately and hope the two records happen to pair.
 *
 * Both keys are required: declaring a single mode is what `type` is for, so the
 * map's presence IS the "make me a pair" request. An empty `cli: {}` is the
 * normal case — the body's own `args` / `headlessArgs` already describe the CLI
 * record, and the key is there so the pair is declared rather than inferred.
 *
 * This `modes` is a per-mode MAP, where `POST /api/providers/bindings` takes a
 * plain array of mode names, because the two creates get their argv from
 * different places: a binding mints from the harness's shipped command recipe,
 * while a provider added here has no recipe at all — the user types each mode's
 * arguments, and they need somewhere to land.
 *
 * Create-only, and deliberately absent from `providerSchema` itself: pairing
 * describes two records being MINTED together, which a PATCH against one
 * existing record cannot mean, so the PATCH route's `providerSchema.partial()`
 * drops the key instead of half-acting on it.
 */
export const providerCreateSchema = providerSchema.extend({
  modes: z.object({
    cli: providerModeOverrideSchema,
    tui: providerModeOverrideSchema,
  }).strict().optional(),
});


// PUT /api/providers/active — set the active provider by id. Constrain to the
// same slug shape createProvider assigns (`providerSchema.id`) so a reserved
// key like `__proto__` can't reach the `data.providers[id]` lookup in
// setActiveProvider (which walks the prototype chain and would otherwise treat
// `__proto__` as an existing provider and persist it as active).
export const providerActiveSchema = z.object({
  id: z.string().regex(PRESET_ID_RE, PRESET_ONLY_MESSAGE).max(80)
});

export const runSchema = z.object({
  // `type` defaults to 'ai' so the common case (AI run via /api/runs from
  // RunnerPage / AIProviders / etc.) doesn't have to send it explicitly.
  type: z.enum(['ai', 'command']).optional().default('ai'),
  providerId: providerRefSchema.optional(),
  model: z.string().optional(),
  workspacePath: z.string().optional(),
  workspaceName: z.string().optional(),
  command: z.string().optional(),
  prompt: z.string().optional(),
  screenshots: z.array(z.string()).optional(),
  timeout: z.number().int().min(MIN_TIMEOUT).max(MAX_TIMEOUT).optional()
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
