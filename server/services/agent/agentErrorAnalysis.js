import { createContentRefusalDetector } from '../../lib/aiToolkit/errorDetection.js';
import { classifyCodexTurnError } from '../../lib/codexTurn.js';
import { PR_COMPLETIONS, resolvePrCompletion } from '../../lib/prDisposition.js';
import { isPrivateSecurityTask } from '../../lib/privateSecurityPolicy.js';
/**
 * Agent Error Analysis
 *
 * Pattern-based failure analysis, investigation task creation, and
 * failed-task status resolution for CoS agents.
 */

import { emitLog } from '../cos/cosEvents.js';
import { addTask, updateTask } from '../cos/cosTaskStore.js';
import { MAX_TOTAL_SPAWNS } from '../../lib/cos/cosTaskMetadata.js';
import { stripAnsi } from '../../lib/ansiStrip.js';
import { retryHoldMetadata } from '../../lib/taskRetryHold.js';
import { TUI_TOOL_PERMISSION_PROMPT_PATTERN } from '../../lib/tuiHandshake.js';
import {
  INVESTIGATION_CIRCUIT_MAX_CREATIONS,
  INVESTIGATION_HEADLINE_PREFIX,
  INVESTIGATION_TASK_DELIVERY,
  SUPERVISED_INVESTIGATION_DELIVERY,
  LOOP_REASON_PROSE,
  MAX_AUTO_RETRIES_PER_TASK,
  buildInvestigationFingerprint,
  isInvestigationTask,
  resolveInvestigationApproval,
} from '../../lib/investigationTasks.js';
import { investigationCircuitOpen, noteInvestigationFiled, readAllTasksFlat, recentInvestigationCreations } from '../investigationTaskProducer.js';
import { PRIMARY_CHECKOUT_MUTATED_CATEGORY, PRIMARY_CHECKOUT_MUTATED_ESCALATION, PRIMARY_CHECKOUT_MUTATED_REASON } from '../../lib/primaryCheckoutGuard.js';
import { getConfig } from '../cos/cosState.js';

import { ERROR_PATTERNS, redactFailureSnippet } from '../../lib/agent/agentErrorPatterns.js';

export { ERROR_PATTERNS, redactFailureSnippet };

// Max retries before blocking a task
export const MAX_TASK_RETRIES = 3;

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

