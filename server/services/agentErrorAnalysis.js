/**
 * Agent Error Analysis
 *
 * Pattern-based failure analysis, investigation task creation, and
 * failed-task status resolution for CoS agents.
 */

import { emitLog } from './cosEvents.js';
import { addTask, updateTask } from './cos.js';
import { cosEvents } from './cosEvents.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';
import { redactOutput } from '../lib/commandSecurity.js';
import { stripAnsi } from '../lib/ansiStrip.js';
import { describeOllamaContextOverflow, parseOllamaContextOverflow } from '../lib/ollamaContext.js';
import { retryHoldMetadata } from '../lib/taskRetryHold.js';
import { TUI_TOOL_PERMISSION_PROMPT_PATTERN } from '../lib/tuiHandshake.js';
import {
  INVESTIGATION_CIRCUIT_MAX_CREATIONS,
  INVESTIGATION_HEADLINE_PREFIX,
  INVESTIGATION_TASK_DELIVERY,
  LOOP_REASON_PROSE,
  MAX_AUTO_RETRIES_PER_TASK,
  buildInvestigationFingerprint,
  isInvestigationTask,
  resolveInvestigationApproval,
} from '../lib/investigationTasks.js';
import { investigationCircuitOpen, noteInvestigationFiled, readAllTasksFlat, recentInvestigationCreations } from './investigationTaskProducer.js';
import { PRIMARY_CHECKOUT_MUTATED_CATEGORY, PRIMARY_CHECKOUT_MUTATED_ESCALATION, PRIMARY_CHECKOUT_MUTATED_REASON } from '../lib/primaryCheckoutGuard.js';
import { isPortosSuppliedConfigKey } from '../lib/providerModels.js';

// Max retries before blocking a task
export const MAX_TASK_RETRIES = 3;

// Longest redacted failure snippet folded into a human-facing investigation body.
const SNIPPET_MAX_CHARS = 240;

// Longest accepted-values list echoed back in a `cli-config-invalid` fix. Codex
// enumerates every variant it accepts ("expected one of `minimal`, `low`, …"),
// which is useful at a glance and unreadable at full length.
const CONFIG_EXPECTED_MAX_CHARS = 120;

