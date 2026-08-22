/**
 * Ship disabled Claude-Code-against-SGLang provider presets to existing installs.
 *
 * SGLang serves an Anthropic-compatible `/v1/messages` endpoint on every server
 * with no extra flag, so the Claude Code harness can drive the local
 * Qwen3.8-27B container directly — the same trick Claude Ollama plays with the
 * Ollama daemon (migration 146). vLLM cannot do this (OpenAI-only), which is why
 * the Ampere/3090 stack stays OpenCode-only. These presets are ADDITIONAL to the
 * OpenCode SGLang wrappers of migration 290, not a replacement: OpenCode and
 * Claude Code are two harnesses over one daemon, and an operator picks per task.
 *
 * The env set carries three things that are easy to get wrong, and all three are
 * load-bearing:
 *
 *   1. `CLAUDE_CODE_ATTRIBUTION_HEADER=0` — without it Claude Code prepends a
 *      per-request hash to the system prompt. That hash is the FIRST token to
 *      differ between turns, so SGLang's radix prefix cache misses and re-prefills
 *      the entire conversation every turn. The 3090 bring-up measured a 24× TTFT
 *      difference between a prefix-cache hit and a miss. Note that
 *      `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` does NOT remove the attribution
 *      block — it is a separate flag and both are set here.
 *   2. `ANTHROPIC_BASE_URL` is the server ROOT (`http://127.0.0.1:18021`), NOT
 *      `…/v1`. The Anthropic SDK appends `/v1/messages` itself; pointing it at
 *      `/v1` 404s in a way that reads as "model not found". The `/v1` form lives
 *      on the record's `endpoint` field instead, which is the OpenAI-compatible
 *      listing the readiness probe hits — the two URLs are deliberately different.
 *   3. `ANTHROPIC_AUTH_TOKEN` must be non-empty. SGLang accepts any value unless
 *      the operator started it with `--api-key`, but an empty token is rejected
 *      by the SDK before a request leaves the box. It ships in `secretEnvVars`
 *      for the same reason migration 284 put Claude Ollama's there: a blank field
 *      would otherwise be indistinguishable from an ambient override.
 *
 * Tool calls additionally need SGLang's tool-call-parser flag on the serve line,
 * which the runtime owns — the one place that spelling lives is
 * `parserFlagsFor('sglang')` in server/lib/qwenAgentParsers.js (see
 * docs/features/sglang-qwen38.md). Without it the schemas are accepted but calls
 * come back as raw text and Claude Code executes nothing.
 *
 * The model name carries NO `[1m]` suffix: native context is 262,144, and
 * claiming the 1M beta while the serve line does not raise `--context-length`
 * would cap the window incorrectly in the other direction.
 *
 * Two deliberate divergences from the Claude Ollama pair they mirror:
 *
 *   - **No thinking control.** Qwen3.8-27B thinks by default and the only
 *     per-request off switch is `chat_template_kwargs.enable_thinking`, which the
 *     Anthropic wire cannot carry. `MAX_THINKING_TOKENS=0` works on Ollama (its
 *     endpoint maps an omitted `thinking` field to non-thinking mode) but not
 *     here, so the provider card offers no toggle for these records — see
 *     `generationControlsFor` in client/src/utils/providers.js. Use the OpenCode
 *     wrappers, or the serve line, when a run needs thinking off.
 *   - **Non-lean.** `isOllamaClaudeProvider` puts Claude Ollama in lean mode
 *     (`--bare --strict-mcp-config`) because a 7B model drowns in the full
 *     personal environment. These presets stay non-lean on purpose: 262,144
 *     native context, the environment is what lets a CoS agent type `/do:pr`,
 *     and a large prefix is free once the attribution header stops changing it
 *     between turns.
 *
 * Both presets are DISABLED and this migration installs nothing — no image pull,
 * no weights, no container, no request to the endpoint. `sglangBacked: true`
 * puts them under the same readiness probe and GPU-exclusivity rules as the
 * OpenCode pair, so both harnesses are understood as one daemon.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. These frozen literals are
 * the historical upgrade payload; later default changes require a new migration
 * rather than rewriting this record.
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
