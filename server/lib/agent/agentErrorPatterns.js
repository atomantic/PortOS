/**
 * Ordered CoS failure signatures and their pure diagnostic extractors.
 */

import { RATE_LIMIT_SIGNATURE, USAGE_LIMIT_BANNER_SIGNATURE, USAGE_LIMIT_SIGNATURE } from '../aiToolkit/errorDetection.js';
import { redactOutput } from '../commandSecurity.js';
import { scrubSecretTokens } from '../secretText.js';
import { redactPii } from '../piiRedactionPatterns.js';
import { describeOllamaContextOverflow, parseOllamaContextOverflow } from '../ollamaContext.js';
import { isPortosSuppliedConfigKey } from '../provider/providerModels.js';

// Longest redacted failure snippet folded into a human-facing investigation body.
const SNIPPET_MAX_CHARS = 240;

// Longest accepted-values list echoed back in a `cli-config-invalid` fix. Codex
// enumerates every variant it accepts ("expected one of `minimal`, `low`, …"),
// which is useful at a glance and unreadable at full length.
const CONFIG_EXPECTED_MAX_CHARS = 120;

/**
 * Redact machine identity, network info, PII, and secrets from free text before
 * it is embedded in an investigation-task body. Also normalizes whitespace and
 * caps length so a captured multi-line snippet stays a single readable line.
 * Pure — safe to unit-test directly.
 *
 * The machine-identity / PII patterns (home/Windows paths, IPv4/IPv6, MAC,
 * `.ts.net`/`.local` hosts, email, phone, GPS) live in the shared
 * `lib/piiRedactionPatterns.js` table so a fix reaches `agentContextMcp.js`
 * and `federationSafety.js` too (#7474), rather than drifting here alone.
 * Credential-shaped values (bearer headers, `sk-`/`ghp_`/JWT-style tokens)
 * go through `scrubSecretTokens`, the same leaf `federationSafety.js` uses.
 */
