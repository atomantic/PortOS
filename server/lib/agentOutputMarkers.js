/**
 * Status lines PortOS writes INTO an agent's output buffer.
 *
 * A TUI agent's `output.txt` is not a transcript — the live PTY stream goes to
 * `raw.txt` and the Shell tab. What lands in `output.txt` is a mix of two very
 * different things:
 *   1. lifecycle telemetry PortOS itself appends (`📟 TUI session started…`,
 *      `💡 Open the Shell tab…`, `⚠️ Paste verification failed…`), and
 *   2. the agent's own `.agent-done` summary, ingested behind
 *      `SENTINEL_COMPLETION_MARKER` when the run finalizes.
 *
 * Downstream consumers that present the agent's words to a human — most
 * importantly the generated PR description — must keep (2) and drop (1).
 *
 * Every lifecycle line is declared ONCE, in `LIFECYCLE_LINES` below: the emitter
 * (`services/agentTuiSpawning.js` and its `agentTuiSpawning/` modules) writes
 * `LIFECYCLE_LINES.<id>(values)`, and the reader's pattern is derived from that
 * same template. There is no second list to keep in sync — the hand-kept regex
 * list this replaced was written against nine messages and silently missed every
 * one added after it (merge-gate, stall, OOM and permission nudges, host restart,
 * provider-signal holds), so those leaked into PR bodies again.
 * `agentOutputMarkers.test.js` fails on a literal `appendLine('…')` in an
 * emitter, so a new line can only be added here.
 */

import { escapeRegExp } from './textUtils.js';

/** Line `ingestDoneSentinel` appends immediately before the sentinel summary. */
export const SENTINEL_COMPLETION_MARKER = '✅ Agent signaled completion';

// Fill a template's named slots. A missing value renders empty rather than
// throwing: these run inside PTY/timer callbacks, where a throw is a crash.
const formatter = (strings, keys) => (values = {}) => strings.reduce(
  (line, text, i) => line + text + (i < keys.length ? String(values[keys[i]] ?? '') : ''),
  '',
);

/**
 * Declare a lifecycle line as a tagged template whose interpolations NAME its
 * per-run values: lifecycleLine`📟 TUI session started: ${'session'} (${'commandLine'})`.
 *
 * The reader matches on ALL of the template's fixed text, in order — the
 * message's actual shape, deliberately NOT "any line starting with an emoji."
 * The agent's own summary is markdown, but nothing stops it from writing a
 * checklist line like `✅ Tests passed` or `⚠️ Known limitation: …` with no
 * leading `-`. A bare emoji-prefix test would classify those as telemetry and
 * silently delete them from the PR description — and a summary made mostly of
 * such lines could shrink under `extractAgentSummary`'s minimum length and fall
 * all the way back to commit messages. So a template with too little fixed text
 * to tell it apart from an agent's line is refused at load.
 */
function lifecycleLine(strings, ...keys) {
  const fixedText = strings.join('');
  if ((fixedText.match(/\p{L}/gu) || []).length < 8) {
    throw new Error(`Lifecycle line "${fixedText}" has too little fixed text to anchor on — declare it with emitOnlyLine`);
  }
  const format = formatter(strings, keys);
  format.pattern = new RegExp(`^\\s*${strings.map(escapeRegExp).join('.*?')}`, 'u');
  return Object.freeze(format);
}

/**
 * A line whose text is entirely caller-supplied, so there is nothing fixed to
 * anchor on: the reader leaves it alone rather than risk eating an agent's own
 * `❌ …` line. Reserved for failures that finalize the run unsuccessfully,
 * which never opens a PR.
 */
function emitOnlyLine(strings, ...keys) {
  const format = formatter(strings, keys);
  format.pattern = null;
  return Object.freeze(format);
}

/**
 * Every status line PortOS writes into a TUI agent's output buffer, keyed by
 * what it reports. Each entry is `(values) => line`, with `.pattern` the
 * anchor the readers strip it by.
 */
