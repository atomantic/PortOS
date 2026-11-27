/** Detect provider refusals, local runtime failures and truncated or overloaded model responses. */
import { ERROR_CATEGORIES } from './categories.js';

// Provider error vocabulary, shared by streaming chrome and terminal analysis.
const CONTENT_REFUSAL_PATTERN = /limited access to this content for safety|may be used to benefit or to harm|content[_ ]policy[_ ]violation|stop_reason["']?\s*:\s*["']?refusal|"type"\s*:\s*"refusal"|"codex(?:_error_info|ErrorInfo)"\s*:\s*"(?:cyber_policy|cyberPolicy|misalignment_policy_violation|misalignmentPolicyViolation)"|This\s*content\s*(?:was\s*flagged\s*for\s*possible\s*cybersecurity\s*risk|can[’']t\s*be\s*shown)/i;

export const isContentRefusalError = (err) => (
  err?.errorAnalysis?.category === ERROR_CATEGORIES.CONTENT_REFUSAL
  || err?.context?.category === ERROR_CATEGORIES.CONTENT_REFUSAL
  || CONTENT_REFUSAL_PATTERN.test(err?.message || '')
);

/** A bounded Codex chrome detector; ordinary mentions/quoted JSON are not chrome. */
export function createContentRefusalDetector() {
  let buffer = '';
  let truncated = false;
  return (chunk) => {
    const next = `${buffer}${String(chunk || '')}`;
    if (next.length > 4096) truncated = true;
    buffer = next.slice(-4096);
    // Keep cursor moves to column 1 as row boundaries before removing styles.
    // Flattening the PTY first loses the distinction between chrome and quoted
    // text. Buffer raw bytes so a split escape sequence remains parseable.
    const screen = buffer.replace(/\x1b\[\d+;1H/g, '\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const bounded = truncated ? `x${screen}` : screen;
    if (!/^[ \t]*ⓘ\s*This\s*content\s*can[’']t\s*be\s*shown/im.test(bounded)) return null;
    return {
      hasError: true, category: ERROR_CATEGORIES.CONTENT_REFUSAL,
      message: 'Codex stopped this request on cybersecurity/content policy grounds.',
      requiresFallback: false, actionable: false, permanent: true,
      origin: 'provider',
      suggestedFix: 'Review the refusal. Automatic continuation, retries and provider fallback are disabled.',
    };
  };
}

// A LOCAL inference runtime that ran out of accelerator memory mid-request.
//
// Observed shape (MTPLX/MLX behind an OpenAI-compatible server, rendered inside
// OpenCode's error box, hard-wrapped by the TUI):
//
//     {"message":"[METAL] Command buffer execution failed: Insufficient Memory
//     (00000008: kIOGPUCommandBufferCallbackErrorOutOfMemory).","type":
//     "server_error","code":"RuntimeError","param":null}
//
// Every alternative below is a single unbroken token or a short phrase that a
// TUI wraps at a space, so the pattern survives the box-drawing glyphs and
// newlines the renderer injects INSIDE the JSON. That is also why this pattern
// is deliberately NOT line-anchored the way the agy banners are: there is no
// line start to anchor to once the envelope is wrapped across four rows.
//
// The precision comes from the strings themselves — these are vendor error
// constants, not English an agent writes by accident. The residual
// false-positive surface is an agent QUOTING one (working on this file, or
// investigating this very failure), and the consumer bounds that cost: the
// agent-TUI path only nudges a session that has ALREADY gone silent, and only
// fails the run after three such nudges (see createOomNudgeGate).
const LOCAL_RUNTIME_OOM_PATTERN = new RegExp([
  'kIOGPUCommandBufferCallbackErrorOutOfMemory',
  '\\[METAL\\]\\s*Command buffer execution failed',
  'CUDA (?:error: )?out of memory',
  'torch\\.(?:cuda\\.)?OutOfMemoryError',
  'CUDA_ERROR_OUT_OF_MEMORY',
].join('|'), 'i');

/**
 * Detect a LOCAL inference runtime that ran out of accelerator memory
 * mid-request (see LOCAL_RUNTIME_OOM_PATTERN for the observed shape).
 *
 * Deliberately NOT an entry in IMMEDIATE_FALLBACK_SIGNALS, for the same reason
 * detectTerminalModelError is kept out of it: that list is consulted by every
 * TUI/CLI spawn path, and a `graceMs` entry there would arm the self-clearing
 * gate in the ONE-SHOT runner too — where a false "recovered" latch finalizes a
 * run as a success that scraped the error screen. This failure needs a
 * different remedy anyway. The provider did not REJECT the submission the way
 * agy's eligibility banner does; it accepted the turn and the device allocator
 * killed it, so the TUI session still holds the whole conversation and only
 * needs a continuation. Re-sending the whole prompt through the self-clearing
 * gate would instead restart the
 * task on top of the work already done.
 *
 * Only `agentTuiSpawning` consults this, through `createOomNudgeGate`.
 *
 * @returns {object|null} an analysis in the same shape
 *   `detectImmediateFallbackSignal` returns, so the caller can hand it straight
 *   to its fail-over path once the nudges are spent.
 */
export function detectLocalRuntimeOom(text) {
  if (!text) return null;
  // `.test` rather than `.match`: only the yes/no matters, and the pattern
  // carries no `g` flag, so there is no `lastIndex` to leak between calls.
  if (!LOCAL_RUNTIME_OOM_PATTERN.test(String(text))) return null;
  return {
    hasError: true,
    // A FIXED sentence, deliberately not the vendor text that was matched.
    // This message becomes the run's error string, which becomes a failure
    // reason a CoS task description can go on to quote — and a TUI echoes a
    // pasted prompt back into this very detector. Quoting the vendor constant
    // here would let the signal re-match its own propagated message and nudge
    // (then fail) the agent dispatched to investigate it. agy's quota banner
    // solves the same problem with a lookahead; a fixed message is the simpler
    // answer when the analysis doesn't need the original text.
    category: ERROR_CATEGORIES.RESOURCE_EXHAUSTED,
    message: 'Local inference runtime ran out of GPU memory',
    waitTime: null,
    requiresFallback: true,
    // Nothing in PortOS config is wrong and nobody has to fix anything: the
    // device was momentarily short of memory. Marking it actionable would BLOCK
    // the task (see agentErrorAnalysis#resolveFailedTaskDecision) over a
    // condition a fallback provider can serve right now.
    actionable: false,
    graceMs: 0,
    suggestedFix: 'The local inference runtime ran out of GPU memory. Retry once the device drains, shrink the context/KV cache, or run a smaller model.',
    // Genuine evidence about the provider host: this endpoint's GPU is short of
    // memory, so benching it briefly (RESOURCE_EXHAUSTED in
    // providerCooldown.js) routes the retry somewhere that can serve it.
    origin: 'provider',
  };
}

export function createLocalRuntimeOomDetector({ maxBuffer = 512 } = {}) {
  let buffer = '';
  const cap = Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 512;

  return (chunk) => {
    if (!chunk) return null;
    buffer = `${buffer}${String(chunk)}`.slice(-cap);
    return detectLocalRuntimeOom(buffer);
  };
}

// A TUI harness that cut the model's response off mid-generation. pi's TUI
// halts the whole session on `Response was truncated before completion.` —
// the turn is dead, but the session still holds the whole conversation, and a
// human typing `continue` (Enter) resumes it every time. Unattended, nothing
// ever types that word: the run sits at the halted screen until the generic
// stall gate's ten-minute silence threshold, if it fires at all.
//
// The wording is vendor chrome, but it is English rather than a vendor error
// constant, so the pattern spells the whole sentence with `\s+` joins — a TUI
// hard-wraps at spaces, and the join lets a wrap survive where a literal
// space would not. The residual false-positive surface (an agent QUOTING the
// banner) is bounded by the consumer exactly as the OOM gate bounds its own:
// the nudge fires only once the session has already gone quiet, and the run
// fails over only after the truncations outlast every nudge
// (createTruncationNudgeGate in ../tuiHandshake.js).
//
// Deliberately NOT an entry in IMMEDIATE_FALLBACK_SIGNALS, for the same reason
// detectLocalRuntimeOom is not: that list arms the self-clearing gate in the
// one-shot runner too, whose remedy (re-pasting the whole prompt) would restart
// the task on top of work already done. The remedy here is a one-word
// continuation, and only `agentTuiSpawning` consults this.
//
// `category` reuses the agent-analysis `output-length` vocabulary on purpose:
// a truncated response is a response-ceiling failure, so it inherits that
// category's entire downstream policy — the SCHEMA_TYPE fix tier with its
// compaction hints, and no provider bench (a provider that truncates one
// over-long response serves every other prompt fine; see
// isRequestSpecificCategory in lib/provider/providerCooldown.js).
const TRUNCATED_RESPONSE_PATTERN = /response\s+was\s+truncated\s+before\s+completion/i;

export function detectTruncatedResponse(text) {
  if (!text) return null;
  if (!TRUNCATED_RESPONSE_PATTERN.test(String(text))) return null;
  return {
    hasError: true,
    category: 'output-length',
    // A FIXED sentence, deliberately not the banner wording — the message
    // becomes the run's error string, which a CoS task description can quote
    // back through this very detector (same reasoning as detectLocalRuntimeOom).
    message: 'Provider cut the response off before completion',
    waitTime: null,
    requiresFallback: true,
    actionable: false,
    graceMs: 0,
    suggestedFix: 'The provider truncated the response mid-generation. A continue nudge resumes the session; if it keeps truncating, route the task to a fallback provider or reduce the requested response size.',
    origin: 'provider',
  };
}

export function createTruncatedResponseDetector({ maxBuffer = 512 } = {}) {
  let buffer = '';
  const cap = Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 512;

  return (chunk) => {
    if (!chunk) return null;
    buffer = `${buffer}${String(chunk)}`.slice(-cap);
    return detectTruncatedResponse(buffer);
  };
}

// A provider that rejected the turn because the selected model is overloaded
// (Codex: `Selected model is at capacity. Please try a different model.`). The
// turn is dead but the session still holds the conversation, and a human typing
// `continue` a little later resumes it. Unattended, nothing types it: the run
// sits at the composer holding its lane. Same remedy as the
// truncation banner, but the cause is load on the provider, so the consumer's
// gate waits much longer between nudges (createModelCapacityNudgeGate).
//
// `\s+` joins survive a TUI hard-wrap. Not an IMMEDIATE_FALLBACK_SIGNALS entry
// for the same reason as the truncation banner: the remedy is a continuation,
// not a restart or an instant provider swap.
const MODEL_AT_CAPACITY_PATTERN = /selected\s+model\s+is\s+at\s+capacity/i;

export function detectModelAtCapacity(text) {
  if (!text) return null;
  if (!MODEL_AT_CAPACITY_PATTERN.test(String(text))) return null;
  return {
    hasError: true,
    category: ERROR_CATEGORIES.RATE_LIMIT,
    // FIXED sentence, not the banner wording: it becomes the run error and a
    // task description can quote it back through this detector.
    message: 'Provider reported the selected model is overloaded',
    waitTime: null,
    requiresFallback: true,
    actionable: false,
    graceMs: 0,
    suggestedFix: 'The selected model is temporarily at capacity. A delayed continue nudge resumes the session; if it stays overloaded, route the task to a fallback provider.',
    origin: 'provider',
  };
}

export function createModelAtCapacityDetector({ maxBuffer = 512 } = {}) {
  let buffer = '';
  const cap = Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : 512;

  return (chunk) => {
    if (!chunk) return null;
    buffer = `${buffer}${String(chunk)}`.slice(-cap);
    return detectModelAtCapacity(buffer);
  };
}

export const contentRefusalRule = {
  // High-precision markers for a model safety/content refusal. Codex (OpenAI)
  // returns "Invalid prompt: we've limited access to this content for safety
  // reasons. This type of information may be used to benefit or to harm…";
  // Anthropic surfaces a `refusal` stop reason. Matched FIRST so a refusal is
  // never misclassified as an auth/unknown failure that would bench the
  // provider and queue a CoS investigation task.
  pattern: CONTENT_REFUSAL_PATTERN,
  category: ERROR_CATEGORIES.CONTENT_REFUSAL,
  requiresFallback: false,
  actionable: false,
  suggestedFix: 'Stopped after a content/safety refusal. Review the refusal; no automatic retry or provider fallback.'
};

export const localOomRule = {
  // A local inference server (MTPLX/MLX, vLLM, llama.cpp, Ollama) whose device
  // allocator failed mid-request. Matched BEFORE the generic network/timeout
  // clauses so a post-hoc scan of a failed run's output labels it for what it
  // is instead of landing in UNKNOWN. Shares its source with
  // LOCAL_RUNTIME_OOM_PATTERN so the streaming detector and the post-hoc scan
  // can never drift apart.
  pattern: LOCAL_RUNTIME_OOM_PATTERN,
  category: ERROR_CATEGORIES.RESOURCE_EXHAUSTED,
  requiresFallback: true,
  actionable: false,
  suggestedFix: 'The local inference runtime ran out of GPU memory. Retry once the device drains, shrink the context/KV cache, or run a smaller model.'
};

export const ollamaToolCallRule = {
  // Ollama's per-model output parser rejected tool-call markup the MODEL
  // emitted mid-stream (Inkling2: `invalid Inkling2 tool name "x.y" for
  // header "toolCalls"` when the model opened a native tool frame whose
  // header disagrees with its body; other parsers: `invalid tool call JSON`,
  // `qwen3.5 tool call parsing failed`). The daemon is healthy and serves the
  // next prompt fine, so this is one malformed RESPONSE: `parse-error` keeps
  // it in the schema/type tier and out of the provider bench
  // (isRequestSpecificCategory in lib/provider/providerCooldown.js), where
  // UNKNOWN benched Ollama for every caller and escalated straight to an
  // investigation. Anchored on the prefix only ../ollamaNativeChat.js
  // writes, so an agent transcript that merely mentions a tool call can't match.
  pattern: /Ollama stream error:[^\n]*\btool[ _-]?(?:call|name)\b/i,
  category: 'parse-error',
  requiresFallback: true,
  actionable: false,
  suggestedFix: 'The model emitted malformed tool-call markup that Ollama could not parse. Retry the request; a model that keeps doing this needs a prompt that asks for plain-text output.'
};

export const modelCapacityRule = {
  // Codex's transient model-capacity rejection is not a credential or
  // billing problem. Let the existing rate-limit recovery choose a fallback.
  pattern: /^(?:ERROR:\s*)?Selected model is at capacity\. Please try a different model\.[ \t]*$/im,
  category: ERROR_CATEGORIES.RATE_LIMIT,
  requiresFallback: true,
  actionable: false,
  suggestedFix: 'Selected model is temporarily at capacity. Retry later or use a different model.'
};

export const codexModelAccessRule = {
  // Codex authenticated successfully, but the selected model is outside this
  // ChatGPT account's access. This is request-specific, not a broken login
  // or an exhausted subscription; other models may still run.
  pattern: /model is not supported when using Codex with a ChatGPT account/i,
  category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
  requiresFallback: true,
  actionable: true,
  suggestedFix: 'Choose a model supported by the signed-in Codex account, or clear the model override to use the CLI default. Changing to API-key authentication uses separate API billing.'
};

export const unknownArchitectureRule = {
  // llama.cpp's load-time refusal of a GGUF whose `general.architecture` it
  // was built without, as relayed by Ollama, LM Studio or llama-server. The
  // weights and the daemon are both fine; only this model needs a newer
  // runtime build, so it is request-specific like a missing model id rather
  // than an UNKNOWN that escalates to an investigation task.
  pattern: /unknown model architecture/i,
  category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
  requiresFallback: true,
  actionable: true,
  suggestedFix: 'This runtime\'s llama.cpp build predates the model\'s architecture. Update the runtime (Ollama, LM Studio\'s llama.cpp engine, or llama-server) to a release that supports it, then retry.'
};

export const unsupportedModelRule = {
  // "model identifier is invalid" is Bedrock's wording when the runner passes
  // a model id the backend doesn't recognize (e.g. a bare Anthropic id like
  // `claude-opus-5` to a Bedrock-backed Claude Code, which wants
  // `global.anthropic.claude-opus-5`). Categorize it alongside the
  // not-found/invalid-model phrasings so the cooldown + fallback path treats
  // it as the config problem it is.
  // `"<model>" does not support chat` is Ollama's 400 when a request routes a
  // model at an endpoint it doesn't serve — the everyday case being an
  // embedding-only model (nomic-embed-text, bge-*, mxbai-embed-*) reached
  // through /api/chat. It names no "model" token, so the clauses above miss
  // it and it used to land in UNKNOWN: a 1-minute bench of a perfectly
  // healthy daemon plus a tier-4 investigation task. It is the same class of
  // fault as an unknown model id — this request named the wrong model for
  // this endpoint — so it belongs here, where the cooldown treats it as
  // request-specific and tier 1 corrects the model instead. The other
  // operations Ollama names the same way (`insert`, `tools`, `thinking`) are
  // the same fault — a model asked for something it cannot do — and were
  // still landing in UNKNOWN.
  pattern: /model.*(not found|does not exist|unavailable)|invalid model|model identifier is invalid|does not support (?:chat|generate|completions?|embeddings?|insert|tools|thinking)/i,
  category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
  requiresFallback: true,
  actionable: true,
  suggestedFix: 'Check model name and availability in provider settings'
};