// Machine-identity / network / PII fragments stripped before a captured failure
// snippet (or any interpolated free text) lands in a human-facing — and possibly
// federated — investigation task body. See the "Sensitive Data & Privacy" section
// in AGENTS.md: the *shape* of the failure is what a human needs, never the live
// hostnames, paths, addresses, or secrets pulled off the running instance.
const SNIPPET_REDACTIONS = [
  // Home-dir paths that embed an OS username → strip the user segment only.
  // Handles both POSIX (`/Users/alice`) and Windows (`C:\Users\alice`) checkouts.
  [/[\\/](Users|home)[\\/][^\\/\s"']+/gi, '/$1/<user>'],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
  // Tailscale MagicDNS / mDNS hostnames — consume ALL leading labels so a
  // multi-label name like `machine.tailnet.ts.net` doesn't leak `machine`.
  [/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:ts\.net|local)\b/gi, '<host>'],
  // IPv4 addresses (LAN / Tailscale / public alike).
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<ip>'],
  // Bearer tokens and common secret-key formats.
  [/\bbearer\s+[\w.\-/+=]{12,}/gi, 'bearer <token>'],
  [/\bsk-[A-Za-z0-9\-_]{16,}/g, '<token>'],
];

/**
 * Redact machine identity, network info, PII, and secrets from free text before
 * it is embedded in an investigation-task body. Also normalizes whitespace and
 * caps length so a captured multi-line snippet stays a single readable line.
 * Pure — safe to unit-test directly.
 */
export function redactFailureSnippet(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  let out = redactOutput(text); // JSON secret key/value pairs
  for (const [re, replacement] of SNIPPET_REDACTIONS) out = out.replace(re, replacement);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > SNIPPET_MAX_CHARS ? `${out.slice(0, SNIPPET_MAX_CHARS)}…` : out;
}

// Hard ceiling on the raw snippet captured off the analysis window. The
// human-facing body re-truncates to SNIPPET_MAX_CHARS, but the analysis object
// itself is PERSISTED verbatim into the agent's metadata.json — an unbounded
// snippet wrote an 816KB blob into a single failed TUI agent's record (a 1.28MB
// metadata.json) because a repaint-driven PTY transcript has almost no newlines,
// so "the line containing the match" was the whole session. Keep enough context
// to read the failure, never enough to bloat the record.
export const SNIPPET_RAW_MAX_CHARS = 400;

// Extract the single output line containing `index` — the matched failure line
// makes the most useful snippet without dragging in surrounding noise. Bounded
// on BOTH sides of the match so a newline-free buffer (raw PTY output) yields a
// readable excerpt instead of the entire stream.
function snippetAround(text, index) {
  const lineStart = text.lastIndexOf('\n', index) + 1; // -1 → 0 (first line)
  const nl = text.indexOf('\n', index);
  const lineEnd = nl === -1 ? text.length : nl;
  // Anchor the window on the match itself, not the line start: on a very long
  // line the match can sit thousands of chars in, and a head-anchored slice
  // would cut away the very text that classified the failure.
  const half = Math.floor(SNIPPET_RAW_MAX_CHARS / 2);
  const start = Math.max(lineStart, index - half);
  const end = Math.min(lineEnd, start + SNIPPET_RAW_MAX_CHARS);
  return text.slice(start, end).trim();
}

/**
 * Error patterns that warrant investigation tasks.
 * Patterns are checked in order — first match wins.
 * Categories help the learning system identify failure trends.
 *
 * Provenance (#2642): a pattern may carry a structured `origin`
 * (`'provider'` | `'runner'`) declaring that a match comes from a genuine
 * provider/runner signal (an `API Error: NNN` line, a Node error code, a
 * provider-specific error token) rather than the loose regex sweep over agent
 * output. When the same regex mixes a structured alternative with a loose
 * keyword alternative (e.g. `API Error: 429` vs a bare `rate limit`), a
 * `structuredMarker` sub-pattern gates the promotion: the structured `origin`
 * is only honored when the marker is present in the matched text; otherwise the
 * match is treated as `'output-scan'` (see `resolvePatternOrigin`). Patterns
 * with no `origin` are always `'output-scan'`. Task-learning's environmental
 * exclusion (metrics.js) diverts only non-`output-scan` failures, so a failing
 * test whose tail prints "rate limit" is NOT misread as an infra outage.
 */
export const ERROR_PATTERNS = [
  // ===== CLI Config Errors =====
  // A provider CLI that refuses to START because its own config file is
  // invalid. Codex reads `~/.codex/config.toml` (plus any `-c key=value`
  // override) BEFORE it reads the prompt, so an unaccepted value kills every
  // attempt identically — the run burns all three retries and the agent never
  // gets a single token in. Listed first: the message is unmistakable, and
  // untriaged it landed in the `unknown` bucket (Tier 4 escalate), which spawns
  // an investigation task for what is a one-line config edit (real incident
  // 2026-08-17: `model_reasoning_effort = "max"`, a variant codex does not
  // accept, sitting in the global config). Deliberately does NOT echo the
  // matched path — it embeds the OS username (see Sensitive Data & Privacy in
  // AGENTS.md).
  //
  // The rejected key can come from either side, and the fix text says which
  // (see `extract`): PortOS injects only PORTOS_CLI_CONFIG_KEYS via `-c`, so
  // any other key is already in the user's own config file. Second real
  // incident, 2026-08-18: the Codex desktop app wrote `service_tier =
  // "default"` into the shared `~/.codex/config.toml`, and the older
  // `codex` on PATH — the one PortOS spawns — accepts only `fast` or `flex`.
  // Blaming a PortOS override there burns an investigation cycle in the wrong
  // repo.
  {
    pattern: /(?:error loading )?config\.toml(?::\d+:\d+)?:\s*unknown (variant|field) `([^`]+)`(?:,\s*expected ([^\n]+))?(?:[\s\S]{0,200}?in `([^`]+)`)?/i,
    category: 'cli-config-invalid',
    actionable: true,
    origin: 'runner', // fully structured — the CLI's own config-load rejection
    escalation: 'Edit the CLI config (or the PortOS override that produced it) so the rejected key holds a value the CLI accepts, then approve the retry.',
    extract: (match) => {
      const kind = match[1].toLowerCase();
      const value = match[2];
      // The CLI already printed the values it WILL accept ("expected `fast` or
      // `flex`"). Fold them into the fix so it is directly actionable, instead
      // of "its own error message lists them" — which sends the reader back to
      // a log the escalation card never shows. Redacted like every other
      // free-text capture (this body can federate) and capped, since some keys
      // enumerate a long ladder.
      const expected =
        redactFailureSnippet(match[3] || '')
          .replace(/[.,;]+$/, '')
          .slice(0, CONFIG_EXPECTED_MAX_CHARS) || null;
      const key = match[4] || null;
      const keyRef = key ? `\`${key}\`` : 'the rejected key';
      const accepts = expected ? ` This CLI version expects ${expected}.` : '';
      // Provenance is the whole fix here. PortOS emits exactly two `-c` config
      // keys (PORTOS_CLI_CONFIG_KEYS); anything else was already sitting in the
      // user's own config file — commonly written there by a NEWER install of
      // the same CLI sharing that file. Real incident 2026-08-18: the Codex
      // desktop app wrote `service_tier = "default"` into `~/.codex/config.toml`
      // and the older `codex` on PATH rejects that variant. Naming the wrong
      // source costs a whole investigation cycle, so say which one it is.
      const source = !key
        ? `Look first in the CLI's own config file — for codex that is \`~/.codex/config.toml\` — then in the \`-c <key>=<value>\` overrides PortOS builds in server/lib/providerModels.js.`
        : isPortosSuppliedConfigKey(key)
          ? `PortOS supplies ${keyRef} itself as a \`-c <key>=<value>\` override, so the accepted values belong in that provider's ladder in server/lib/providerModels.js — editing the CLI config file will not help.`
          : `PortOS never supplies ${keyRef}, so it is already in the CLI's own config file — for codex that is \`~/.codex/config.toml\`. Edit or delete that line, or upgrade this CLI to a version that accepts the value; a second, newer install of the same CLI sharing one config file is the usual source.`;
      return {
        message: `Provider CLI rejected its config: unknown ${kind} "${value}"${key ? ` for ${key}` : ''}`,
        suggestedFix: `The CLI failed while LOADING its config, before the prompt was read, so every retry dies identically. Set ${keyRef} to a value this CLI version accepts.${accepts} ${source}`,
        rejectedConfigKey: key,
        rejectedConfigValue: value,
        rejectedConfigExpected: expected
      };
    }
  },
  {
    // Anything else that stops the CLI at config load — a TOML syntax error, an
    // unreadable file — same blast radius and same Tier 1 fix, without the
    // key/value detail the pattern above extracts.
    pattern: /error loading config\.toml/i,
    category: 'cli-config-invalid',
    actionable: true,
    origin: 'runner',
    escalation: 'Fix the provider CLI config file it failed to load, then approve the retry.',
    extract: () => ({
      message: 'Provider CLI could not load its config file',
      suggestedFix: 'The CLI failed while loading its own config (for codex, `~/.codex/config.toml`), before the prompt was read — every retry fails the same way until the file parses. Check it for a syntax error or a key this CLI version no longer accepts.'
    })
  },
  {
    // The CLI rejected the ARGV PortOS built, before reading the prompt — a flag
    // that is unknown, or (the common one) legal only in another mode. Same Tier
    // 1 blast radius as a bad config file: every retry dies identically in a few
    // seconds, so it belongs up here with the other pre-prompt rejections.
    //
    // Registering it also stops a subtler failure. A TUI run that dies this
    // early has NOTHING in its transcript but the shell's echo of the argv, so
    // the loose sweep below classifies the run off PortOS's own launch flags —
    // `--mcp-config '{"mcpServers":{}}'` filed a Stage 3 pr-reviewer run as
    // "MCP server error" three times running while the real line, one row down,
    // read `--no-session-persistence can only be used with --print mode`
    // (agent-a12b1837). The flag name is echoed because it is PortOS-authored
    // argv, never user data.
    pattern: /(?:^|\n|\bError:\s*)(--[a-z0-9][a-z0-9-]*)\s+(?:can only be used with\s+([^\n]{1,80})|is (?:not a known|an unknown|not a valid)[^\n]{0,60})/i,
    category: 'cli-config-invalid',
    actionable: true,
    origin: 'runner', // fully structured — the CLI's own argv rejection
    escalation: 'Correct the flag set PortOS builds for this provider/posture in server/lib/providerVendors.js, then approve the retry.',
    extract: (match) => {
      const flag = match[1];
      const requires = redactFailureSnippet(match[2] || '').replace(/[.,;]+$/, '').slice(0, CONFIG_EXPECTED_MAX_CHARS);
      return {
        message: `Provider CLI rejected the flag ${flag}`,
        suggestedFix: `The CLI exited while parsing its arguments, before the prompt was delivered, so every retry fails identically.${requires ? ` It reports that \`${flag}\` only works with ${requires}.` : ''} PortOS builds this argv itself — fix the posture/vendor recipe in server/lib/providerVendors.js (an attachable \`tuiSpawnArgs\` recipe must drop every flag that requires \`--print\`), not the provider record.`,
        rejectedCliFlag: flag
      };
    }
  },

  // ===== API & Authentication Errors =====
  {
    pattern: /API Error: 404.*model:\s*(\S+)/i,
    category: 'model-not-found',
    actionable: true,
    origin: 'provider', // fully structured — requires an `API Error: 404 … model:` line
    escalation: 'Set a valid model id for this task (or clear its model override so the CLI falls back to its own configured default), then approve the retry.',
    extract: (match, output, task, model) => ({
      message: `Model "${match[1]}" not found`,
      suggestedFix: `Update model configuration - "${match[1]}" doesn't exist. Check provider settings or task metadata.`,
      affectedModel: match[1],
      configuredModel: model
    })
  },
  {
    pattern: /(?:model:\s*)?["']?([A-Za-z0-9._:-]+)["']?\s+model is not supported|model\s+["']?([A-Za-z0-9._:-]+)["']?.*not supported/i,
    category: 'model-not-supported',
    actionable: true,
    // Intentionally no structured origin (#2642): the matched text is just the
    // "<model> model is not supported" phrase — a test asserting that string is
    // indistinguishable from a genuine provider rejection here, so it stays
    // output-scan. Real provider model rejections still divert via the structured
    // `API Error: 4NN`/`not_found_error` patterns and `detectTerminalModelError`.
    escalation: 'Pick a model the provider account supports (or clear the override to use the CLI default), then approve the retry.',
    extract: (match, output, task, model) => ({
      message: `Model "${match[1] || match[2] || model || 'configured model'}" is not supported`,
      suggestedFix: 'Update the provider model configuration or leave the model blank so the CLI can use its own configured default.',
      affectedModel: match[1] || match[2] || model,
      configuredModel: model
    })
  },
  {
    // The Claude Code CLI's own startup rejection of `--model <id>`, printed
    // before any API call is made — so it never carries an `API Error: 4NN`
    // token and matched none of the model patterns above. Untriaged it landed in
    // the `unknown` bucket ("Error did not match known patterns"), which is Tier
    // 4 (escalate) in autoFixer's map: the task burned all three retries against
    // an id that can never work and then spawned an investigation task, instead
    // of getting the Tier 1 config/env correction a model rejection deserves.
    // Structured enough to promote to `origin: 'provider'` — the full sentence
    // with the parenthesised id and the `--model` hint is CLI banner text, not
    // something a task's own output prints in passing.
    pattern: /There's an issue with the selected model \(([^)]+)\)/i,
    category: 'model-not-found',
    actionable: true,
    origin: 'provider',
    structuredMarker: /There's an issue with the selected model \([^)]+\)[\s\S]{0,120}?(?:may not exist|--model)/i,
    escalation: 'Set a model id this provider actually serves for the task (or clear its model override so the CLI uses its own default), then approve the retry.',
    extract: (match, output, task, model) => ({
      message: `Model "${match[1]}" rejected by the CLI - it may not exist or the account lacks access`,
      suggestedFix: `The CLI does not accept "${match[1]}". Check that the task's model override matches the provider it is running on, or clear the override so the CLI falls back to its own default.`,
      affectedModel: match[1],
      configuredModel: model
    })
  },
  {
    pattern: /API Error: 401|authentication|unauthorized/i,
    category: 'auth-error',
    actionable: true,
    origin: 'provider',
    structuredMarker: /API Error:\s*401/i, // loose `authentication`/`unauthorized` in output stays output-scan
    extract: () => ({
      message: 'Authentication failed',
      suggestedFix: 'Check API keys and provider configuration'
    })
  },
  {
    pattern: /API Error: 429|rate.?limit|too many requests/i,
    category: 'rate-limit',
    actionable: false, // Transient, retry will handle
    origin: 'provider',
    structuredMarker: /API Error:\s*429/i, // a bare `rate limit` / `too many requests` in output stays output-scan
    extract: () => ({
      message: 'Rate limit exceeded',
      suggestedFix: 'Wait and retry - temporary rate limiting'
    })
  },
  {
    // Catches both "hit your usage limit" and session limits like "hit your limit · resets 6am"
    pattern: /(?:hit your (?:usage )?limit|usage.?limit|quota exceeded|Upgrade to Pro|upgrade your subscription to increase your limits|plan.?limit|daily.?limit|session.?limit|\d+-hour limit reached|(?:^|\n)\s*(?:\[stderr\]\s*)?Now using extra usage\s*(?:\r?\n|$))/i,
    category: 'usage-limit',
    actionable: true, // Need to switch provider
    // Promote only the distinctive provider-billing idioms (the matched
    // alternative, i.e. match[0]) to a structured provider signal; generic
    // phrasings like "quota exceeded" / "plan limit" / "daily limit" that a task's
    // own output can print stay output-scan and count as genuine failures (#2642).
    origin: 'provider',
    // The vendor-branded "<Product> usage limit reached" and "<N>-hour limit
    // reached" banners belong here too: they are the wordings Claude Code and its
    // siblings actually print, and WITHOUT them a genuine 5-hour window stayed
    // `origin: 'output-scan'` — which agentFinalization's provenance gate does not
    // bench, so every subsequent dequeue re-picked the dead provider and died the
    // same way. They stay distinctive enough that a task's own output does not
    // trip them (unlike the bare `quota exceeded` / `plan limit` alternatives,
    // which remain deliberately unpromoted).
    //
    // Antigravity's `⚠ <Whose> quota reached. Please upgrade your subscription to
    // increase your limits. Resets in 3h51m14s.` is the same case: the bare
    // "quota reached" half is generic, but the upgrade sentence is vendor
    // wording. WITHOUT it a spent agy subscription matched no alternative at
    // all, stayed `unknown`, and left agy unbenched — so a series-autopilot run
    // burned both foundation-judge attempts on the dead provider and reported the
    // resulting screen scrape as a placeholder rubric (2026-08-13). The banner
    // itself is caught in-stream by AGY_QUOTA_BANNER in aiToolkit/errorDetection.js.
    structuredMarker: /hit your (?:usage )?limit|(?:usage|session) limit reached|\d+-hour limit reached|Upgrade to Pro|upgrade your subscription to increase your limits|Now using extra usage/i,
    extract: (match, output) => {
      const timeMatch = output.match(/(?:try again in|resets?)\s+(.+?)(?:\.|·|\n|$)/im);
      const waitTime = timeMatch ? timeMatch[1].trim() : null;
      return {
        message: `Usage limit exceeded${waitTime ? ` - retry in ${waitTime}` : ''}`,
        suggestedFix: 'Provider usage limit reached. Using fallback provider or wait for limit reset.',
        waitTime,
        requiresFallback: true
      };
    }
  },
  {
    // Ollama's own overflow rejection. Must sit AHEAD of `bad-request` (it
    // arrives as `API Error: 400`) and of the generic `context-length` rule
    // below, which misses it entirely — Ollama says "context size", not
    // "context length". Worth its own category because the fix is the opposite
    // of both: the task isn't too big and the request isn't malformed — a
    // 256K-capable model was LOADED at 32K, because Ollama picks the runtime
    // window from VRAM and an agent harness talking to it directly can't ask
    // for more. Splitting the task (the generic rule's advice) just loses the
    // work again next run; raising the provider's num_ctx is what fixes it.
    // See server/lib/ollamaContext.js.
    pattern: /exceed_context_size_error|exceeds the available context size/i,
    category: 'ollama-context-window',
    actionable: true,
    origin: 'provider',
    escalation: 'Approve raising the Ollama-backed provider\'s "Local num_ctx" (AI Providers → the provider → Context Window) so PortOS reloads the daemon at a larger window, then retry.',
    extract: (match, output, task, model) => {
      const overflow = parseOllamaContextOverflow(output) || {};
      return {
        message: `Ollama context window exhausted (${overflow.contextLength ?? 'unknown'} tokens)`,
        suggestedFix: describeOllamaContextOverflow(overflow, { model }),
        affectedContextLength: overflow.contextLength ?? null,
        requestedTokens: overflow.promptTokens ?? null
      };
    }
  },
  {
    // Ollama's capability rejection: the request asked a model for something its
    // manifest doesn't declare — for an agent harness, almost always
    // `API Error: 400 registry.ollama.ai/library/gemma3:27b does not support tools`.
    // Must sit AHEAD of `bad-request`, which it arrives as, and which draws
    // exactly the wrong conclusion: "check prompt formatting, tool names, and
    // parameter sizes" sends the retry (and the investigation task it spawns)
    // after a malformed request, when the request was fine and the MODEL simply
    // cannot emit tool calls. No amount of reformatting fixes that; only picking
    // a tool-capable model does, so this is a Tier 1 config correction, not a
    // Tier 2 schema/type one.
    //
    // Categorized `model-not-found` to mirror the identical clause in
    // aiToolkit/errorDetection.js (the API path) — same fault, same vocabulary,
    // and the category is REQUEST-specific in providerCooldown, so a healthy
    // Ollama daemon serving other tool-capable models is not benched for naming
    // one model that can't.
    //
    // Anchored on the `API Error: 4NN` line rather than the bare phrase: this
    // file's rules sweep the whole transcript, and "does not support tools" is
    // a sentence an agent working on this very code writes in passing.
    pattern: /API Error:\s*4\d\d[\s\S]{0,200}?["']?([\w.\-/:]+)["']?\s+does not support\s+(tools|thinking|insert|chat|generate|completions?|embeddings?)\b/i,
    category: 'model-not-found',
    actionable: true,
    origin: 'provider',
    escalation: 'Point this task at a model whose backend reports the missing capability (Ollama tags tool-callers with a `tools` capability), then approve the retry.',
    extract: (match, output, task, model) => {
      // Ollama echoes the fully-qualified registry path; the bare tag is what a
      // provider's model field actually holds.
      const affected = match[1].replace(/^.*\/library\//, '');
      const capability = match[2].toLowerCase();
      const forTools = capability === 'tools';
      return {
        message: `Model "${affected}" does not support ${capability}`,
        suggestedFix: forTools
          ? `"${affected}" cannot emit native tool calls, and an agent run is nothing but tool calls — every retry dies identically no matter how the prompt is written. Point this task's provider at a tool-capable model (AI Providers → the provider → Model; the Local LLMs tab marks these "🔧 tool use") and retry.`
          : `The backend serving "${affected}" reports no "${capability}" capability, so this request can never succeed against it. Pick a model that declares it, or route this task to a provider that does.`,
        affectedModel: affected,
        affectedCapability: capability,
        configuredModel: model
      };
    }
  },
  {
    pattern: /API Error: 400|invalid_request_error|bad.?request/i,
    category: 'bad-request',
    actionable: true,
    extract: (match, output) => {
      const msgMatch = output.match(/"message":\s*"([^"]{1,150})"/);
      return {
        message: `Bad request${msgMatch ? `: ${msgMatch[1]}` : ''}`,
        suggestedFix: 'API rejected the request as invalid. Check prompt formatting, tool names, and parameter sizes.'
      };
    }
  },
  {
    pattern: /API Error: 403|forbidden/i,
    category: 'forbidden',
    actionable: true,
    origin: 'provider',
    structuredMarker: /API Error:\s*403/i, // loose `forbidden` in output stays output-scan
    extract: () => ({
      message: 'API access forbidden',
      suggestedFix: 'API key lacks permission for this operation. Check API key permissions and provider configuration.'
    })
  },
  {
    pattern: /API Error: 5\d{2}|server error|internal error/i,
    category: 'server-error',
    actionable: false, // Transient
    extract: () => ({
      message: 'API server error',
      suggestedFix: 'Retry later - temporary server issue'
    })
  },
  {
    pattern: /not_found_error.*model/i,
    category: 'model-not-found',
    actionable: true,
    origin: 'provider', // structured provider `not_found_error` API token
    extract: (match, output, task, model) => ({
      message: `Model not found in API response`,
      suggestedFix: `The model "${model}" specified for this task doesn't exist. Update provider or task configuration.`,
      configuredModel: model
    })
  },

  // ===== Context & Token Errors =====
  {
    // Claude Code's own terminal output-ceiling banner. This exact wording is
    // structured harness chrome, so it may override an idle-reaper verdict;
    // otherwise the empty composer that follows gets blamed on whichever phase
    // marker happened to be latched from the repainted prompt. Keep this ahead
    // of the generic token/context patterns and require the env-var guidance so
    // ordinary agent prose about output limits stays an output-scan match.
    pattern: /Claude's response exceeded the \d+ output token maximum[\s\S]{0,240}?CLAUDE_CODE_MAX_OUTPUT_TOKENS/i,
    category: 'output-length',
    actionable: false,
    origin: 'provider',
    structuredMarker: /API Error:\s*Claude's response exceeded the \d+ output token maximum[\s\S]{0,240}?CLAUDE_CODE_MAX_OUTPUT_TOKENS/i,
    extract: (match, output) => ({
      message: 'Output length exceeded',
      suggestedFix: 'Claude Code exhausted its response ceiling. Retry with a larger CLAUDE_CODE_MAX_OUTPUT_TOKENS value or reduce the requested response.',
      compaction: {
        needed: true,
        reason: 'output-limit',
        outputSize: Buffer.byteLength(output || ''),
        retryHints: [
          'Limit output to changed files and a brief summary only',
          'Do not echo file contents back — just reference file paths and line numbers',
          'Combine related changes into single descriptions'
        ]
      }
    })
  },
  {
    pattern: /context.?length|max.?tokens|token.?limit|context.?window/i,
    category: 'context-length',
    actionable: true,
    escalation: 'Approve splitting the original task into smaller subtasks (or route it to a larger-context model), then retry — the retry already carries compaction hints.',
    extract: (match, output) => ({
      message: 'Context length exceeded',
      suggestedFix: 'Task is too large for the context window. Break into smaller subtasks or use a model with larger context.',
      compaction: {
        needed: true,
        reason: 'context-limit',
        outputSize: Buffer.byteLength(output || ''),
        retryHints: [
          'Summarize intermediate findings concisely instead of reproducing full file contents',
          'Use targeted reads (offset/limit) instead of reading entire files',
          'Avoid listing full directory trees — only reference files you modify',
          'Keep your Task Summary under 30 lines'
        ]
      }
    })
  },
  {
    pattern: /output.?length|max.?output|response.?too.?long/i,
    category: 'output-length',
    actionable: false,
    extract: (match, output) => ({
      message: 'Output length exceeded',
      suggestedFix: 'Agent response exceeded output limit. Task may need to be scoped down.',
      compaction: {
        needed: true,
        reason: 'output-limit',
        outputSize: Buffer.byteLength(output || ''),
        retryHints: [
          'Limit output to changed files and a brief summary only',
          'Do not echo file contents back — just reference file paths and line numbers',
          'Combine related changes into single descriptions'
        ]
      }
    })
  },

  // ===== Tool & MCP Errors =====
  {
    pattern: /tool.?(?:call|use|execution).?(?:failed|error)|failed to (?:call|execute|invoke) tool/i,
    category: 'tool-error',
    actionable: false,
    extract: (match, output) => {
      const toolMatch = output.match(/tool[:\s]+["']?(\w+)["']?/i);
      return {
        message: `Tool execution failed${toolMatch ? `: ${toolMatch[1]}` : ''}`,
        suggestedFix: 'Tool call failed. Check if required dependencies/services are running.'
      };
    }
  },
  {
    // `MCP` as a standalone WORD followed by error prose on the same line. The
    // previous shape — `MCP.?(?:server|connection|error)` — treated `.` as "any
    // character", so it matched the `"mcpServers"` key inside the empty
    // `--mcp-config '{"mcpServers":{}}'` object PortOS puts on every Claude
    // public-review argv. That is the OPPOSITE of an MCP failure (it is how
    // PortOS says "load no MCP servers at all"), and a run that died before
    // producing anything but its own echoed command line was filed as an MCP
    // outage three times running (agent-a12b1837). So: `\b…\b` rejects
    // `mcpServers`, the `(?![-\w])` rejects the `--mcp-config` /
    // `--strict-mcp-config` flag spellings, and the lookahead demands actual
    // failure prose nearby rather than a mere mention.
    pattern: /\bmcp\b(?![-\w])(?=[^\n]{0,120}\b(?:error|errored|failed|failure|unavailable|disconnected|refused|crashed|timed out|timeout|not (?:available|running|found|connected))\b)/i,
    category: 'mcp-error',
    actionable: false,
    extract: () => ({
      message: 'MCP server error',
      suggestedFix: 'MCP server connection failed. Verify MCP servers are configured and accessible.'
    })
  },
  {
    pattern: /permission.?denied|access.?denied|not.?allowed|insufficient.?permissions/i,
    category: 'permission-denied',
    actionable: true,
    extract: () => ({
      message: 'Permission denied',
      suggestedFix: 'Agent lacks permissions for the requested operation. Check file/directory permissions.'
    })
  },

  // ===== Git & Repository Errors =====
  {
    pattern: /git.?(?:conflict|merge.?conflict)|CONFLICT.*both modified|merge.?failed/i,
    category: 'git-conflict',
    actionable: true,
    extract: () => ({
      message: 'Git merge conflict',
      suggestedFix: 'Merge conflict detected. Resolve conflicts manually before retrying.'
    })
  },
  {
    pattern: /fatal:\s*(?:not a git repository|could not|failed to|unable to)/i,
    category: 'git-error',
    actionable: false,
    extract: (match, output) => {
      const detailMatch = output.match(/fatal:\s*(.+?)(?:\n|$)/i);
      return {
        message: `Git error${detailMatch ? `: ${detailMatch[1].substring(0, 60)}` : ''}`,
        suggestedFix: 'Git operation failed. Verify the repository state and try again.'
      };
    }
  },
  {
    pattern: /nothing.?to.?commit|no.?changes|working.?tree.?clean/i,
    category: 'no-changes',
    actionable: false,
    extract: () => ({
      message: 'No changes to commit',
      suggestedFix: 'Agent completed but made no code changes. Task may already be done or description needs clarification.'
    })
  },

  // ===== Build & Test Errors =====
  {
    pattern: /npm.?ERR!|yarn.?error|pnpm.?(?:ERR|error)/i,
    category: 'npm-error',
    actionable: false,
    extract: (match, output) => {
      const errMatch = output.match(/(?:npm|yarn|pnpm).?(?:ERR!|error)[:\s]*(.+?)(?:\n|$)/i);
      return {
        message: `Package manager error${errMatch ? `: ${errMatch[1].substring(0, 50)}` : ''}`,
        suggestedFix: 'Package installation or script failed. Check package.json and dependencies.'
      };
    }
  },
  {
    pattern: /test.?(?:failed|failure)|(?:failed|failing).?tests?|FAIL\s+\w+\.test/i,
    category: 'test-failure',
    actionable: false,
    extract: () => ({
      message: 'Tests failed',
      suggestedFix: 'One or more tests failed. Review test output and fix failing assertions.'
    })
  },
  {
    pattern: /lint.?(?:error|failed)|eslint.?error|prettier.?error/i,
    category: 'lint-error',
    actionable: false,
    extract: () => ({
      message: 'Linting failed',
      suggestedFix: 'Code style/lint errors detected. Fix formatting issues and retry.'
    })
  },
  {
    pattern: /build.?failed|compilation.?(?:failed|error)|typescript.?error|tsc.+error/i,
    category: 'build-error',
    actionable: false,
    extract: () => ({
      message: 'Build failed',
      suggestedFix: 'Build/compilation failed. Fix syntax or type errors and retry.'
    })
  },

  // ===== Process & System Errors =====
  {
    pattern: /ECONNREFUSED|ETIMEDOUT|network error/i,
    category: 'network-error',
    actionable: false,
    origin: 'runner',
    structuredMarker: /ECONNREFUSED|ETIMEDOUT/i, // a bare `network error` in output stays output-scan
    extract: () => ({
      message: 'Network connection failed',
      suggestedFix: 'Check network connectivity and service availability.'
    })
  },
  {
    pattern: /ENOENT|file.?not.?found|no.?such.?file/i,
    category: 'file-not-found',
    actionable: false,
    extract: (match, output) => {
      const pathMatch = output.match(/(?:ENOENT|not.?found)[:\s]*['"]?([^'"}\s]+)['"]?/i);
      return {
        message: `File not found${pathMatch ? `: ${pathMatch[1].substring(0, 40)}` : ''}`,
        suggestedFix: 'Expected file/directory does not exist. Verify paths in the task description.'
      };
    }
  },
  {
    pattern: /ENOMEM|out.?of.?memory|heap.?(?:out|limit)|memory.?(?:limit|exceeded)/i,
    category: 'memory-error',
    actionable: true,
    extract: () => ({
      message: 'Out of memory',
      suggestedFix: 'Process ran out of memory. Task may be too large or there is a memory leak.'
    })
  },
  {
    pattern: /timeout|timed.?out|deadline.?exceeded/i,
    category: 'timeout',
    actionable: false,
    extract: () => ({
      message: 'Operation timed out',
      suggestedFix: 'Task took too long to complete. Consider breaking into smaller subtasks.'
    })
  },
  {
    pattern: /(?:killed|terminated).?(?:by.?signal|SIGTERM|SIGKILL)/i,
    category: 'process-killed',
    actionable: false,
    extract: () => ({
      message: 'Process killed',
      suggestedFix: 'Agent process was terminated. May have exceeded resource limits or was killed externally.'
    })
  },
  {
    pattern: /spawn.?(?:error|failed)|EACCES|command.?not.?found/i,
    category: 'spawn-error',
    actionable: true,
    escalation: 'Confirm the required CLI/tool is installed and on PATH for the agent user (or fix the command), then approve the retry.',
    extract: () => ({
      message: 'Command spawn failed',
      suggestedFix: 'Failed to start subprocess. Check that required CLI tools are installed and accessible.'
    })
  },

  // ===== Playwright & Browser Errors =====
  {
    pattern: /playwright|browser.?(?:crashed|closed|disconnected)/i,
    category: 'browser-error',
    actionable: false,
    extract: () => ({
      message: 'Browser automation failed',
      suggestedFix: 'Playwright browser crashed or disconnected. Check if the dev server is running.'
    })
  },
  {
    pattern: /locator.?(?:timeout|not.?found)|element.?not.?(?:found|visible)/i,
    category: 'locator-error',
    actionable: false,
    extract: () => ({
      message: 'UI element not found',
      suggestedFix: 'Could not find expected element on page. UI may have changed or selector is wrong.'
    })
  },

  // ===== Agent-Specific Errors =====
  {
    pattern: /(?:claude|anthropic).?(?:error|failed)|overloaded_error/i,
    category: 'claude-error',
    actionable: false,
    origin: 'provider',
    structuredMarker: /overloaded_error/i, // loose `claude error`/`anthropic failed` in output stays output-scan
    extract: () => ({
      message: 'Claude API error',
      suggestedFix: 'Claude API returned an error. This is usually transient - retry recommended.'
    })
  },
  {
    pattern: /invalid.?(?:json|syntax)|JSON\.parse|SyntaxError/i,
    category: 'parse-error',
    actionable: false,
    extract: () => ({
      message: 'JSON/Syntax parse error',
      suggestedFix: 'Failed to parse response or file. Check for malformed JSON or syntax errors.'
    })
  },
  {
    pattern: /task.?(?:rejected|declined|refused)|cannot.?(?:complete|perform)/i,
    category: 'task-rejected',
    actionable: true,
    escalation: 'Rephrase or narrow the original task description so it is actionable, then approve the retry — the agent declined it as written.',
    extract: () => ({
      message: 'Agent rejected task',
      suggestedFix: 'Agent could not or would not complete the task. Rephrase or simplify the request.'
    })
  },

  // ===== Limit & Billing Errors =====
  {
    pattern: /(?:maximum|max).*(?:turns?|iterations?|steps?)|turn.?limit|max.?turns|stopped after \d+ turns/i,
    category: 'turn-limit',
    actionable: false,
    extract: () => ({
      message: 'Agent reached turn limit',
      suggestedFix: 'Task exceeded the maximum number of agent turns. Break into smaller subtasks or increase turn limit.'
    })
  },
  {
    pattern: /(?:billing|subscription|payment).?(?:error|issue|required|expired|failed)/i,
    category: 'billing-error',
    actionable: true,
    extract: () => ({
      message: 'Billing/subscription issue',
      suggestedFix: 'Provider billing or subscription problem. Check provider account status.'
    })
  },

  // ===== Safety & Content Errors =====
  {
    pattern: /content.?(?:filter|policy)|safety.?(?:filter|block)|harmful.?content/i,
    category: 'content-filtered',
    actionable: true,
    escalation: 'Reword the task description to avoid the content that tripped the safety filter, then approve the retry.',
    extract: () => ({
      message: 'Content filtered',
      suggestedFix: 'Request was blocked by content safety filter. Rephrase the task description.'
    })
  }
];

// Analysis-window bounds. The line cap is the primary "only look at the tail"
// rule; the char cap is the backstop that makes it hold for PTY transcripts.
export const FAILURE_WINDOW_MAX_LINES = 200;
export const FAILURE_WINDOW_MAX_CHARS = 16000;

// Claude Code's EMPTY-composer placeholder — `❯ Try "fix lint errors"`. It is
// the TUI advertising what you could ask for, not anything that happened, and it
// is on screen precisely when the agent did nothing. The suggestion rotates
// ("fix lint errors", "fix typecheck errors", …), so it can trip several
// ERROR_PATTERNS by pure coincidence; `lint-error` is the one that actually
// shipped a bogus diagnosis (agent-f71b794e). Dropped from the analysis window
// so no pattern — present or future — can classify a run off a hint the user
// never followed.
//
// Anchored on the `❯ Try "` chrome rather than the suggestion text: real agent
// prose can say "fix lint errors", and only the composer prefixes it this way.
const TUI_PLACEHOLDER_HINT_PATTERN = /^\s*[❯>]\s*Try\s+["'].*$/gm;

/**
 * Reduce raw agent output to the tail worth classifying.
 *
 * A TUI transcript is a *screen*, not a log: it arrives as ANSI cursor-addressing
 * and repaints, so a raw 838KB PTY spool can collapse to ~14 `\n`-delimited
 * "lines". That defeated a line-only window entirely — the "last 200 lines" was
 * the WHOLE 17-minute session, so a keyword anywhere in it (in the pasted prompt,
 * or in a `grep -rn "maxTokens\|max_tokens"` the agent itself ran) classified the
 * failure. That is exactly how an earlier idle-reaper kill got labelled
 * `context-length`.
 *
 * So: strip escape sequences, treat CR as a line break (repaints overwrite a
 * line rather than starting one), drop blanks, then bound by lines AND by
 * characters. Pure.
 */
function getFailureAnalysisWindow(output) {
  const windowed = stripAnsi(output)
    .replace(/\r\n?/g, '\n')
    .replace(TUI_PLACEHOLDER_HINT_PATTERN, '')
    .split('\n')
    .filter(l => l.trim())
    .slice(-FAILURE_WINDOW_MAX_LINES)
    .join('\n');
  return windowed.length > FAILURE_WINDOW_MAX_CHARS ? windowed.slice(-FAILURE_WINDOW_MAX_CHARS) : windowed;
}

/**
 * Resolve the provenance origin for a matched ERROR_PATTERN (#2642). Returns the
 * pattern's structured `origin` (`'provider'`/`'runner'`) only when it is
 * declared AND — if a `structuredMarker` sub-pattern is present — that marker
 * appears somewhere in the failure window. A pattern with no structured origin,
 * or a `structuredMarker` that is absent, falls through to `'output-scan'`,
 * marking the classification as coming solely from the loose regex sweep.
 *
 * The marker is tested against the WHOLE analysis window, not just the matched
 * substring: the main pattern's alternation returns the LEFTMOST match, which
 * may be a loose alternative (a bare `rate limit`) even when a genuine
 * `API Error: 429` appears later in the same output — so a real provider signal
 * anywhere in the window still promotes the classification (#2642 review). Pure.
 */
function resolvePatternOrigin(errorDef, analysisOutput) {
  if (!errorDef.origin) return 'output-scan';
  if (errorDef.structuredMarker && !errorDef.structuredMarker.test(analysisOutput || '')) return 'output-scan';
  return errorDef.origin;
}

/**
 * Runner-resolved completion reasons → the failure they actually describe.
 *
 * When the spawner's own finalize path already KNOWS why a run ended (a legacy
 * forced-stop was applied, or the shell session never came up), that is a
 * structural signal about the process — strictly better evidence than a regex
 * sweep over the transcript. Keyed by the `reason` each `finish()` call passes;
 * see `server/services/agentTuiSpawning.js`. Categories are deliberately reused
 * from ERROR_PATTERNS so downstream taxonomies (task-learning metrics,
 * layeredIntelligenceExecutionFailures) keep classifying them without a new token.
 */
// Legacy idle-out and forced-stop reasons remain readable for archived agent
// records and retries; the current CoS TUI path completes by sentinel, process
// exit, or explicit provider failure.
export const COMPLETION_REASON_ANALYSES = {
  'idle-no-changes': {
    category: 'no-changes',
    actionable: false,
    message: 'Agent idled out with no file changes',
    suggestedFix: 'The agent stopped producing output without writing any files OR committing anything during the run. Check the raw transcript for where it stalled — a provider retry loop or a long-running command can outlast the idle reaper.'
  },
  // The programmatic-I/O counterpart of the above: a layered-intelligence run
  // delivers a `.agent-done` JSON payload, never a file change, so "no file
  // changes" was both the wrong measurement and the wrong advice. Same
  // `no-changes` category on purpose — the downstream taxonomies keep
  // classifying it without a new token — but the prose names what actually
  // went missing.
  'idle-no-deliverable': {
    category: 'no-changes',
    actionable: false,
    message: 'Agent idled out without writing its structured output',
    suggestedFix: 'This task type is judged by the `.agent-done` payload an output hook consumes, not by file changes. The transcript often ENDS with the JSON the agent should have written to that file — a smaller model answering in the terminal instead of using a tool. Check the tail of the raw transcript, and prefer a model that reliably follows the write-the-file instruction.'
  },
  'idle-no-activity': {
    category: 'startup-failure',
    actionable: false,
    message: 'Agent idled out before any work started',
    suggestedFix: 'The prompt likely never submitted — no working indicator ever appeared. Check the TUI paste/submit path and provider availability.'
  },
  // The two startup verdicts the TUI spawner resolves itself (agentTuiSpawning.js:
  // `retryOrFailPaste` and the TUI_INPUT_READY_DEADLINE_MS branch). Both were
  // missing here, and the cost was not merely a vaguer message: with no
  // structural def, `analyzeAgentFailure` falls through to the regex sweep over a
  // repaint-mangled TUI screen. Claude Code's idle composer renders a rotating
  // placeholder hint — `❯ Try "fix lint errors"` — so a run that never submitted
  // anything at all got filed as `lint-error` / "Linting failed", pointing every
  // reader (and the auto-fixer tier) at a lint problem that did not exist
  // (agent-f71b794e, 2026-08-14; the actual blocker was claude's new auto-mode
  // modal). Registering the reasons restores the documented precedence — the
  // spawner's own verdict beats a keyword sweep — and the `startup-failure`
  // category is reused rather than minted so downstream taxonomies are unchanged.
  'paste-not-rendered': {
    category: 'startup-failure',
    actionable: false,
    message: 'Prompt never rendered in the TUI input box',
    suggestedFix: 'The provider CLI accepted the bracketed paste but the prompt never appeared, so nothing was ever submitted. Usually the TUI was still initializing, or a startup dialog (folder trust, an opt-in offer, an account banner) was up and swallowed the paste. Check the tail of the raw transcript for a modal — if it is one PortOS does not know about yet, it needs a dismissal branch in agentTuiSpawning.js.'
  },
  'tui-not-ready': {
    category: 'startup-failure',
    actionable: false,
    message: 'TUI never presented an input prompt',
    suggestedFix: 'The provider CLI never signalled that its input box was live, so no prompt was sent. Check the raw transcript for a stalled sign-in, an unresolved startup dialog, or a CLI that exited back to the shell during boot.'
  },
  'review-loop-idle-timeout': {
    category: 'timeout',
    actionable: false,
    message: 'Agent idled out inside the multi-reviewer loop',
    suggestedFix: 'A reviewer may have hung or the wait exceeded budget. Check the PR review/merge state and finish it manually.'
  },
  'merge-queue-idle-timeout': {
    category: 'timeout',
    actionable: false,
    message: 'Agent idled out waiting on the merge queue',
    suggestedFix: 'The merge queue wait exceeded budget. Check the PR merge state and finish it manually.'
  },
  'max-runtime-timeout': {
    category: 'timeout',
    actionable: false,
    message: 'Agent was stopped by a retired maximum-runtime limit',
    suggestedFix: 'This result came from an older PortOS runtime guard; current CoS TUI agents have no wall-clock runtime ceiling.'
  },
  // Historical counterpart for runs that were asked to wrap up during the
  // retired wall-clock guard and never did.
  'max-runtime-no-wrap-up': {
    category: 'timeout',
    actionable: false,
    message: 'Agent was stopped by a retired maximum-runtime wrap-up limit',
    suggestedFix: 'This result came from an older PortOS runtime guard; current CoS TUI agents have no wall-clock runtime ceiling.'
  },
  // The PTY was terminated by a signal rather than exiting on its own — almost
  // always pm2's TreeKill taking portos-server's descendants down with it on a
  // restart (#3202). Not actionable as an agent fault: the run was cut short by
  // infrastructure, and the task is requeued to resume from what it left behind.
  'shell-signaled': {
    category: 'process-killed',
    actionable: false,
    message: 'Agent session was terminated by a signal',
    suggestedFix: 'The TUI session was killed rather than exiting on its own — usually a PortOS restart taking its child processes down. The task resumes from the preserved worktree; no agent-side fix is needed.'
  },
  // The TUI spawner declined TOOL_PERMISSION_DECLINE_MAX permission dialogs
  // (createToolPermissionGate) and the model was still reaching outside the
  // run's scope. Registered so the post-mortem does not fall through to the
  // transcript keyword sweep — which would scrape the dialog chrome itself.
  'permission-prompt-loop': {
    category: 'timeout',
    actionable: false,
    message: 'Agent kept asking for tool permissions an unattended run cannot grant',
    suggestedFix: 'Every permission dialog was declined and the model kept reaching outside the run\'s allowed scope (paths outside the worktree, tools the posture forbids). A fallback provider retries the task; if it recurs, pin the stage to a stronger model or remove the outside-path references from its prompt.'
  },
  'command-not-found': {
    category: 'spawn-error',
    actionable: true,
    escalation: 'Confirm the required CLI/tool is installed and on PATH for the agent user (or fix the command), then approve the retry.',
    message: 'TUI command not found',
    suggestedFix: 'The configured provider CLI is not installed or not on PATH. Install it or correct the provider command.'
  },
  'spawn-error': {
    category: 'spawn-error',
    actionable: true,
    escalation: 'Confirm the required CLI/tool is installed and on PATH for the agent user (or fix the command), then approve the retry.',
    message: 'Failed to start the agent session',
    suggestedFix: 'The PTY session could not be created. Check system resources, whether too many sessions are already open, and the provider command configuration.'
  },
  // The runner refused the spawn outright — a command missing from its
  // allowlist, malformed cliArgs, or the runner simply unreachable. No child
  // ever existed, so there is no transcript to classify and the rejection prose
  // (carried in as `completionError`) is the whole diagnosis.
  //
  // Deliberately NOT actionable, unlike its `spawn-error` sibling above: a
  // rejection is frequently just a briefly-unreachable runner, and blocking the
  // task for a human would park work that a plain retry fixes. A genuinely
  // misconfigured command still surfaces — it fails identically every attempt
  // and blocks on MAX_TASK_RETRIES, with the runner's own message attached.
  // #3680: a worktree-isolated agent committed to the PRIMARY checkout instead
  // of its worktree, leaving unreviewed commits on an unprotected branch. The
  // finalize path (agentFinalization.js) builds a richer analysis naming the
  // actual branch, commit count, and recovery command; this registration is the
  // fallback for anything that re-analyzes the reason without that context (a
  // recovered/archived run), and keeps the reason from falling through to a
  // keyword sweep of the transcript. Reuses the existing `git-error` token
  // rather than minting one, so the downstream taxonomies keep classifying it.
  [PRIMARY_CHECKOUT_MUTATED_REASON]: {
    category: PRIMARY_CHECKOUT_MUTATED_CATEGORY,
    actionable: true,
    escalation: PRIMARY_CHECKOUT_MUTATED_ESCALATION,
    message: 'Worktree agent mutated the primary checkout',
    suggestedFix: 'The agent was given its own git worktree and committed to the primary checkout anyway, so the primary is carrying commits nothing reviewed. The same work is almost certainly on the agent\'s branch too. Inspect the primary with `git log --oneline origin/<branch>..<branch>` and, once the content is confirmed preserved, restore it with `git reset --hard origin/<branch>` — PortOS will not run that for you, because it discards commits.'
  },
  'spawn-rejected': {
    category: 'spawn-error',
    actionable: false,
    message: 'The runner rejected the spawn',
    suggestedFix: 'No agent process was ever created — the cos-runner refused the spawn or was unreachable. Check that the runner is up and that the provider command is on its allowlist; the task is requeued for a retry either way.'
  }
};

/**
 * Screen signatures of a TUI parked on an interactive prompt — a multiple-choice
 * selector, an approval gate, a confirmation. A CoS agent is unattended, so
 * nothing ever answers: older TUI handling repaints the prompt until its idle
 * fallback kills it, and the run lands as a plain idle-out. That verdict is true but
 * diagnostically useless — it sends the reader hunting for a stalled provider
 * request, and a retry re-runs the same command straight into the same gate.
 * (Observed cost: three identical `/do:plan-task` attempts, each parked on a
 * scope question, filing nothing. Prevention is `UNATTENDED_RUN_RULE` in
 * `agentPromptBuilder.js`; this is the diagnosis when one slips through.)
 */
// Each marker must be chrome no narrative prose would produce — a bare
// `to navigate` matches an agent describing a button it just added, so the
// navigate hint keeps its arrow glyphs.
export const AWAITING_INPUT_MARKERS = [
  /Enter to select/i,
  /↑\/↓ to navigate/,
  /❯\s*1\./,
  // Claude Code's tool-permission dialog — the live gate that declines it
  // (createToolPermissionGate) reads the same pattern.
  TUI_TOOL_PERMISSION_PROMPT_PATTERN,
  /Press Enter to continue/i
];

/**
 * Only the TAIL of the failure window is searched: the claim is "still sitting
 * here when the reaper fired", not "asked something at some point". A TUI
 * transcript is repaint-mangled and nearly newline-free (see
 * getFailureAnalysisWindow), so a character tail is the only reliable "end of
 * the session" boundary available.
 */
export const AWAITING_INPUT_TAIL_CHARS = 2500;

/** True when the end of the transcript looks like an unanswered prompt. Pure. */
export function endsAwaitingUserInput(analysisOutput) {
  const tail = (analysisOutput || '').slice(-AWAITING_INPUT_TAIL_CHARS);
  return AWAITING_INPUT_MARKERS.some(marker => marker.test(tail));
}

/**
 * Legacy idle-out reasons worth re-explaining as an unanswered prompt. All three
 * are "the reaper killed it" verdicts, so when the tail shows a selector or approval
 * gate that IS the proximate cause — including for a programmatic-I/O run, whose
 * payload went unwritten precisely because it never got past the prompt.
 */
const AWAITING_INPUT_REFINABLE_REASONS = new Set(['idle-no-changes', 'idle-no-activity', 'idle-no-deliverable']);

/**
 * The startup counterparts: the prompt never landed, and the transcript ends on a
 * dialog. Same evidence, different story — no reaper was involved and the run
 * never started, so the idle prose above ("re-running as-is will stall the same
 * way", "invoke the non-interactive form") is wrong on every clause. Here the
 * dialog is a STARTUP gate the spawner does not know how to dismiss, and the fix
 * is a dismissal branch, not a reworded task.
 */
const STARTUP_GATE_REFINABLE_REASONS = new Set(['paste-not-rendered', 'tui-not-ready']);

/**
 * Re-word a run whose transcript ends on an unanswered prompt — a legacy idle-out that
 * stalled ON one, or a startup verdict where a dialog was up BEFORE the prompt
 * could land (the two groups get different prose; see the reason sets). The
 * original `category` is preserved — downstream taxonomies (auto-fix tiers,
 * layered-intelligence failure buckets) keep classifying it exactly as they did,
 * and both idle reasons already escalate rather than blind-retry. Only the prose
 * a human reads changes. Pure.
 */
function refineIdleReasonAnalysis(def, completionReason, analysisOutput) {
  if (!def) return def;
  if (STARTUP_GATE_REFINABLE_REASONS.has(completionReason)) {
    if (!endsAwaitingUserInput(analysisOutput)) return def;
    return {
      ...def,
      message: 'Agent never started — a startup dialog swallowed the prompt',
      suggestedFix: 'The transcript ends on an unanswered dialog (a choice selector or opt-in offer) that was up before the prompt could land, so nothing was ever submitted and the run is a no-op rather than a failed attempt. PortOS auto-answers the dialogs it knows (folder trust, claude\'s auto-mode offer); a new one from a CLI update needs its own pattern and dismissal branch in tuiHandshake.js / agentTuiSpawning.js. Read the tail of the raw transcript to see which dialog it was.'
    };
  }
  if (!AWAITING_INPUT_REFINABLE_REASONS.has(completionReason)) return def;
  if (!endsAwaitingUserInput(analysisOutput)) return def;
  return {
    ...def,
    message: 'Agent stalled on an interactive prompt with nobody to answer it',
    suggestedFix: 'The transcript ends on an unanswered prompt (a choice selector or approval gate), so the agent never got past it and the old idle fallback killed the run. Agents run unattended — re-running as-is will stall the same way. Invoke the command in its non-interactive form (e.g. `/do:plan-task --yes`) or reword the task so no approval is needed.'
  };
}

/**
 * Build the analysis object for a runner-resolved completion reason. The
 * snippet comes from the runner's own error prose — clean, already-scoped text —
 * never from the escape-laden transcript.
 */
function structuralReasonAnalysis(def, completionReason, completionError) {
  return {
    category: def.category,
    actionable: def.actionable,
    // Structural runner signal (#2642): the spawner observed the process end
    // this way, so it stays eligible for environmental diversion.
    origin: 'runner',
    snippet: typeof completionError === 'string' ? completionError.trim().slice(0, SNIPPET_RAW_MAX_CHARS) : '',
    escalation: def.escalation || null,
    completionReason,
    message: def.message,
    suggestedFix: def.suggestedFix
  };
}

/**
 * Analyze agent failure output and categorize the error.
 *
 * `options.completionReason` / `options.completionError` carry the spawner's own
 * verdict when it has one (see COMPLETION_REASON_ANALYSES). A recognized reason
 * becomes the default classification, and only a STRUCTURED provider/runner
 * signal in the transcript (an `API Error: NNN` line, a Node error code) may
 * override it — a loose output-scan keyword match may not. Without that gate an
 * an idle-reaper kill was labelled `context-length` (actionable → task blocked +
 * investigation filed) purely because the agent had run a grep for `max_tokens`
 * fifteen minutes earlier.
 */
export function analyzeAgentFailure(output, task, model, options = {}) {
  const completionReason = options?.completionReason || null;
  const analysisOutput = getFailureAnalysisWindow(output || '');
  // An idle-out whose transcript ends on an unanswered prompt gets that named as
  // the cause; every other reason passes through untouched.
  const structuralDef = refineIdleReasonAnalysis(
    completionReason ? COMPLETION_REASON_ANALYSES[completionReason] : null,
    completionReason,
    analysisOutput
  );

  // Agent produced no meaningful output — likely failed to start. Measured on
  // the CLEANED window: a transcript that is nothing but cursor repaints carries
  // no more signal than an empty one.
  if (analysisOutput.trim().length < 50) {
    if (structuralDef) return structuralReasonAnalysis(structuralDef, completionReason, options?.completionError);
    return {
      category: 'startup-failure',
      actionable: false,
      // Structural runner signal (#2642): inferred from the process producing no
      // usable output, not from a regex sweep — so it stays environmental-eligible.
      origin: 'runner',
      message: 'Agent failed to start or produced no output',
      suggestedFix: 'Agent process exited immediately. Check system resources and provider availability.',
      snippet: analysisOutput.trim(),
      escalation: null
    };
  }

  for (const errorDef of ERROR_PATTERNS) {
    const match = analysisOutput.match(errorDef.pattern);
    if (match) {
      // Provenance (#2642): 'provider'/'runner' only when a structured marker
      // is present in the failure window; a loose keyword match stays 'output-scan'.
      const origin = resolvePatternOrigin(errorDef, analysisOutput);
      // Keep scanning (not `break`) so a structured match later in the list can
      // still beat the runner's verdict — only the loose match is discarded.
      if (structuralDef && origin === 'output-scan') continue;
      const extracted = errorDef.extract(match, analysisOutput, task, model);
      return {
        category: errorDef.category,
        actionable: errorDef.actionable,
        origin,
        // Captured for the human-facing investigation body; redacted at embed time.
        snippet: snippetAround(analysisOutput, match.index ?? 0),
        // Optional category-specific "what to approve" prose (may be undefined).
        escalation: errorDef.escalation || null,
        ...(completionReason ? { completionReason } : {}),
        ...extracted
      };
    }
  }

  if (structuralDef) return structuralReasonAnalysis(structuralDef, completionReason, options?.completionError);

  // No pattern matched — extract meaningful context from the cleaned window
  // (NOT the raw output: on a PTY transcript the raw tail is escape codes).
  const lastLines = analysisOutput.split('\n').slice(-20);

  const errorKeywords = /\b(error|fail|exception|fatal|panic|abort|crash|denied|refused|invalid|cannot|could not|unable to)\b/i;
  const errorLines = lastLines.filter(l => errorKeywords.test(l)).slice(0, 5);

  const contextLines = (errorLines.length > 0 ? errorLines : lastLines.slice(-5))
    .map(l => l.trim().slice(0, SNIPPET_RAW_MAX_CHARS));
  const summary = contextLines[0]?.substring(0, 120) || 'Agent failed with unrecognized error';

  return {
    category: 'unknown',
    actionable: false,
    // Pure regex/keyword sweep over the output tail (#2642) — never diverted as
    // environmental (and 'unknown' isn't an environmental category anyway).
    origin: 'output-scan',
    message: summary,
    details: contextLines.join('\n'),
    snippet: contextLines.join(' ').slice(0, SNIPPET_RAW_MAX_CHARS),
    escalation: null,
    ...(completionReason ? { completionReason } : {}),
    suggestedFix: 'Error did not match known patterns. Review the details or agent output logs.'
  };
}

// ===== Investigation-task creation guards (#2615) =====

// An investigation in any of these states means the failure cause is already
// being tracked — a repeat failure with the same fingerprint is the SAME cause,
// not new work. `completed` is the only terminal status in the task vocabulary
// (see taskParser.js STATUS_MAP); everything else — including `challenged`,
// where a task can park for days awaiting user arbitration — stays open, so a
// fresh task is only allowed once the prior cause was actually dealt with.
const OPEN_INVESTIGATION_STATUSES = new Set(['pending', 'in_progress', 'challenged', 'blocked']);

// The rolling circuit breaker, the creation counter, and the flat backlog read
// live in `investigationTaskProducer.js` — shared with the provider / crash /
// orphan producers so "how many investigations this hour" is ONE number rather
// than one per producer. Re-exported here at the address the suites and callers
// already use.
export { INVESTIGATION_CIRCUIT_WINDOW_MS, INVESTIGATION_CIRCUIT_MAX_CREATIONS } from '../lib/investigationTasks.js';
export { __resetInvestigationCircuit } from './investigationTaskProducer.js';

// Find an existing investigation task (user or internal queue) still tracking
// this fingerprint in a non-terminal status. Pure.
function findOpenInvestigationIn(tasks, fingerprint) {
  return tasks.find(t =>
    OPEN_INVESTIGATION_STATUSES.has(t.status) &&
    t.metadata?.investigationFingerprint === fingerprint
  ) || null;
}

/**
 * Create an investigation task in COS-TASKS.md for a failed agent.
 *
 * Guarded two ways (#2615): a durable fingerprint dedup (one open investigation
 * per failure cause — returns the existing task when it fires) and a rolling
 * circuit breaker (returns null when open). See maybeCreateInvestigationTask
 * for the meta-cascade guard.
 *
 * Serialized on a module-level promise tail: a failure storm fires several
 * concurrent finalize chains, and without the tail two same-fingerprint creates
 * can both pass the fingerprint scan (and both read a below-cap circuit) before
 * either addTask lands — the exact TOCTOU the guards exist to close. Each
 * caller still sees its own result/rejection; the tail itself never poisons.
 */
let investigationCreateTail = Promise.resolve();

export function createInvestigationTask(agentId, originalTask, errorAnalysis) {
  const run = investigationCreateTail.then(() => doCreateInvestigationTask(agentId, originalTask, errorAnalysis));
  investigationCreateTail = run.catch(() => {});
  return run;
}

async function doCreateInvestigationTask(agentId, originalTask, errorAnalysis) {
  const analysis = errorAnalysis || {};
  const category = analysis.category || 'unknown';
  const rawMessage = analysis.message || 'Agent failed with an unrecognized error';
  const modelAttribution = analysis.affectedModel || analysis.configuredModel || null;

  // Durable-fingerprint dedup: one open investigation per failure cause.
  const fingerprint = buildInvestigationFingerprint(originalTask, analysis);
  const allTasks = await readAllTasksFlat();
  const existing = findOpenInvestigationIn(allTasks, fingerprint);
  if (existing) {
    emitLog('info', `⏭️ Skipping duplicate investigation for ${fingerprint}: ${existing.id} is still ${existing.status}`, {
      agentId, taskId: originalTask.id, fingerprint, existingTaskId: existing.id, existingStatus: existing.status
    });
    // Union this failure's task id into the surviving investigation — both in
    // metadata AND appended to the human/agent-facing body — so the record
    // names EVERY task blocked on this cause: resolving it should unblock all
    // of them, not just the first one mentioned in "What unblocks".
    const affected = Array.isArray(existing.metadata?.affectedTasks) ? existing.metadata.affectedTasks : [];
    if (originalTask.id && !affected.includes(originalTask.id)) {
      await updateTask(existing.id, {
        description: `${existing.description}\n- Also blocks task \`${originalTask.id}\` (same cause; agent \`${agentId}\`).`,
        metadata: { affectedTasks: [...affected, originalTask.id] }
      }, 'internal');
    }
    return existing;
  }

  // Rolling circuit breaker: cap creations per window across all producers.
  const now = Date.now();
  if (investigationCircuitOpen(now)) {
    emitLog('warn', `🔌 Investigation circuit OPEN — ${INVESTIGATION_CIRCUIT_MAX_CREATIONS} investigations created within the last hour; suppressing task for ${fingerprint}`, {
      agentId, taskId: originalTask.id, fingerprint
    });
    return null;
  }

  // Auto-approved unless this failure is a LOOP (#3714) — an isolated agent
  // failure is exactly the work CoS is meant to diagnose for itself. The pure
  // policy is called directly (rather than via `resolveAutoInvestigationApproval`)
  // so the backlog already read for the dedup scan above serves both.
  const { approvalRequired, loopReason, approvalReason } = resolveInvestigationApproval({
    fingerprint, tasks: allTasks, recentCreations: recentInvestigationCreations(now), now
  });

  // Every interpolated free-text field is redacted before it lands in the body —
  // this task is human-facing and may sync across federated peers, so no
  // hostnames/paths/IPs/PII/secrets from the live instance may leak in. `message`
  // for the `unknown` category is a raw agent output line, so it needs the same
  // scrub as the snippet — not just the snippet/description fields.
  const message = redactFailureSnippet(rawMessage) || rawMessage;
  const snippet = redactFailureSnippet(analysis.snippet || analysis.details || rawMessage);
  const originalDesc = redactFailureSnippet((originalTask.description || '').substring(0, 160)) || '(no description)';

  // Prefer the pattern's category-specific escalation prose; fall back to the
  // generic suggestedFix so uncustomized categories still read as an action.
  const remedy = analysis.escalation
    || analysis.suggestedFix
    || 'Review the agent output, decide whether to fix the underlying config/code and retry, or close the task.';

  // The body addresses whoever will actually act on this task: an unattended
  // investigation agent in the default (auto-approved) case, the single PortOS
  // user in the held case. Same remedy prose either way — only the framing, the
  // held-reason section, and the "what unblocks" consequence differ.
  const actionBlock = approvalRequired
    ? [
        `## What to approve\n${remedy}`,
        `## Why this is held for you\n${LOOP_REASON_PROSE[loopReason]}`
      ].join('\n\n')
    : `## What to do\nNo approval needed — this investigation runs unattended. Diagnose the failure above, apply the fix, and leave the task's findings in your summary. Do NOT un-block the original task by hand; completing this one does it.\n\n${remedy}`;

  // Completing this task revives every blocked task in `affectedTasks`
  // automatically (investigationRetry.js), so nobody has to go find them.
  const unblocks = `${approvalRequired ? 'Approving and applying' : 'Applying'} the fix and completing this task automatically retries the original task \`${originalTask.id}\`; it will resume: ${originalDesc}. If the same cause blocks it again after ${MAX_AUTO_RETRIES_PER_TASK} automatic retries, it stays blocked for you.`;

  // The fingerprint rides in the headline so addTask's first-line dedup —
  // which sees no `metadata.app` on investigation tasks — tracks fingerprint
  // identity exactly: identical messages from different apps OR different
  // task kinds/categories can never falsely collapse into one task, and
  // same-fingerprint repeats are already caught by the scan above. The app
  // is deliberately NOT passed as `app` to addTask, which would change
  // workspace routing for the investigation agent.
  const description = `${INVESTIGATION_HEADLINE_PREFIX} [${fingerprint}]: ${message}

## What happened
Agent \`${agentId}\` failed while working on task \`${originalTask.id}\` (${originalDesc}).
- **Classification**: ${category} — ${message}
- **Provider/model**: ${modelAttribution || 'not attributed'}
${snippet ? `- **Failure snippet (redacted)**:\n  > ${snippet}` : '- **Failure snippet**: (none captured)'}

${actionBlock}

## What unblocks
${unblocks}`;

  const investigationTask = await addTask({
    ...INVESTIGATION_TASK_DELIVERY,
    description,
    priority: 'HIGH',
    context: `Auto-generated from agent ${agentId} failure`,
    approvalRequired,
    isInvestigation: true, // Meta-cascade guard marker (#2615)
    investigationFingerprint: fingerprint,
    // Durable record of WHY this stopped for a human (null when it ran
    // unattended) — readable from the queue without re-deriving the verdict.
    approvalReason,
    affectedTasks: [originalTask.id] // later same-fingerprint failures union in
  }, 'internal');

  // Count only genuine creations against the circuit — addTask's own
  // description-level dedup returning an existing task is not a new creation.
  if (!investigationTask.duplicate) noteInvestigationFiled(now);

  emitLog('info', `Created investigation task ${investigationTask.id} for failed agent ${agentId} — ${loopReason ? `held for approval (${loopReason})` : 'auto-approved'}`, {
    agentId,
    taskId: investigationTask.id,
    errorCategory: category,
    approvalRequired,
    loopReason
  });

  cosEvents.emit('investigation:created', {
    investigationTaskId: investigationTask.id,
    failedAgentId: agentId,
    originalTaskId: originalTask.id,
    errorAnalysis,
    approvalRequired,
    loopReason
  });

  return investigationTask;
}

// Error categories where LLM API access is blocked or denied — spawning an
// investigation agent would fail for the same reason, so skip it.
export const API_ACCESS_ERROR_CATEGORIES = new Set([
  'auth-error',
  'forbidden',
  'usage-limit',
]);

export async function maybeCreateInvestigationTask(agentId, task, analysis) {
  if (API_ACCESS_ERROR_CATEGORIES.has(analysis?.category)) {
    emitLog('debug', `⏭️ Skipping investigation task for ${task.id}: API access error (${analysis.category})`, { agentId, taskId: task.id, category: analysis.category });
    return;
  }
  // Meta-cascade guard (#2615): a failed investigation task must never spawn an
  // investigation of the investigation. isInvestigationTask prefers the durable
  // metadata marker (isTruthyMeta covers the markdown round-trip, where boolean
  // metadata comes back as the string 'true') and falls back to the legacy
  // headline shape for tasks persisted before the marker existed.
  if (isInvestigationTask(task)) {
    emitLog('info', `⏭️ Skipping meta-investigation for ${task.id}: failed task is itself an investigation`, { agentId, taskId: task.id, category: analysis?.category });
    return;
  }
  await createInvestigationTask(agentId, task, analysis).catch(err => {
    emitLog('warn', `Failed to create investigation task: ${err.message}`, { agentId, taskId: task.id, category: analysis?.category });
  });
}

/**
 * Pure decision logic for {@link resolveFailedTaskUpdate} — no I/O, and no clock
 * beyond the injectable `now`.
 *
 * Decides whether a failed task should be blocked or held for retry, the metadata
 * fields to merge over `task.metadata` (the failure/blocked timestamps stay with
 * the async wrapper; the retry hold's own stamp is part of the marker pair, so it
 * is written here from the injected `now` rather than split across two files), and
 * the analysis to hand to an investigation task. Extracted so the branching can be
 * unit-tested directly (see `agentErrorAnalysis.test.js`) instead of through a
 * drift-prone inline copy. Whether an investigation task is actually created stays
 * the sole concern of {@link maybeCreateInvestigationTask}.
 *
 * `in_progress` is the RETRY status, not a typo: a retryable failure is held
 * non-spawnable until its resume pointer is resolved (#3373, lib/taskRetryHold.js).
 * `agentId` is stamped INTO that hold so only the run that armed it can release it.
 *
 * @returns {{
 *   status: 'blocked'|'in_progress',
 *   investigationAnalysis: object|null,
 *   metadataUpdates: { failureCount?: number, lastErrorCategory?: string, [k: string]: unknown }
 * }}
 */
export function resolveFailedTaskDecision(task, errorAnalysis, { agentId = null, now = Date.now() } = {}) {
  // A PERMANENT failure (#6124) re-fails identically on every re-dispatch — a
  // pipeline stage whose agent finished with no parseable output has nothing a
  // retry could read differently. Block on the FIRST occurrence, ahead of the
  // actionable branch, and file NO investigation task: an investigation agent
  // is another unbounded spawn against a cause the block already names.
  if (errorAnalysis?.permanent) {
    return {
      status: 'blocked',
      investigationAnalysis: null,
      metadataUpdates: {
        failureCount: (Number(task.metadata?.failureCount) || 0) + 1,
        lastErrorCategory: errorAnalysis.category || 'unknown',
        blockedReason: errorAnalysis.message || 'The run failed permanently and will not be retried',
        blockedCategory: errorAnalysis.category || 'permanent-failure'
      }
    };
  }

  // Actionable errors get blocked immediately. The investigation task (created
  // by the wrapper unless the failure is an API-access error) gets the original
  // analysis verbatim.
  if (errorAnalysis?.actionable) {
    return {
      status: 'blocked',
      investigationAnalysis: errorAnalysis,
      metadataUpdates: {
        blockedReason: errorAnalysis.message,
        blockedCategory: errorAnalysis.category
      }
    };
  }

  // Non-actionable errors: track retry count and block once the task has either
  // failed too many times in a row or spawned too many agents in total.
  const failureCount = (Number(task.metadata?.failureCount) || 0) + 1;
  const totalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  const lastErrorCategory = errorAnalysis?.category || 'unknown';

  if (totalSpawns >= MAX_TOTAL_SPAWNS || failureCount >= MAX_TASK_RETRIES) {
    const blockedAnalysis = {
      ...(errorAnalysis || {}),
      message: `Task failed ${failureCount} times: ${errorAnalysis?.message || 'unknown error'}`,
      suggestedFix: `Task has failed ${failureCount} consecutive times with ${lastErrorCategory} errors. ${errorAnalysis?.suggestedFix || 'Investigate agent output logs.'}`,
      category: lastErrorCategory
    };
    return {
      status: 'blocked',
      investigationAnalysis: blockedAnalysis,
      metadataUpdates: {
        failureCount,
        lastErrorCategory,
        blockedReason: `Max retries exceeded (${failureCount}/${MAX_TASK_RETRIES}): ${lastErrorCategory}`,
        blockedCategory: lastErrorCategory
      }
    };
  }

  // Retry: propagate compaction hints for retry prompt injection.
  //
  // The retry is NOT made spawnable here (#3373). The status stays `in_progress`
  // and the task carries the retry-hold marker, because the resume pointer that
  // lets this retry adopt the branch its dead run left behind can only be resolved
  // after `cleanupAgentWorktree` decides what survived — which happens after this
  // write lands. Flipping to `pending` now would let the dequeue that
  // `agent:completed` schedules claim the retry with no pointer and start clean.
  // `releaseRetryHold` (agentWorktreeCleanup.js) does the flip to `pending`
  // together with the pointer, in one write; `handleOrphanedTask` finishes the
  // transition if this process dies in between. See lib/taskRetryHold.js.
  const compaction = errorAnalysis?.compaction || null;
  return {
    status: 'in_progress',
    investigationAnalysis: null,
    metadataUpdates: {
      failureCount,
      lastErrorCategory,
      ...retryHoldMetadata(agentId, now),
      ...(compaction && { compaction })
    }
  };
}

/**
 * Pure decision for the type-LEVEL failure ledger (#2616), distinct from the
 * per-instance retry decision above. Given a finished run's exit-code success,
 * whether the user terminated it, and the programmatic-I/O hook result (if any),
 * decide what signal to feed the per-type consecutive-failure ledger:
 *
 *   - `'skip'`    — don't touch the ledger (user-terminated run).
 *   - `'success'` — reset the type's failure counter.
 *   - `'failure'` — increment it (with `category`).
 *
 * The key case this exists for: a layered-intelligence run that exits 0 but whose
 * `.agent-done` output was unparseable (`hookResult.outcome.reason ===
 * 'unparseable-response'`) — or whose hook threw (`hookResult.threw`) — produced
 * nothing usable, so it's a FAILURE even though the exit code says success. Other
 * benign hook reasons (no-proposal, duplicate, scope-suppressed) leave the
 * exit-code verdict intact. Extracted pure so the branching is unit-tested here.
 *
 * @returns {{ record: 'skip'|'success'|'failure', category: string|null }}
 */
export function resolveTypeFailureSignal({ success, terminatedByUser = false, hookResult = null, errorCategory = null } = {}) {
  if (terminatedByUser) return { record: 'skip', category: null };

  // An already-failed run keeps its real exit-code category; the hook override
  // only UPGRADES an exit-0 (`success`) run to a failure (the exit-0-but-
  // unparseable / thrown-hook case). A hook that throws on top of a run that
  // already failed for e.g. `rate-limit` must not relabel the cause `hook-error`.
  if (!success) return { record: 'failure', category: errorCategory || 'unknown' };

  if (hookResult?.ran) {
    if (hookResult.threw) return { record: 'failure', category: 'hook-error' };
    if (hookResult.outcome?.accepted === false) {
      return { record: 'failure', category: hookResult.outcome.reason || 'output-hook-rejected' };
    }
    if (hookResult.outcome?.reason === 'unparseable-response') return { record: 'failure', category: 'unparseable-response' };
  }

  return { record: 'success', category: null };
}

/**
 * Handle task status update after agent failure.
 * Tracks retry count and blocks the task after MAX_TASK_RETRIES,
 * creating an investigation task instead of retrying endlessly.
 *
 * Returns { status, metadata } to apply to the task. A retry does NOT come back
 * `pending`: it comes back `in_progress` + the retry-hold marker, and only becomes
 * spawnable once `releaseRetryHold` writes the resume pointer (#3373).
 */
export async function resolveFailedTaskUpdate(task, errorAnalysis, agentId, now = Date.now()) {
  const decision = resolveFailedTaskDecision(task, errorAnalysis, { agentId, now });
  const { failureCount, lastErrorCategory } = decision.metadataUpdates;

  // Actionable errors get blocked immediately (investigation task created unless API access is denied)
  if (errorAnalysis?.actionable) {
    emitLog('warn', `🚫 Task ${task.id} blocked: ${errorAnalysis.message} (${errorAnalysis.category})`, {
      taskId: task.id, category: errorAnalysis.category
    });
    await maybeCreateInvestigationTask(agentId, task, decision.investigationAnalysis);
    return {
      status: decision.status,
      metadata: { ...task.metadata, ...decision.metadataUpdates, blockedAt: new Date(now).toISOString() }
    };
  }

  if (decision.status === 'blocked') {
    emitLog('warn', `🚫 Task ${task.id} blocked after ${failureCount} failures (${lastErrorCategory})`, {
      taskId: task.id, failureCount, category: lastErrorCategory
    });
    // A null analysis is the permanent-failure branch's explicit "do not
    // investigate" — see resolveFailedTaskDecision. Every other blocked path
    // supplies one.
    if (decision.investigationAnalysis) await maybeCreateInvestigationTask(agentId, task, decision.investigationAnalysis);
    const at = new Date(now).toISOString();
    return {
      status: 'blocked',
      metadata: { ...task.metadata, ...decision.metadataUpdates, lastFailureAt: at, blockedAt: at }
    };
  }

  emitLog('info', `🔄 Task ${task.id} retry ${failureCount}/${MAX_TASK_RETRIES} held for cleanup (${lastErrorCategory})`, {
    taskId: task.id, failureCount, maxRetries: MAX_TASK_RETRIES, category: lastErrorCategory
  });
  return {
    status: decision.status,
    metadata: { ...task.metadata, ...decision.metadataUpdates, lastFailureAt: new Date(now).toISOString() }
  };
}