export const LIFECYCLE_LINES = Object.freeze({
  // Session start (services/agentTuiSpawning.js)
  sessionStarted: lifecycleLine`📟 TUI session started: ${'session'} (${'commandLine'})`,
  shellTabHint: lifecycleLine`💡 Open the Shell tab for live TUI output — this panel only logs lifecycle events.`,
  spawnAdopted: lifecycleLine`🔁 Spawn acknowledgement lost (${'reason'}) — re-attached to the live runner PTY`,
  startFailed: lifecycleLine`❌ Failed to start ${'provider'} TUI: ${'message'}`,
  ollamaContextApplied: lifecycleLine`🪟 Reloaded Ollama at a ${'contextLength'}-token context window`,
  // Ollama context warnings (lib/ollamaContext.js, services/ollamaAgentContext.js)
  ollamaContextTooSmall: lifecycleLine`⚠️ ${'who'} is running on an Ollama window of ${'runtime'} — below the ${'minimum'} an agent harness usually needs. Set "Local num_ctx" in AI Providers to reload Ollama at a larger window (VRAM permitting), or the run will fail partway through.`,
  ollamaReloadFailed: lifecycleLine`⚠️ Could not reload Ollama at a ${'contextLength'}-token window (${'error'}) — ${'who'} continues on the current window.`,
  // Prompt delivery (services/agentTuiSpawning/sessionController.js)
  promptPasted: lifecycleLine`📟 Prompt pasted into TUI session ${'session'} (${'reason'})${'attemptSuffix'}`,
  pasteRetrying: lifecycleLine`⚠️ Paste verification failed — prompt text not found in buffer, retrying in ${'delayMs'}ms${'bootNote'}`,
  pasteNeverLandedMcpBoot: lifecycleLine`❌ Paste never landed after ${'seconds'}s of waiting for MCP servers to boot — prompt never rendered`,
  pasteNeverRendered: lifecycleLine`❌ Paste verification failed after ${'attempts'} attempts — prompt never rendered`,
  startupDialogAnswered: lifecycleLine`📟 ${'message'} for session ${'session'}`,
  handshakeResubmitted: lifecycleLine`🔁 Provider handshake still open — re-submitted the prompt (attempt ${'attempt'})`,
  // Provider signals
  providerFallbackSignal: lifecycleLine`⚡ Provider fallback signal: ${'message'}`,
  providerSignalHolding: lifecycleLine`⏳ Provider signal (self-clearing): ${'message'} — holding the session up to ${'seconds'}s for it to clear`,
  providerSignalCleared: lifecycleLine`✅ Provider signal cleared — ${'command'} is generating again; continuing the run`,
  claudeSessionLimit: lifecycleLine`⏳ Claude Code session limit reached — sent /low-priority from the provider opt-in`,
  claudeLowPriorityResubmitted: lifecycleLine`🔁 Re-submitted the task after enabling Claude low-priority mode`,
  permissionDeclined: lifecycleLine`🚫 Declined ${'command'} permission prompt for ${'toolCall'} — an unattended run never widens its scope (${'count'}/${'max'})`,
  // Continuation nudges
  agyResumedNudged: lifecycleLine`🔁 agy resumed its conversation — nudged it to continue`,
  agyRelaunched: lifecycleLine`🔁 agy exited to the shell — relaunched it on conversation ${'conversation'} (attempt ${'attempt'}/${'max'})`,
  permissionDeclineNudged: lifecycleLine`🔁 Nudged the session to continue after declined permission prompt ${'declined'}`,
  localOomPending: lifecycleLine`⏳ Local runtime out of GPU memory — will nudge the session to continue if it goes quiet`,
  localOomNudged: lifecycleLine`🔁 Local runtime OOM — nudged the session to continue (attempt ${'attempt'}/${'max'})`,
  truncationPending: lifecycleLine`⏳ Response was truncated before completion — will nudge the session to continue if it goes quiet`,
  truncationNudged: lifecycleLine`🔁 Response was truncated before completion — nudged the session to continue (attempt ${'attempt'}/${'max'})`,
  stallNudged: lifecycleLine`🔁 Session idle with the task unfinished — nudged it to continue (attempt ${'attempt'}/${'max'}, ${'sent'}/${'total'} this run)`,
  stallGaveUp: lifecycleLine`🛑 Session still idle after ${'nudges'} nudges — it is not finishing; open the Shell tab to take it over`,
  // Completion and interruption
  mergeGateReprompted: lifecycleLine`🔁 Merge Gate not finished (PR still OPEN, no blocker stated) — re-prompted the session (1 nudge only)`,
  hostRestarted: lifecycleLine`🛑 PortOS restarted while this agent was running — the run was interrupted, not completed. Its worktree is preserved and the task will resume.`,
  failure: emitOnlyLine`❌ ${'summary'}`,
});

// Lines an older PortOS wrote and this one no longer does. A buffer from such a
// run can still be read after an upgrade, so its telemetry keeps being stripped.
const RETIRED_LIFECYCLE_LINE_PATTERNS = [
  /^\s*⏳ Max runtime reached — /u, // the max-runtime stop, removed in 2c594832a
];

const LIFECYCLE_LINE_PATTERNS = [
  ...Object.values(LIFECYCLE_LINES).map(line => line.pattern).filter(Boolean),
  ...RETIRED_LIFECYCLE_LINE_PATTERNS,
];

/**
 * Is this line PortOS lifecycle telemetry rather than something the agent said?
 * @param {string} line
 * @returns {boolean}
 */
export function isAgentLifecycleLine(line) {
  return LIFECYCLE_LINE_PATTERNS.some(re => re.test(line));
}

/**
 * Drop PortOS lifecycle status lines from an array of output lines.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function stripLifecycleLines(lines) {
  return lines.filter(line => !isAgentLifecycleLine(line));
}
