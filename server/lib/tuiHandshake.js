/** Build TUI invocations and expose the shared handshake contract used by PTY runners. */
import { inferTuiCommand, applyCommandDefaults, injectTuiModelAndEffort } from './provider/providerVendors.js';

// Defaults the consumer applies when the provider config doesn't pin per-provider prompt timing
// values (provider.tuiPromptDelayMs).
export const DEFAULT_TUI_PROMPT_DELAY_MS = 2500;

export const POST_PASTE_BUFFER_CAP = 64 * 1024;
export const OUTPUT_BUFFER_CAP = 8 * 1024 * 1024;
export const OUTPUT_BUFFER_HEADROOM = 10 * 1024 * 1024;
// Disk safety valve for the agent-mode raw.txt spool. Counted as UTF-8 bytes actually written.
export const RAW_SPOOL_MAX_BYTES = 256 * 1024 * 1024;

/**
 * The launch command a TUI provider gets when it names none — the spawners'
 * blank-`provider.command` fallback (`buildTuiSpawnConfig`, and mirrored by
 * `buildCliSpawnConfig`'s default branch). An unrecognized id resolves to `claude`, matching
 * `isClaudeCommand`'s blank-is-Claude policy.
 * @param {string|null|undefined} id - provider id
 * @returns {string}
 */
export { inferTuiCommand };

/** TUI posture-flag dispatch (approval/trust bypass per vendor). */
export { applyCommandDefaults };

/**
 * Build the spawn args for a TUI invocation. When `provider.args` already has a `--model X` (or
 * `-m X`) pin, the args-baked flag wins and we skip the per-call --model append — otherwise the
 * CLI would see two flags and either error or take the last one (provider-specific).
 */
export function buildTuiInvocation(provider, model) {
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])], provider);
  const effort = provider?.effort || null;
  return {
    command,
    args: injectTuiModelAndEffort(command, baseArgs, provider, model, effort),
  };
}

/**
 * Returns true when the stripped chunk looks like a `command not found` error for our spawned TUI
 * binary. Used as an early-fail probe so a typo'd provider.command surfaces in seconds instead of
 * after a completion timeout.
 */
export function detectMissingTuiBinary(strippedText, commandName) {
  const lower = strippedText.toLowerCase();
  return lower.includes('command not found') && lower.includes(commandName.toLowerCase());
}

export {
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  PASTE_DEADLINE_MS,
  TUI_INPUT_READY_DEADLINE_MS,
  CODEX_COMPOSER_READY_PATTERN,
  AGY_INPUT_READY_PATTERN,
  OPENCODE_INPUT_READY_PATTERN,
  shapeHasLoginShell,
  createInputReadyTracker,
  describeTrustGateFailure,
  createStartupDialogAnswers,
  answerStartupDialogs,
} from './tuiReadyTracker.js';

export {
  PASTE_MARKER_POLL_MS,
  PASTE_VERIFY_POLL_MS,
  PASTE_VERIFY_WINDOW_MS,
  PASTE_RETRY_MAX_ATTEMPTS,
  PASTE_RETRY_BASE_DELAY_MS,
  PASTE_RETRY_MIN_WINDOW_MS,
  PASTE_RETRY_WINDOW_DELAY_MS,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  PASTE_COMMIT_PATIENCE_MS,
  extractVerifiablePromptPrefix,
  countPasteMarkers,
  isPasteConfirmed,
  isPasteCommitted,
  SUBMIT_KEY,
  scheduleSubmitEnters,
  MCP_BOOT_PASTE_DEADLINE_MS,
  MCP_BOOT_PASTE_RETRY_DELAY_MS,
  createMcpBootTracker,
  UNSUBMITTED_PROMPT_ENTER_MAX_ATTEMPTS,
  createPromptSubmissionGate,
} from './tuiPromptSubmission.js';

export {
  CLAUDE_LOW_PRIORITY_RESUBMIT_DELAY_MS,
  screenShowsInFlightChrome,
  SELF_CLEARING_RESUBMIT_POLL_MS,
  createSelfClearingSignalGate,
  OOM_NUDGE_MAX_ATTEMPTS,
  OOM_NUDGE_TEXT,
  createOomNudgeGate,
  TRUNCATION_NUDGE_MAX_ATTEMPTS,
  TRUNCATION_NUDGE_TEXT,
  createTruncationNudgeGate,
  CAPACITY_NUDGE_MAX_ATTEMPTS,
  CAPACITY_NUDGE_TEXT,
  createModelCapacityNudgeGate,
  createRetryStallGate,
  TUI_TOOL_PERMISSION_PROMPT_PATTERN,
  TOOL_PERMISSION_DECLINE_MAX,
  TOOL_PERMISSION_NUDGE_TEXT,
  createToolPermissionGate,
  STALL_NUDGE_MAX_ATTEMPTS,
  STALL_NUDGE_MAX_TOTAL,
  STALL_NUDGE_TEXT,
  createStallNudgeGate,
  AGY_RESUME_MAX_ATTEMPTS,
  createAgyResumeGate,
} from './tuiSignalGates.js';
