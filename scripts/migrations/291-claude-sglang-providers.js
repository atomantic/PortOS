/**
 * Ship disabled Claude-Code-against-SGLang provider presets to existing installs.
 *
 * SGLang serves an Anthropic-compatible `/v1/messages` endpoint with no extra flag, so the Claude Code harness can drive the local Qwen3.8-27B container, as Claude Ollama does with
 * the Ollama daemon (migration 146). These presets are ADDITIONAL to the OpenCode SGLang wrappers of migration 290: two harnesses over one daemon, picked per task.
 *
 * The env set carries three load-bearing, easy-to-get-wrong things:
 *   1. `CLAUDE_CODE_ATTRIBUTION_HEADER=0`: otherwise Claude Code prepends a per-request hash to the system prompt, the FIRST token to differ between turns, so SGLang's radix
 *      prefix cache misses and re-prefills the whole conversation (24x TTFT on the 3090 bring-up). `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` does NOT remove it; both are set.
 *   2. `ANTHROPIC_BASE_URL` is the server ROOT, NOT `…/v1`: the SDK appends `/v1/messages` itself and `/v1` 404s as "model not found". The `/v1` form lives on the record's
 *      `endpoint` (the OpenAI-compatible listing the readiness probe hits), so the two URLs differ deliberately.
 *   3. `ANTHROPIC_AUTH_TOKEN` must be non-empty (the SDK rejects an empty one before a request leaves the box; SGLang accepts any value unless started with `--api-key`).
 *      It ships in `secretEnvVars` as migration 284 did for Claude Ollama: a blank field is indistinguishable from an ambient override.
 *
 * Tool calls need SGLang's tool-call-parser flag on the serve line (`parserFlagsFor('sglang')` in server/lib/qwenAgentParsers.js, docs/features/local-llm-runtimes.md#sglang-on-hopper-or-blackwell); without it calls come back as raw text.
 * The model name carries NO `[1m]` suffix: native context is 262,144 and claiming the 1M beta without raising `--context-length` would mis-cap the window.
 *
 * Two deliberate divergences from the Claude Ollama pair:
 *   - **No thinking control.** The only per-request off switch is `chat_template_kwargs.enable_thinking`, which the Anthropic wire cannot carry (`MAX_THINKING_TOKENS=0` works on Ollama, not here),
 *     so the card offers no toggle (`generationControlsFor` in client/src/utils/providers.js); use the OpenCode wrappers or the serve line to turn thinking off.
 *   - **Non-lean.** These stay out of lean mode (`--bare --strict-mcp-config`): with 262,144 native context the environment is what lets a CoS agent type `/do:pr`, and a large prefix is free once the attribution header stops changing it.
 *
 * Both presets are DISABLED and this migration installs nothing (no image pull, weights, container or request). `sglangBacked: true` puts them under the same readiness probe and GPU-exclusivity rules as the OpenCode pair.
 *
 * Kept in lockstep with data.reference/providers.json and server/lib/aiToolkit/defaults/providers.sample.json. These frozen literals are the historical upgrade payload; later default changes need a new migration.
 */

import { makeProviderSeedMigration } from './_lib.js';

// The OpenAI-compatible listing endpoint the readiness probe and the GPU-blocker
// probe hit. Deliberately NOT the same string as ANTHROPIC_BASE_URL below.
const ENDPOINT = 'http://127.0.0.1:18021/v1';

const MODEL = 'qwen3.8-27b';

const ANTHROPIC_ENV = {
  // Server ROOT — the SDK appends /v1/messages. See the header note.
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:18021',
  ANTHROPIC_AUTH_TOKEN: 'sglang',
  // Reasoning plus a long CoS prompt runs well past the SDK's default deadline.
  API_TIMEOUT_MS: '3000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  // The prefix-cache flag. Do not drop it — see the header note.
  CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  // One served model, so every tier points at it; otherwise a haiku-tier
  // sub-call asks the container for a model it has never heard of.
  ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
  ANTHROPIC_SMALL_FAST_MODEL: MODEL,
};

const CLAUDE_SGLANG_CLI = {
  id: 'claude-sglang',
  name: 'Claude SGLang (Qwen3.8-27B)',
  type: 'cli',
  command: 'claude',
  args: ['--print'],
  endpoint: ENDPOINT,
  // Blank, and usually STAYS blank: this is the OpenAI-probe credential, which
  // SGLang requires only behind `--api-key`. The Anthropic-side token is the
  // non-empty ANTHROPIC_AUTH_TOKEN above and is a different thing.
  apiKey: '',
  models: [MODEL],
  defaultModel: MODEL,
  sglangBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { ...ANTHROPIC_ENV },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
  headlessArgs: ['--no-session-persistence', '--disable-slash-commands', '--tools', ''],
};

const CLAUDE_SGLANG_TUI = {
  id: 'claude-sglang-tui',
  name: 'Claude SGLang TUI (Qwen3.8-27B)',
  type: 'tui',
  command: 'claude',
  args: ['--dangerously-skip-permissions'],
  endpoint: ENDPOINT,
  apiKey: '',
  models: [MODEL],
  defaultModel: MODEL,
  sglangBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { ...ANTHROPIC_ENV },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'Claude SGLang (Qwen3.8-27B)',
  defs: [CLAUDE_SGLANG_CLI, CLAUDE_SGLANG_TUI],
});
