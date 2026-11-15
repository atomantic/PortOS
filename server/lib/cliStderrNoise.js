// The real Anthropic `claude` CLI logs this warning once per unrecognized model string whenever its
// SDK sees a `model` field it doesn't recognize as an Anthropic model.
//
// `isKnownCliStderrNoise(trimmedLine)` — drops the real Anthropic `claude` CLI's harmless
// `[claude-code:unrecognized_model]` SDK telemetry line, which fires on every claude-ollama /
// claude-ollama-tui run because those providers point the binary's `ANTHROPIC_BASE_URL` at a local
// Ollama model the SDK doesn't recognize.
//
// PortOS's claude-ollama / claude-ollama-tui providers deliberately redirect that binary's
// ANTHROPIC_BASE_URL at a local Ollama endpoint serving non-Anthropic models (e.g. "gemma3:27b"), so
// this fires on every run — it's harmless SDK telemetry, not a misconfiguration or error.
const CLAUDE_SDK_UNRECOGNIZED_MODEL_RE = /^\[claude-code:unrecognized_model\]/;

export function isKnownCliStderrNoise(trimmedLine) {
  return CLAUDE_SDK_UNRECOGNIZED_MODEL_RE.test(trimmedLine);
}
