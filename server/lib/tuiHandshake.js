/**
 * Shared TUI invocation + paste-handshake constants.
 *
 * Two execution paths need these: `server/lib/tuiPromptRunner.js` (one-shot
 * prompts from the central handler) and `server/services/agentTuiSpawning.js`
 * (long-running CoS agents). Both shell into the same set of TUI binaries
 * (Claude Code, Codex, Gemini) and use identical PTY-paste choreography to
 * deliver the prompt — banner repaint wait, bracketed-paste, Enter handshake.
 * Without this shared module they had verbatim copies that would silently
 * drift the first time anyone tweaked one side's paste timing.
 *
 * No cycle risk: this module imports nothing from either consumer.
 */

import { resolveCliModel, hasModelFlag } from './providerModels.js';

// ─── Paste handshake constants ────────────────────────────────────────────

// PTY readiness — wait for the TUI banner to finish repainting (output-idle
// for READY_IDLE_THRESHOLD_MS) before pasting. A fixed delay loses to slow
// banners and burns time on fast ones; idle-detect adapts.
export const READY_POLL_INTERVAL_MS = 300;
export const READY_IDLE_THRESHOLD_MS = 1200;
export const PASTE_DEADLINE_MS = 10000;

// Claude Code emits `[Pasted text #N +M lines]` after committing a paste.
// Watch for the marker (or fall back after PASTE_TO_ENTER_FALLBACK_MS)
// before sending `\r` so Enter doesn't get swallowed mid-paste-commit.
export const PASTE_MARKER_POLL_MS = 150;
export const PASTE_MARKER_PATTERN = /\[Pasted text #\d+/;
export const PASTE_TO_ENTER_MIN_DELAY_MS = 200;
export const PASTE_TO_ENTER_FALLBACK_MS = 3500;

// Defaults the consumer applies when the provider config doesn't pin
// per-provider values (provider.tuiPromptDelayMs / .tuiIdleTimeoutMs).
export const DEFAULT_TUI_PROMPT_DELAY_MS = 2500;
export const DEFAULT_TUI_IDLE_TIMEOUT_MS = 180000;

// ─── Buffer caps (defensive, not load-bearing) ────────────────────────────

export const RAW_BUFFER_CAP = 512 * 1024;
export const RAW_BUFFER_HEADROOM = 640 * 1024;
export const OUTPUT_BUFFER_CAP = 1024 * 1024;
export const OUTPUT_BUFFER_HEADROOM = 1280 * 1024;

// ─── Command + args helpers ───────────────────────────────────────────────

export function inferTuiCommand(id) {
  if (!id) return 'claude';
  if (id.includes('codex')) return 'codex';
  if (id.includes('gemini')) return 'gemini';
  return 'claude';
}

// Codex TUI blocks on every tool approval without `--ask-for-approval never`.
// No human-at-keyboard for headless calls (one-shot OR agent), so inject it.
export function applyCommandDefaults(command, args) {
  if (command === 'codex' && !args.includes('--ask-for-approval')) {
    return ['--ask-for-approval', 'never', ...args];
  }
  return args;
}

/**
 * Build the spawn args for a TUI invocation. When `provider.args` already
 * has a `--model X` (or `-m X`) pin, the args-baked flag wins and we skip
 * the per-call --model append — otherwise the CLI would see two flags and
 * either error or take the last one (provider-specific). Matches the same
 * gate `runner.js#buildCliArgs` uses for CLI providers.
 */
export function buildTuiInvocation(provider, model) {
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])]);
  const effectiveModel = resolveCliModel(model);
  const shouldInject = effectiveModel && !hasModelFlag(baseArgs);
  const args = shouldInject ? [...baseArgs, '--model', effectiveModel] : baseArgs;
  return { command, args };
}

/**
 * Returns true when the stripped chunk looks like a `command not found`
 * error for our spawned TUI binary. Used as an early-fail probe so a typo'd
 * provider.command surfaces in seconds instead of after the idle timeout.
 */
export function detectMissingTuiBinary(strippedText, commandName) {
  const lower = strippedText.toLowerCase();
  return lower.includes('command not found') && lower.includes(commandName.toLowerCase());
}