export function redactFailureSnippet(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  let out = redactOutput(text); // JSON secret key/value pairs
  out = scrubSecretTokens(out); // credential-shaped values pasted into free text
  out = redactPii(out);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > SNIPPET_MAX_CHARS ? `${out.slice(0, SNIPPET_MAX_CHARS)}…` : out;
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
  // (see `extract`): PortOS injects startup/effort keys and optional execution-speed keys via `-c`, so
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
      // A rejection alone cannot identify the source of conditional speed overrides.
      const source = !key
        ? `Look first in the CLI's own config file — for codex that is \`~/.codex/config.toml\` — then in the \`-c <key>=<value>\` overrides PortOS builds in server/lib/provider/providerModels.js.`
        : ['service_tier', 'features.fast_mode'].includes(key)
          ? `${keyRef} can come from an explicit PortOS execution-speed selection or the CLI configuration. Clear an unsupported speed selection or upgrade Codex; if no speed was selected, inspect provider args and \`~/.codex/config.toml\`. The rejection alone does not prove which source supplied it.`
        : isPortosSuppliedConfigKey(key)
          ? `PortOS supplies ${keyRef} itself as a \`-c <key>=<value>\` override, so the accepted values belong in that provider's ladder in server/lib/provider/providerModels.js — editing the CLI config file will not help.`
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
    // The flag name is echoed because it is PortOS-authored
    // argv, never user data.
    pattern: /(?:^|\n|\bError:\s*)(--[a-z0-9][a-z0-9-]*)\s+(?:can only be used with\s+([^\n]{1,80})|is (?:not a known|an unknown|not a valid)[^\n]{0,60})/i,
    category: 'cli-config-invalid',
    actionable: true,
    origin: 'runner', // fully structured — the CLI's own argv rejection
    escalation: 'Correct the flag set PortOS builds for this provider/posture in server/lib/provider/providerVendors.js, then approve the retry.',
    extract: (match) => {
      const flag = match[1];
      const requires = redactFailureSnippet(match[2] || '').replace(/[.,;]+$/, '').slice(0, CONFIG_EXPECTED_MAX_CHARS);
      return {
        message: `Provider CLI rejected the flag ${flag}`,
        suggestedFix: `The CLI exited while parsing its arguments, before the prompt was delivered, so every retry fails identically.${requires ? ` It reports that \`${flag}\` only works with ${requires}.` : ''} PortOS builds this argv itself — fix the posture/vendor recipe in server/lib/provider/providerVendors.js (an attachable \`tuiSpawnArgs\` recipe must drop every flag that requires \`--print\`), not the provider record.`,
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
    // A credential-brokering launcher (`<wrapper> run <harness> -- …`) whose
    // cached sign-in expired and could not be refreshed falls back to an
    // INTERACTIVE browser OAuth login: it paints a spinner, binds a fixed
    // loopback callback port and waits up to five minutes for a human. In an
    // unattended run nobody signs in, so the first spawn times out and every
    // concurrent spawn dies at once on `listen EADDRINUSE` for that port. Both
    // lines carry the word "authentication", but a structural completion
    // reason (shell-exit) discards that loose output-scan match, so the run
    // landed in `unknown`, burned three retries and filed an investigation for
    // what only a human sign-in fixes. Gated on the spinner chrome AND its
    // terminal failure so a transcript that merely quotes either line does not
    // bench a healthy provider. Non-actionable + provider origin: the provider
    // is benched for the auth cooldown and the retry resolves onto a fallback.
    pattern: /[⠀-⣿][^\S\n]*(?:Starting [\w .-]{1,40} authentication|Waiting for [\w .-]{1,40} login in your browser)…[\s\S]{0,4000}?(?:listen EADDRINUSE: address already in use (?:127\.0\.0\.1|localhost|\[?::1\]?):(\d+)|login timed out after \w+ minutes?)/i,
    category: 'auth-error',
    actionable: false,
    origin: 'provider',
    extract: (match) => ({
      message: match[1]
        ? `Provider launcher needs an interactive browser sign-in (callback port ${match[1]} already held by another waiting run)`
        : 'Provider launcher needs an interactive browser sign-in that no one completed',
      suggestedFix: "The provider launcher's cached credential expired and could not refresh. Sign in once interactively with the launcher's own credential command, then retry; meanwhile the provider is benched and runs use the fallback.",
      requiresFallback: true
    })
  },
  {
    // The same launcher sign-in, caught before it fails on its own: the TUI
    // spawner's 45s input-ready deadline (`tui-not-ready`) fires while the
    // launcher is still painting its "waiting for login" spinner, well inside
    // its five-minute timeout, so neither terminal line above ever reaches the
    // transcript. The generic startup-failure verdict then burned three retries
    // on the same provider and filed an investigation for a human-only fix.
    // Anchored to the END of the window: only a run that died still waiting on
    // the sign-in matches, never one that quotes the spinner and moved on.
    pattern: /[⠀-⣿][^\S\n]*Waiting for [\w .-]{1,40} login in your browser…\s*$/i,
    category: 'auth-error',
    actionable: false,
    origin: 'provider',
    extract: () => ({
      message: 'Provider launcher is waiting on an interactive browser sign-in that no one can complete',
      suggestedFix: "The provider launcher's cached credential expired and could not refresh, so it stopped at a browser login before the CLI ever started. Sign in once interactively with the launcher's own credential command, then retry; meanwhile the provider is benched and runs use the fallback.",
      requiresFallback: true
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
    pattern: RATE_LIMIT_SIGNATURE, // vendor wording lives in aiToolkit/errorDetection.js
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
    // The vendor banner wording (every `hit your <kind> limit` form, `usage limit`,
    // Upgrade to Pro, the Antigravity upgrade sentence, `Now using extra usage`)
    // is declared once, in aiToolkit/errorDetection.js. Only the agent-specific
    // output-scan alternatives below are listed here; the generic ones stay
    // unpromoted (see structuredMarker).
    pattern: new RegExp(`${USAGE_LIMIT_SIGNATURE.source}|usage.?limit|quota exceeded|plan.?limit|daily.?limit|session.?limit|\\d+-hour limit reached`, 'i'),
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
    // Marker = the shared vendor-BANNER half (not the bare `usage limit` that
    // tests and docs print) plus the reached-banners older CLIs print
    // (`usage limit reached`, `session limit reached`, `<N>-hour limit reached`). A bare
    // `hit your limit` is deliberately NOT promoted: prose reaches it.
    structuredMarker: new RegExp(`${USAGE_LIMIT_BANNER_SIGNATURE.source}|(?:usage|session) limit reached|\\d+-hour limit reached`, 'i'),
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
    // outage three times running. Word boundaries reject
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
    escalation: 'Review the safety refusal; automatic retry and provider fallback are disabled.',
    extract: () => ({
      message: 'Content filtered',
      suggestedFix: 'Request was stopped by a content safety refusal. No automatic continuation, retry or provider fallback.'
    })
  }
];