/** Remove complete supplied prompt echoes, including terminal line wrapping. */
function excludeSuppliedPrompt(output, prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return output;
  const compactPrompt = stripAnsi(prompt).replace(/\s/g, '');
  const compactOutput = output.replace(/\s/g, '');
  if (!compactPrompt) return output;
  const ranges = [];
  let from = 0;
  let found;
  while ((found = compactOutput.indexOf(compactPrompt, from)) !== -1) {
    ranges.push([found, found + compactPrompt.length]);
    from = found + compactPrompt.length;
  }
  if (!ranges.length) return output;
  let index = 0;
  let range = 0;
  return [...output].filter(char => {
    while (range < ranges.length && index >= ranges[range][1]) range++;
    const excluded = range < ranges.length && index >= ranges[range][0];
    if (!/\s/.test(char)) index += char.length;
    return !excluded;
  }).join('');
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
 * see `server/services/agent/agentTuiSpawning.js`. Categories are deliberately reused
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
    suggestedFix: 'PortOS wrote the bracketed paste but could not confirm it in the composer, so no Enter was sent. Check the raw transcript for an unfinished paste, a stalled initialization, or an unanswered startup dialog. On Windows, Codex can take over a minute to render a large prompt and may show it as several paste chips.'
  },
  // The TUI spawner's verdict for a prompt that was submitted but never started
  // a turn (createPromptSubmissionGate): bare Enters and every stall nudge went
  // unanswered. Retryable — a fresh session usually takes the same prompt.
  'prompt-not-submitted': {
    category: 'startup-failure',
    actionable: false,
    message: 'Prompt was delivered but the TUI never started working on it',
    suggestedFix: 'The paste rendered and Enter was sent, but the session stayed idle through every bare Enter and stall nudge, so the run was failed and the task requeued. If it recurs, check the tail of the raw transcript: a composer still holding a pasted-text chip means the TUI ignored the submit key, and a dialog or banner there means it needs a dismissal branch.'
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
  // The runner's PTY layer itself cannot fork — proven, not guessed: the runner
  // re-launched a known-good command in a known-good directory and that failed
  // too, so nothing about the requested command or workspace is at fault.
  //
  // Deliberately ACTIONABLE, unlike its `spawn-rejected` sibling below: this
  // reproduces on every attempt for every task, so blocking once with the repair
  // beats letting each task type burn MAX_TASK_RETRIES and file a
  // meta-investigation that fails the same way. Named after the observed outage —
  // an `npm ci` run inside a CoS worktree emptied the primary checkout's
  // `server/node_modules` through a symlink, deleting the `spawn-helper` binary
  // node-pty execs on every fork, while the already-loaded binding left the
  // runner process itself looking perfectly healthy.
  'runner-pty-unavailable': {
    category: 'spawn-error',
    actionable: true,
    escalation: 'Repair the runner host, then approve the retry: run `node scripts/ensure-deps.js` in the PRIMARY checkout and `node ./server/node_modules/pm2/bin/pm2 restart portos-cos`. Every agent spawn fails until this is fixed, so expect other tasks to be blocked on it too.',
    message: 'The runner could not open a PTY',
    suggestedFix: 'No agent process was created and no retry can change that: node-pty could not fork even a known-good command, so the PTY layer is unusable for every task. The usual cause is an emptied or partially installed `server/node_modules` — node-pty execs its `spawn-helper` binary from disk on every spawn, and an `npm ci` run inside a CoS worktree deletes it through the symlinked `node_modules`. Run `node scripts/ensure-deps.js` in the primary checkout (plain `npm install` leaves node-pty unbuilt under `ignore-scripts=true`) and restart the runner.'
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
const STARTUP_GATE_REFINABLE_REASONS = new Set(['paste-not-rendered', 'tui-not-ready', 'prompt-not-submitted']);

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

function structuredPolicyRefusal(output, analysisOutput) {
  const chromeRefusal = createContentRefusalDetector()(output);
  if (chromeRefusal) return chromeRefusal;
  // A quoted error string or source-code pattern is not a provider verdict.
  // Only inspect the error slot of a complete terminal protocol envelope.
  for (const line of analysisOutput.split('\n')) {
    if (!line.trimStart().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const error = event.type === 'event_msg' && event.payload?.type === 'task_complete'
      ? event.payload.error
      : event.type === 'turn.failed' ? event.error
        : event.method === 'turn/completed' ? event.params?.turn?.error : null;
    if (!error) continue;
    const refusal = classifyCodexTurnError(error);
    if (refusal.category === 'content-refusal') return { ...refusal, permanent: true,
      actionable: false, requiresFallback: false, origin: 'provider',
      suggestedFix: 'Review the refusal. Automatic continuation, retries and provider fallback are disabled.' };
  }
  return null;
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
  const provenance = options?.promptProvenance;
  const cleanOutput = stripAnsi(output || '');
  let diagnosticOutput = provenance?.submitted === true
    ? cleanOutput : excludeSuppliedPrompt(cleanOutput, provenance?.suppliedPrompt);
  // Sending Enter is an attempt, not proof of acceptance: Codex can still
  // exit with an unsent composer. After submission, exclude that footer only
  // when its entire body matches the supplied prompt, never a quoted phrase.
  if (completionReason === 'shell-exit') {
    diagnosticOutput = diagnosticOutput.replace(/(?:^|[\r\n])Unsent draft:[ \t]*(?:[\r\n]([\s\S]*)|$)/, (footer, draft = '') => {
      if (provenance?.submitted !== true) return '';
      const prompt = provenance?.suppliedPrompt;
      return typeof prompt === 'string' && draft.replace(/\s/g, '') === stripAnsi(prompt).replace(/\s/g, '') ? '' : footer;
    });
  }
  const analysisOutput = getFailureAnalysisWindow(diagnosticOutput);
  const refusal = structuredPolicyRefusal(diagnosticOutput === cleanOutput ? output || '' : diagnosticOutput, analysisOutput);
  if (refusal) return refusal;
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
  if (!analysisOutput.trim() || (analysisOutput.trim().length < 50 && !provenance)) {
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
      ...(completionReason ? { completionReason } : {}),
      ...(options?.completionError ? { completionError: options.completionError } : {}),
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
      if ((structuralDef || provenance?.submitted === false) && origin === 'output-scan') continue;
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
        ...(options?.completionError ? { completionError: options.completionError } : {}),
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
    ...(options?.completionError ? { completionError: options.completionError } : {}),
    suggestedFix: 'Error did not match known patterns. Review the details or agent output logs.'
  };
}

// ===== Investigation-task creation guards (#2615) =====

// An investigation in any of these states means the failure cause is already
// being tracked — a repeat failure with the same fingerprint is the SAME cause,
// not new work. `completed` is the only terminal status in the task vocabulary
// (see taskParser.js TASK_STATUS_VALUES); everything else — including `challenged`,
// where a task can park for days awaiting user arbitration — stays open, so a
// fresh task is only allowed once the prior cause was actually dealt with.
const OPEN_INVESTIGATION_STATUSES = new Set(['pending', 'in_progress', 'challenged', 'blocked']);

// The rolling circuit breaker, the creation counter, and the flat backlog read
// live in `investigationTaskProducer.js` — shared with the provider / crash /
// orphan producers so "how many investigations this hour" is ONE number rather
// than one per producer. Re-exported here at the address the suites and callers
// already use.

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

export function createInvestigationTask(agentId, originalTask, errorAnalysis, options = {}) {
  const run = investigationCreateTail.then(() => doCreateInvestigationTask(agentId, originalTask, errorAnalysis, options));
  investigationCreateTail = run.catch(() => {});
  return run;
}

async function doCreateInvestigationTask(agentId, originalTask, errorAnalysis, options) {
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
      const updated = await updateTask(existing.id, {
        description: `${existing.description}\n- Also blocks task \`${originalTask.id}\` (same cause; agent \`${agentId}\`).`,
        metadata: { affectedTasks: [...affected, originalTask.id] }
      }, 'internal', ...(options.expectedSourceTask ? [{ expectedSourceTask: options.expectedSourceTask }] : []));
      if (updated?.error || updated?.statusChanged) return null;
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
  let { approvalRequired, loopReason, approvalReason } = resolveInvestigationApproval({
    fingerprint, tasks: allTasks, recentCreations: recentInvestigationCreations(now), now
  });
  // The blocked-system watcher owns durable backoff; a repeat failure must not
  // allocate another blocked task asking the user to supervise machine recovery.
  const systemRecovery = analysis.blockedSystemRecovery === true;
  if (systemRecovery && approvalRequired) return null;
  if (systemRecovery) {
    // Missing configuration never grants unattended system-repair execution.
    // Circuit and repeat-failure refusals above remain independent boundaries.
    const config = await getConfig().catch(() => null);
    if (config?.autoApproveInvestigations !== true) {
      approvalRequired = true;
      approvalReason = 'system-investigation-approval-required';
    }
  }
  let targetInstanceId;
  if (systemRecovery) {
    const { getInstanceId, UNKNOWN_INSTANCE_ID } = await import('../instanceIdentity.js');
    targetInstanceId = await getInstanceId();
    if (!targetInstanceId || targetInstanceId === UNKNOWN_INSTANCE_ID) return null;
  }

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
        `## Why this is held for you\n${LOOP_REASON_PROSE[loopReason] || 'Auto-approve investigations is disabled or unavailable on this instance. Approve this scoped investigation before it can run.'}`
      ].join('\n\n')
    : systemRecovery
      ? `## What to do\nResolve the affected work and investigate its root cause. Repair demonstrated code defects with regression tests, required PR review, CI and merge delivery; reuse an active fix rather than duplicate it. Record external permission or transient causes accurately without inventing a code defect. Preserve original work, approvals and retry/spawn budgets. Do not requeue or mark the original task complete by hand.\n\n${remedy}`
      : `## What to do\nNo approval needed — this investigation runs unattended. Diagnose the failure above, apply the fix, and leave the task's findings in your summary. Do NOT un-block the original task by hand; completing this one does it.\n\n${remedy}`;

  // Completing this task revives every blocked task in `affectedTasks`
  // automatically (investigationRetry.js), so nobody has to go find them.
  const unblocks = systemRecovery
    ? `This investigation does not refund or reset task \`${originalTask.id}\` budgets. Its existing delivery verifier may settle proven completion; unfinished work remains stopped under its existing limits. Report the actual remaining work or user-owned decision.`
    : `${approvalRequired ? 'Approving and applying' : 'Applying'} the fix and completing this task automatically retries the original task \`${originalTask.id}\`; it will resume: ${originalDesc}. If the same cause blocks it again after ${MAX_AUTO_RETRIES_PER_TASK} automatic retries, it stays blocked for you.`;

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
    ...(systemRecovery ? SUPERVISED_INVESTIGATION_DELIVERY : INVESTIGATION_TASK_DELIVERY),
    ...(systemRecovery && { targetInstanceId, metadata: { preserveOriginalBudget: true, blockedSystemRecovery: true } }),
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
  }, 'internal', ...(options.expectedSourceTask ? [{ expectedSourceTask: options.expectedSourceTask }] : []));

  if (investigationTask?.error || !investigationTask?.id) return null;

  // Count only genuine creations against the circuit — addTask's own
  // description-level dedup returning an existing task is not a new creation.
  if (!investigationTask.duplicate) noteInvestigationFiled(now);

  emitLog('info', `Created investigation task ${investigationTask.id} for failed agent ${agentId} — ${approvalRequired ? `held for approval (${loopReason || approvalReason})` : 'auto-approved'}`, {
    agentId,
    taskId: investigationTask.id,
    errorCategory: category,
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
  // The original cleanup receipt and bounded review task already own this
  // failure. Investigation would allocate another task and fresh spawn budget.
  if (task?.metadata?.recoveryOrigin?.subsystem === 'repository-cleanup') {
    emitLog('info', 'Cleanup recovery failure retained by its existing owner', { agentId, taskId: task.id, category: analysis?.category });
    return;
  }
  if (resolvePrCompletion(task?.metadata) === PR_COMPLETIONS.LEAVE_OPEN) {
    emitLog('warn', `Review-only task ${task.id} needs attention; automatic investigation suppressed`, { agentId, taskId: task.id });
    return;
  }
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
  if (errorAnalysis?.permanent || ['content-refusal', 'content-filtered'].includes(errorAnalysis?.category)) {
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
      suggestedFix: `The task has failed ${failureCount} times. The latest failure was classified as ${lastErrorCategory}. ${errorAnalysis?.suggestedFix || 'Investigate agent output logs.'}`,
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

/** An unfinished deliverable is recoverable work, not a permanent process failure.
 * Reuse the existing bounded retry/cleanup fence, without spawning investigations
 * about an agent's prose. Cleanup-only handoffs are settled by repository proofs.
 */
export function resolveUndeliveredTaskUpdate(task, outcome, agentId, now = Date.now()) {
  const approval = outcome.recovery?.mode === 'approval';
  const decision = resolveFailedTaskDecision(task, { category: `task-${outcome.status}`, message: outcome.reason }, { agentId, now });
  if (!approval && outcome.recovery?.mode === 'cleanup') {
    return { status: 'in_progress', metadata: { ...task.metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: agentId, deliveryDecisionAgentId: agentId, taskOutcome: outcome } };
  }
  if (!approval && decision.status !== 'blocked') return { status: decision.status,
    metadata: { ...task.metadata, ...decision.metadataUpdates, deliveryDecisionAgentId: agentId, blockedReason: undefined, blockedCategory: undefined, blockedAt: undefined, deliveryRecovery: undefined, deliveryRecoveryAgentId: undefined, taskOutcome: outcome } };
  const options = approval ? outcome.recovery.options : [
    'Fix the reported cause and retry the retained work with a fresh retry budget.',
    'Keep the task stopped and preserve its work; do not spend more agent runs.',
  ];
  return { status: 'blocked', metadata: { ...task.metadata, ...decision.metadataUpdates,
    taskOutcome: outcome, deliveryDecisionAgentId: agentId, blockedCategory: approval ? 'task-approval' : 'task-recovery-exhausted',
    blockedAt: new Date(now).toISOString(),
    blockedReason: `${outcome.reason}\n${approval ? 'Approval required before proceeding.' : 'Automatic recovery stopped at the retry/spawn safety limit.'}\nOptions:\n${options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`,
  } };
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
  if (isPrivateSecurityTask(task)) {
    return { status: 'blocked', metadata: { ...task.metadata, blockedAt: new Date(now).toISOString(),
      blockedCategory: 'private-security-assessment-failed',
      blockedReason: 'Private assessment did not produce a validated report. Inspect its local output and configuration; no automatic investigation or provider fallback will run.' } };
  }

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
